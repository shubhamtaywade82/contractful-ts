/**
 * Generator round-trips and determinism.
 *
 * The canonical model is the pivot for multi-format workflows (spec → model
 * → code, model → model, spec → model → spec-shaped code). These tests pin
 * the two properties that make that safe:
 *
 *  1. Emission is deterministic — same IR, same options, byte-identical
 *     files (twice in a row, and after a model serialize/parse cycle).
 *  2. The model survives serialization: parse(serialize(m)) re-emits the
 *     same code, and source hashing is stable.
 */

import { describe, expect, it } from 'vitest';
import {
  buildApiIR,
  buildEventsIR,
  emitContracts,
  emitEvents,
  hashSource,
  httpIrFromModel,
  eventsIrFromModel,
  modelFromHttpIr,
  modelFromEventsIr,
  parseModel,
  parseSpecText,
  serializeModel,
  type ApiIR,
  type EmittedFile,
} from '../src/codegen/index.js';

const SPEC_JSON = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'ShopApi', version: '2.1.0' },
  servers: [{ url: 'https://shop.test/v2' }],
  tags: [{ name: 'orders' }, { name: 'users' }],
  paths: {
    '/orders': {
      post: {
        tags: ['orders'],
        operationId: 'createOrder',
        summary: 'Creates an order',
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  sku: { type: 'string', minLength: 1 },
                  quantity: { type: 'integer', minimum: 1, default: 1 },
                },
                required: ['sku'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'created', content: { 'application/json': { schema: { type: 'object' } } } },
          '422': { description: 'invalid' },
        },
      },
    },
    '/orders/{id}': {
      get: {
        tags: ['orders'],
        operationId: 'getOrder',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/users': {
      get: {
        tags: ['users'],
        operationId: 'listUsers',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'role', in: 'query', schema: { type: 'string', enum: ['admin', 'member'] } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array' } } } } },
      },
    },
  },
});

const ASYNCAPI_YAML = [
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
  '  order.cancelled:',
  '    subscribe:',
  '      message:',
  '        name: OrderCancelled',
  '        payload:',
  '          type: object',
  '          properties: { reason: { type: string } }',
].join('\n');

const EVENTS_SPEC = parseSpecText(ASYNCAPI_YAML);

const fileMap = (files: EmittedFile[]): Map<string, string> =>
  new Map(files.map((f) => [f.path, f.content]));

describe('emission determinism', () => {
  it('emitting the same IR twice yields byte-identical files', () => {
    const ir = buildApiIR(JSON.parse(SPEC_JSON));
    const once = fileMap(emitContracts(ir, { groupBy: 'tag' }));
    const twice = fileMap(emitContracts(ir, { groupBy: 'tag' }));

    expect([...once.keys()].sort()).toEqual([...twice.keys()].sort());
    for (const [path, content] of once) {
      expect(twice.get(path)).toBe(content); // byte-identical, not just similar
    }
  });

  it('the same holds for events emission', () => {
    const ir = buildEventsIR(EVENTS_SPEC);
    const once = fileMap(emitEvents(ir));
    const twice = fileMap(emitEvents(ir));
    expect([...once.keys()].sort()).toEqual([...twice.keys()].sort());
    for (const [path, content] of once) {
      expect(twice.get(path)).toBe(content);
    }
  });
});

describe('HTTP spec → model → code round-trip', () => {
  const ir = buildApiIR(JSON.parse(SPEC_JSON));
  const options = { groupBy: 'tag' as const };

  it('re-emits byte-identical files after serialize → parse → IR', () => {
    const direct = emitContracts(ir, options);

    const model = modelFromHttpIr(ir, 'shop.json');
    const revived = httpIrFromModel(parseModel(serializeModel(model)));
    const roundTripped = emitContracts(revived, options);

    expect([...roundTripped.map((f) => f.path)].sort()).toEqual([...direct.map((f) => f.path)].sort());
    const directMap = fileMap(direct);
    for (const file of roundTripped) {
      expect(directMap.get(file.path)).toBe(file.content);
    }
  });

  it('the model itself survives a serialize → parse cycle unchanged', () => {
    const model = modelFromHttpIr(ir, 'shop.json');
    const text = serializeModel(model);
    expect(serializeModel(parseModel(text))).toBe(text); // fixed point
  });

  it('serialize → parse is lossless for the operation set', () => {
    const model = modelFromHttpIr(ir, 'shop.json');
    const revived = httpIrFromModel(parseModel(serializeModel(model)));
    const count = (api: ApiIR): number => api.groups.reduce((n, g) => n + g.operations.length, 0);
    expect(count(revived)).toBe(count(ir));
    const names = (api: ApiIR): string[] =>
      api.groups.flatMap((g) => g.operations.map((o) => o.name)).sort();
    expect(names(revived)).toEqual(names(ir));
  });
});

describe('events spec → model → code round-trip', () => {
  it('re-emits byte-identical files after serialize → parse → IR', () => {
    const ir = buildEventsIR(EVENTS_SPEC);
    const direct = emitEvents(ir);

    const model = modelFromEventsIr(ir, 'events.yaml');
    const revived = eventsIrFromModel(parseModel(serializeModel(model)));
    const roundTripped = emitEvents(revived);

    expect([...roundTripped.map((f) => f.path)].sort()).toEqual([...direct.map((f) => f.path)].sort());
    const directMap = fileMap(direct);
    for (const file of roundTripped) {
      expect(directMap.get(file.path)).toBe(file.content);
    }
  });
});

describe('source hashing (cache invalidation input)', () => {
  it('is stable for identical text', () => {
    expect(hashSource(SPEC_JSON)).toBe(hashSource(SPEC_JSON));
  });

  it('differs for different text', () => {
    expect(hashSource(SPEC_JSON)).not.toBe(hashSource(SPEC_JSON.replace('2.1.0', '2.2.0')));
  });
});
