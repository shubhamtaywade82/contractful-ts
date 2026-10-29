import { afterAll, describe, expect, it } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseGraphQLSdl, GraphQLParseError } from '../src/codegen/graphql.js';
import { emitGraphqlFromSdl } from '../src/codegen/graphql-emit.js';
import { FakeSocket, waitFor } from './events-helpers.js';

const TMP = resolve(fileURLToPath(new URL('./.graphql-tmp', import.meta.url)));

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const SDL = `
"""A registered user."""
type User {
  id: ID!
  name: String!
  email: String
  role: Role!
  pets: [Pet!]!
}

type Pet {
  id: ID!
  name: String!
  owner: User
}

enum Role {
  ADMIN
  USER
}

union SearchResult = User | Pet

input CreatePetInput {
  name: String!
  tag: String
}

type Query {
  "Fetch one user."
  user(id: ID!): User
  search(term: String!, limit: Int = 10): [SearchResult!]!
}

type Mutation {
  createPet(input: CreatePetInput!): Pet!
  deletePet(id: ID!): Boolean!
}

type Subscription {
  petAdded: Pet!
  userEvent(userId: ID!): UserEvent!
}

type UserEvent {
  kind: String!
  at: String
}

# totally a custom scalar
scalar DateTime
`;

describe('parseGraphQLSdl', () => {
  const doc = parseGraphQLSdl(SDL);

  it('parses object types, fields and nullability', () => {
    const user = doc.types.get('User')!;
    expect(user.kind).toBe('type');
    expect(user.description).toBe('A registered user.');
    const email = user.fields.find((f) => f.name === 'email')!;
    expect(email.type).toEqual({ kind: 'named', name: 'String', nonNull: false });
    const id = user.fields.find((f) => f.name === 'id')!;
    expect(id.type.nonNull).toBe(true);
    const pets = user.fields.find((f) => f.name === 'pets')!;
    expect(pets.type).toEqual({
      kind: 'list',
      nonNull: true,
      of: { kind: 'named', name: 'Pet', nonNull: true },
    });
  });

  it('parses enums, unions, inputs and custom scalars', () => {
    expect(doc.enums.get('Role')).toEqual(['ADMIN', 'USER']);
    expect(doc.unions.get('SearchResult')).toEqual(['User', 'Pet']);
    expect(doc.scalars.has('DateTime')).toBe(true);
    const input = doc.types.get('CreatePetInput')!;
    expect(input.kind).toBe('input');
    expect(input.fields.find((f) => f.name === 'tag')!.type.nonNull).toBe(false);
  });

  it('parses root fields with args, defaults and descriptions', () => {
    expect(doc.queries.map((f) => f.name)).toEqual(['user', 'search']);
    const search = doc.queries.find((f) => f.name === 'search')!;
    expect(search.args).toHaveLength(2);
    expect(search.args[0]!.type.nonNull).toBe(true);
    expect(search.args[1]!.defaultValue).toBe('10');
    expect(doc.queries[0]!.description).toBe('Fetch one user.');
    expect(doc.mutations.map((f) => f.name)).toEqual(['createPet', 'deletePet']);
    expect(doc.subscriptions.map((f) => f.name)).toEqual(['petAdded', 'userEvent']);
  });

  it('rejects malformed documents with line information', () => {
    expect(() => parseGraphQLSdl('type User {')).toThrow(GraphQLParseError);
    expect(() => parseGraphQLSdl('garbage everywhere')).toThrow(GraphQLParseError);
  });

  it('supports explicit schema blocks and extend type', () => {
    const doc2 = parseGraphQLSdl(`
schema { query: RootQuery }
type RootQuery { hello: String }
type Extra { a: String }
extend type Extra { b: String }
`);
    expect(doc2.roots.query).toBe('RootQuery');
    expect(doc2.queries.map((f) => f.name)).toEqual(['hello']);
    expect(doc2.types.get('Extra')!.fields.map((f) => f.name)).toEqual(['a', 'b']);
  });
});

describe('emitGraphqlFromSdl — emitted code', () => {
  it('generates types, client, subscriptions and index', () => {
    const { files } = emitGraphqlFromSdl(SDL, { specOrigin: 'schema.graphql' });
    expect(files.map((f) => f.path)).toEqual([
      'types.ts',
      'client.ts',
      'subscriptions.ts',
      'index.ts',
    ]);

    const types = files[0]!.content;
    expect(types).toContain('export type Role =');
    expect(types).toContain('export interface User {');
    expect(types).toContain('email?: string | null;');
    expect(types).toContain('pets: Array<Pet>;');
    expect(types).toContain('export interface CreatePetInput {');

    const client = files[1]!.content;
    expect(client).toContain('async user(variables: UserVariables): Promise<UserResult | null> {');
    expect(client).toContain('export interface UserVariables {');
    expect(client).toContain('id: string;');
    expect(client).toContain('limit?: number;');
    expect(client).toContain('const DOCUMENT_User = `query User($id: ID!) {');
    expect(client).toContain('user(id: $id) {');
    expect(client).toContain('pets {');
    // Cycles are cut along the selection path: inside the User document,
    // Pet.owner (back to User) is beyond the depth budget.
    const userDocument = client.slice(
      client.indexOf('const DOCUMENT_User'),
      client.indexOf('`;', client.indexOf('const DOCUMENT_User')),
    );
    expect(userDocument).not.toContain('owner {');
    expect(client).toContain('export interface UserResult {');

    const subscriptions = files[2]!.content;
    expect(subscriptions).toContain('subscription PetAdded {');
    expect(subscriptions).toContain('petAdded {');
    expect(subscriptions).toContain('subscription UserEvent($userId: ID!) {');
    expect(subscriptions).toContain('userEvent(userId: $userId) {');
    expect(subscriptions).toContain('createGraphQLWsClient({');
  });

  it('throws when the schema has no operations', () => {
    expect(() => emitGraphqlFromSdl('type Nothing { id: ID }')).toThrow(/no Query, Mutation/);
  });
});

describe('generated GraphQL client is executable', () => {
  it('round-trips queries and mutations through a mock transport', async () => {
    const distUrl = new URL('../dist/index.js', import.meta.url).href;
    const eventsUrl = new URL('../dist/events/index.js', import.meta.url).href;
    const { files } = emitGraphqlFromSdl(SDL, {
      importFrom: distUrl,
      eventsImportFrom: eventsUrl,
      specOrigin: 'schema.graphql',
    });

    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
    for (const file of files) {
      await writeFile(join(TMP, file.path), file.content, 'utf8');
    }

    const clientMod = await import(pathToFileURL(join(TMP, 'client.ts')).href);
    const requests: Array<{ url: string; body: { query: string; variables: unknown } }> = [];
    const transport = {
      send: async (req: { url: string; body: { query: string; variables: unknown } }) => {
        requests.push(req);
        if (req.body.query.startsWith('mutation CreatePet')) {
          return { status: 200, headers: {}, body: { data: { createPet: { id: 'p9', name: 'Flip' } } } };
        }
        if (req.body.query.startsWith('mutation DeletePet')) {
          return { status: 200, headers: {}, body: { data: { deletePet: true } } };
        }
        if (req.body.query.startsWith('query Search')) {
          return {
            status: 200,
            headers: {},
            body: { data: { search: [{ __typename: 'User' }, { __typename: 'Pet' }] } },
          };
        }
        return {
          status: 200,
          headers: {},
          body: {
            data: {
              user: {
                id: 'u1',
                name: 'Ada',
                email: null,
                role: 'ADMIN',
                pets: [{ id: 'p1', name: 'Rex' }],
              },
            },
          },
        };
      },
    };
    const client = clientMod.createClient({ transport });

    const user = await client.user({ id: 'u1' });
    expect(user).toEqual({
      id: 'u1',
      name: 'Ada',
      email: null,
      role: 'ADMIN',
      pets: [{ id: 'p1', name: 'Rex' }],
    });

    // The document was generated with args, full selections and cycle cuts.
    const query = requests[0]!.body.query;
    expect(query).toContain('query User($id: ID!) {');
    expect(query).toContain('user(id: $id) {');
    expect(query).toContain('pets {');
    expect(query).not.toContain('owner {');
    expect(requests[0]!.body.variables).toEqual({ id: 'u1' });

    // Mutations with input variables.
    const pet = await client.createPet({ input: { name: 'Flip' } });
    expect(pet).toEqual({ id: 'p9', name: 'Flip' });
    expect(requests[requests.length - 1]!.body.variables).toEqual({ input: { name: 'Flip' } });

    // Unions select __typename.
    const results = await client.search({ term: 're', limit: 5 });
    expect(results).toEqual([{ __typename: 'User' }, { __typename: 'Pet' }]);

    // No-arg operations are callable without variables.
    const deleted = await client.deletePet({ id: 'p1' });
    expect(deleted).toBe(true);
  });

  it('round-trips subscriptions through a fake graphql-transport-ws socket', async () => {
    const distUrl = new URL('../dist/index.js', import.meta.url).href;
    const eventsUrl = new URL('../dist/events/index.js', import.meta.url).href;
    const { files } = emitGraphqlFromSdl(SDL, {
      importFrom: distUrl,
      eventsImportFrom: eventsUrl,
      specOrigin: 'schema.graphql',
    });
    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
    for (const file of files) {
      await writeFile(join(TMP, file.path), file.content, 'utf8');
    }

    const subsMod = await import(pathToFileURL(join(TMP, 'subscriptions.ts')).href);
    const fake = new FakeSocket('wss://example.test/graphql', ['graphql-transport-ws']);
    const subscriptions = subsMod.createSubscriptions({
      url: 'wss://example.test/graphql',
      socketFactory: () => {
        setTimeout(() => fake.serverOpen(), 0);
        setTimeout(() => fake.serverMessage({ type: 'connection_ack' }), 10);
        return fake;
      },
      connectionInitPayload: { token: 't1' },
    });

    const received: unknown[] = [];
    await subscriptions.connect();
    // connection_init handshake on the wire.
    expect(fake.sentJson()[0]).toEqual({ type: 'connection_init', payload: { token: 't1' } });
    await waitFor(() => fake.sent.length >= 1);

    subscriptions.userEvent({ userId: 'u1' }, { next: (data) => received.push(data) });
    await waitFor(() => fake.sent.some((frame) => frame.includes('subscription UserEvent')));
    expect(fake.lastSentJson().type).toBe('subscribe');

    fake.serverMessage({
      id: fake.lastSentJson().id,
      type: 'next',
      payload: { data: { userEvent: { kind: 'renamed', at: '2024-01-01T00:00:00Z' } } },
    });
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ kind: 'renamed', at: '2024-01-01T00:00:00Z' });

    await subscriptions.disconnect();
  });
});
