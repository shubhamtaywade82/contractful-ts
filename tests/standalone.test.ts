import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildApiIR, parseSpecText } from '../src/codegen/openapi.js';
import { emitStandaloneHttp, emitStandaloneEvents } from '../src/codegen/standalone.js';
import { buildEventsIR } from '../src/codegen/asyncapi.js';
import type { OpenApiSpec } from '../src/codegen/openapi.js';
import { FakeSocket, waitFor } from './events-helpers.js';

const TMP = resolve(fileURLToPath(new URL('./.standalone-tmp', import.meta.url)));

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const PETSTORE = parseSpecText(
  JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Petstore', version: '1.0.0' },
    servers: [{ url: 'https://petstore.test/v1' }],
    paths: {
      '/pets': {
        get: {
          tags: ['pets'],
          operationId: 'listPets',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
          ],
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array' } } } },
          },
        },
        post: {
          tags: ['pets'],
          operationId: 'createPet',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
          },
          responses: { '201': { description: 'created', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/pets/{petId}': {
        get: {
          tags: ['pets'],
          operationId: 'showPetById',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
    },
  }),
);

const ORDERS = buildEventsIR({
  asyncapi: '2.6.0',
  info: { title: 'Orders', version: '1.0.0' },
  servers: { prod: { url: 'wss://orders.test/events', protocol: 'wss' } },
  channels: {
    'order.created': {
      publish: {
        message: {
          name: 'OrderCreated',
          payload: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
        },
      },
    },
    'order/{orderId}/notified': {
      parameters: { orderId: { schema: { type: 'string' } } },
      // The server subscribes to notifications → the client publishes them.
      subscribe: {
        message: {
          name: 'OrderNotified',
          payload: { type: 'object', properties: { channel: { type: 'string' } } },
        },
      },
    },
    'order.create': {
      subscribe: {
        message: {
          name: 'CreateOrder',
          payload: { type: 'object', properties: { productId: { type: 'string' } }, required: ['productId'] },
        },
      },
    },
  },
} as unknown as OpenApiSpec);

async function writeFiles(files: Array<{ path: string; content: string }>): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  for (const file of files) {
    await writeFile(join(TMP, file.path), file.content, 'utf8');
  }
  // Strict tsc check of the generated output.
  await writeFile(
    join(TMP, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['*.ts'],
    }),
    'utf8',
  );
  await writeFile(join(TMP, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  return TMP;
}

function tscCheck(dir: string): void {
  execFileSync('npx', ['tsc', '-p', join(dir, 'tsconfig.json')], {
    cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
    stdio: 'pipe',
  });
}

describe('emitStandaloneHttp', () => {
  const ir = buildApiIR(PETSTORE);
  const files = emitStandaloneHttp(ir, { specOrigin: 'petstore.json' });

  it('emits zero-dependency modules', () => {
    expect(files.map((f) => f.path).sort()).toEqual(['_http.ts', 'index.ts', 'pets.ts']);
    const pets = files.find((f) => f.path === 'pets.ts')!.content;
    expect(pets).toContain("import { request, ApiError } from './_http.js';");
    expect(pets).toContain('export interface ListPetsArgs {');
    expect(pets).toContain('limit?: number;');
    expect(pets).toContain('sort?: string;');
    expect(pets).toContain('export function createPetsApi(');
    expect(pets).toContain('async listPets(args: ListPetsArgs): Promise<unknown[]> {');
    expect(pets).toContain('async createPet(args: CreatePetArgs): Promise<Record<string, unknown>> {');
  });

  it('compiles under strict tsc and runs against an injected fetch', async () => {
    const dir = await writeFiles(files);
    expect(() => tscCheck(dir)).not.toThrow();

    const mod = await import(pathToFileURL(join(dir, 'pets.ts')).href);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      if (String(url).endsWith('/pets') && (init as RequestInit).method === 'POST') {
        return new Response(JSON.stringify({ id: 9, name: 'Flip' }), { status: 201 });
      }
      if (String(url).includes('/pets/abc')) {
        return new Response(JSON.stringify({ id: 1, name: 'Rex' }), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: 1, name: 'Rex' }]), { status: 200 });
    }) as typeof fetch;

    const api = mod.createPetsApi({ fetchImpl });

    const pets = await api.listPets({ limit: 5 });
    expect(pets).toEqual([{ id: 1, name: 'Rex' }]);
    expect(calls[0]!.url).toBe('https://petstore.test/v1/pets?limit=5');
    expect(calls[0]!.init.method).toBe('GET');

    const pet = await api.showPetById({ petId: 'abc' });
    expect(pet).toEqual({ id: 1, name: 'Rex' });
    expect(calls[calls.length - 1]!.url).toBe('https://petstore.test/v1/pets/abc');

    const created = await api.createPet({ name: 'Flip' });
    expect(created).toEqual({ id: 9, name: 'Flip' });
    expect(calls[calls.length - 1]!.init.body).toBe(JSON.stringify({ name: 'Flip' }));
  });

  it('throws ApiError with the parsed body on failure', async () => {
    const dir = await writeFiles(files);
    const mod = await import(pathToFileURL(join(dir, 'pets.ts')).href);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'nope' }), { status: 422 })) as typeof fetch;
    const api = mod.createPetsApi({ fetchImpl });
    await expect(api.listPets({})).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      body: { message: 'nope' },
    });
  });
});

describe('emitStandaloneEvents', () => {
  const files = emitStandaloneEvents(ORDERS, { specOrigin: 'orders.yaml' });

  it('emits a typed wrapper over the dependency-free mini-runtime', () => {
    expect(files.map((f) => f.path).sort()).toEqual(['_ws.ts', 'index.ts', 'orders-events.ts']);
    const events = files.find((f) => f.path === 'orders-events.ts')!.content;
    expect(events).toContain("import { createEventsConnection, type SocketLike } from './_ws.js';");
    expect(events).toContain('export interface OrderCreatedMessage {');
    expect(events).toContain('orderId: string;');
    expect(events).toContain('export function createEventsEvents(');
    expect(events).toContain("async publishCreateOrder(message: CreateOrderMessage) {");
    expect(events).toContain('await connection.publish("order.create", message);');
    expect(events).toContain("const topic = `order/${params.orderId ?? ''}/notified`;");
  });

  it('compiles under strict tsc, connects, routes and publishes', async () => {
    const dir = await writeFiles(files);
    expect(() => tscCheck(dir)).not.toThrow();

    const mod = await import(pathToFileURL(join(dir, 'orders-events.ts')).href);
    const fake = new FakeSocket('wss://orders.test/events', []);
    const events = mod.createEventsEvents({
      socketFactory: () => {
        setTimeout(() => fake.serverOpen(), 0);
        return fake;
      },
    });

    const received: unknown[] = [];
    events.onOrderCreated((message) => received.push(message));
    await events.connect();

    fake.serverMessage({ topic: 'order.created', payload: { orderId: 'o1', extra: 1 } });
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ orderId: 'o1', extra: 1 });

    await events.publishCreateOrder({ productId: 'p1' });
    expect(fake.lastSentJson()).toEqual({ topic: 'order.create', payload: { productId: 'p1' } });

    await events.publishOrderNotified({ channel: 'email' }, { orderId: 'o-9' });
    expect(fake.lastSentJson()).toEqual({ topic: 'order/o-9/notified', payload: { channel: 'email' } });

    await events.disconnect();
  });
});
