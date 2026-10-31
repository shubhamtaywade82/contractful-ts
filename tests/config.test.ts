import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dumpModels,
  loadCodegenConfig,
  runCodegen,
} from '../src/codegen/config.js';

const TMP = resolve(fileURLToPath(new URL('./.config-tmp', import.meta.url)));

const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'RestApi', version: '1.0.0' },
  servers: [{ url: 'https://rest.test/v1' }],
  paths: {
    '/users': {
      get: {
        tags: ['users'],
        operationId: 'listUsers',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array' } } } } },
      },
    },
  },
});

const ASYNCAPI = [
  'asyncapi: 2.6.0',
  'info: { title: OrderEvents, version: 1.0.0 }',
  'servers: { prod: { url: "wss://events.test/ws", protocol: wss } }',
  'channels:',
  '  order.created:',
  '    publish:',
  '      message:',
  '        name: OrderCreated',
  '        payload:',
  '          type: object',
  '          properties: { orderId: { type: string } }',
  '          required: [orderId]',
].join('\n');

const POSTMAN = JSON.stringify({
  info: { name: 'PostmanApi', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'https://postman.test' }],
  item: [
    {
      name: 'Things',
      item: [
        { name: 'List things', request: { method: 'GET', url: { raw: '{{baseUrl}}/things', host: ['{{baseUrl}}'], path: ['things'] } } },
      ],
    },
  ],
});

const GRAPHQL = [
  'type Item { id: ID! name: String }',
  'type Query { item(id: ID!): Item }',
  'type Subscription { itemAdded: Item }',
  '',
].join('\n');

async function writeSource(name: string, content: string): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const path = join(TMP, name);
  await writeFile(path, content, 'utf8');
  return path;
}

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe('runCodegen', () => {
  it('generates namespaced clients from mixed-format sources', async () => {
    const rest = await writeSource('rest.json', OPENAPI);
    const events = await writeSource('events.yaml', ASYNCAPI);
    const postman = await writeSource('postman.json', POSTMAN);
    const graphql = await writeSource('schema.graphql', GRAPHQL);

    const bundle = await runCodegen({
      output: 'src/generated',
      sources: [
        { path: rest, namespace: 'rest' },
        { path: events, namespace: 'events' },
        { path: postman, namespace: 'postman' },
        { path: graphql, namespace: 'gql' },
      ],
    });

    expect(bundle.namespaces).toEqual(['rest', 'events', 'postman', 'gql']);
    const paths = bundle.files.map((f) => f.path);
    expect(paths).toContain('rest/users.ts');
    expect(paths).toContain('rest/index.ts');
    expect(paths).toContain('events/order-events-events.ts');
    expect(paths).toContain('postman/things.ts');
    expect(paths).toContain('gql/types.ts');
    expect(paths).toContain('gql/client.ts');
    expect(paths).toContain('gql/subscriptions.ts');
    expect(paths).toContain('index.ts');

    const rootIndex = bundle.files.find((f) => f.path === 'index.ts')!.content;
    expect(rootIndex).toContain("export * from './rest/index.js';");
    expect(rootIndex).toContain("export * from './events/index.js';");

    const eventsFile = bundle.files.find((f) => f.path === 'events/order-events-events.ts')!.content;
    expect(eventsFile).toContain('onOrderCreated: subscribe("order.created", {');
  });

  it('emits flat output for a single unnamespaced source (v0.1 compatible)', async () => {
    const rest = await writeSource('single.json', OPENAPI);
    const bundle = await runCodegen({ output: 'src/api', sources: [{ path: rest }] });
    expect(bundle.namespaces).toEqual([]);
    expect(bundle.files.map((f) => f.path)).toEqual(['users.ts', 'index.ts']);
  });

  it('defaults namespaces per format', async () => {
    const rest = await writeSource('rest2.json', OPENAPI);
    const events = await writeSource('events2.yaml', ASYNCAPI);
    const bundle = await runCodegen({
      output: 'src/generated',
      sources: [{ path: rest }, { path: events }],
    });
    expect(bundle.namespaces).toEqual(['rest', 'events']);
  });

  it('round-trips an api-model source back into code', async () => {
    const rest = await writeSource('model-src.json', OPENAPI);
    const first = await runCodegen({ output: 'x', sources: [{ path: rest }] });
    const modelJson = dumpModels(first);
    expect(modelJson).toContain('"kind": "contractful-api-model"');
    const modelPath = await writeSource('model.json', modelJson);

    const bundle = await runCodegen({ output: 'x', sources: [{ path: modelPath }] });
    const users = bundle.files.find((f) => f.path === 'users.ts')!.content;
    expect(users).toContain('listUsers: contract("GET /users", {');
  });

  it('emits standalone clients when configured', async () => {
    const rest = await writeSource('rest3.json', OPENAPI);
    const events = await writeSource('events3.yaml', ASYNCAPI);
    const bundle = await runCodegen({
      output: 'src/generated',
      emit: 'standalone',
      sources: [
        { path: rest, namespace: 'rest' },
        { path: events, namespace: 'events' },
      ],
    });

    for (const file of bundle.files) {
      expect(file.content).not.toContain("from 'contractful-ts'");
      expect(file.content).not.toContain('from "contractful-ts"');
    }
    expect(bundle.files.map((f) => f.path)).toContain('rest/_http.ts');
    expect(bundle.files.map((f) => f.path)).toContain('events/_ws.ts');
  });

  it('rejects GraphQL subscriptions in standalone mode', async () => {
    const graphql = await writeSource('schema2.graphql', GRAPHQL); // has a Subscription
    await expect(
      runCodegen({ output: 'x', emit: 'standalone', sources: [{ path: graphql, namespace: 'gql' }] }),
    ).rejects.toThrow(/Standalone emit does not support GraphQL subscriptions/);
  });

  it('forces the format with an explicit kind', async () => {
    // A GraphQL file misdetected or forced through kind: 'graphql'.
    const graphql = await writeSource('odd-name.txt', GRAPHQL);
    const bundle = await runCodegen({
      output: 'x',
      sources: [{ path: graphql, kind: 'graphql', namespace: 'gql' }],
    });
    expect(bundle.files.map((f) => f.path)).toContain('gql/client.ts');
  });

  it('fails loudly on undetectable sources', async () => {
    const mystery = await writeSource('mystery.txt', 'just some text');
    await expect(runCodegen({ output: 'x', sources: [{ path: mystery }] })).rejects.toThrow(
      /Could not detect the format/,
    );
    await expect(runCodegen({ output: 'x', sources: [] })).rejects.toThrow(/no sources/);
  });
});

describe('loadCodegenConfig', () => {
  it('loads JSON configs', async () => {
    const rest = await writeSource('cfg-rest.json', OPENAPI);
    const configPath = await writeSource(
      'codegen.json',
      JSON.stringify({ output: 'src/generated', sources: [{ path: rest, namespace: 'rest' }] }),
    );
    const config = await loadCodegenConfig(configPath);
    expect(config.output).toBe('src/generated');
    expect(config.sources).toHaveLength(1);
  });

  it('loads YAML configs', async () => {
    const rest = await writeSource('cfg-rest2.json', OPENAPI);
    const configPath = await writeSource(
      'codegen.yaml',
      ['output: src/generated', 'sources:', `  - path: ${rest}`, '    namespace: rest'].join('\n'),
    );
    const config = await loadCodegenConfig(configPath);
    expect(config.sources[0]!.namespace).toBe('rest');
  });

  it('rejects configs without a sources array', async () => {
    const bad = await writeSource('bad.json', JSON.stringify({ output: 'x' }));
    await expect(loadCodegenConfig(bad)).rejects.toThrow(/sources/);
  });
});
