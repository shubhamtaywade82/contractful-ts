import { describe, expect, it } from 'vitest';
import {
  eventsIrFromModel,
  httpIrFromModel,
  modelFromEventsIr,
  modelFromHttpIr,
  mergeModels,
  parseModel,
  serializeModel,
} from '../src/codegen/model.js';
import { buildApiIR } from '../src/codegen/openapi.js';
import type { OpenApiSpec } from '../src/codegen/openapi.js';
import { buildEventsIR } from '../src/codegen/asyncapi.js';

const PETSTORE: OpenApiSpec = {
  openapi: '3.0.0',
  info: { title: 'Petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.test/v1' }],
  paths: {
    '/pets': {
      get: {
        tags: ['pets'],
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

const ASYNCAPI = {
  asyncapi: '2.6.0',
  info: { title: 'Orders', version: '1.0.0' },
  servers: { production: { url: 'wss://orders.test/events', protocol: 'wss' } },
  channels: {
    'order.created': {
      publish: {
        message: {
          name: 'OrderCreated',
          payload: {
            type: 'object',
            properties: { orderId: { type: 'string' } },
            required: ['orderId'],
          },
        },
      },
    },
  },
};

describe('canonical model', () => {
  it('round-trips HTTP IRs through serialize/parse', () => {
    const ir = buildApiIR(PETSTORE);
    const model = modelFromHttpIr(ir, 'petstore.json');
    const text = serializeModel(model);
    expect(text).toContain('"kind": "contractful-api-model"');
    const parsed = parseModel(text);
    const restored = httpIrFromModel(parsed);
    expect(restored.title).toBe('Petstore');
    expect(restored.base).toBe('https://petstore.test/v1');
    expect(restored.groups).toHaveLength(1);
    expect(restored.groups[0]!.operations[0]!.name).toBe('listPets');
  });

  it('round-trips events IRs through serialize/parse', () => {
    const ir = buildEventsIR(ASYNCAPI);
    const model = modelFromEventsIr(ir, 'orders.yaml');
    const parsed = parseModel(serializeModel(model));
    const restored = eventsIrFromModel(parsed);
    expect(restored.url).toBe('wss://orders.test/events');
    expect(restored.groups[0]!.channels[0]!.name).toBe('onOrderCreated');
    expect(restored.groups[0]!.channels[0]!.direction).toBe('in');
    expect(restored.groups[0]!.channels[0]!.fields.map((f) => f.wireName)).toEqual(['orderId']);
  });

  it('serializes deterministically (sorted keys)', () => {
    const model = modelFromHttpIr(buildApiIR(PETSTORE));
    expect(serializeModel(model)).toBe(serializeModel(parseModel(serializeModel(model))));
  });

  it('rejects invalid models', () => {
    expect(() => parseModel('{"kind":"other"}')).toThrow(/contractful-api-model/);
    expect(() => parseModel('not json')).toThrow(/invalid JSON/);
    expect(() =>
      parseModel('{"kind":"contractful-api-model","modelVersion":1,"name":"x","base":"","groups":{}}'),
    ).toThrow(/arrays/);
  });

  it('merges models from multiple sources', () => {
    const http = modelFromHttpIr(buildApiIR(PETSTORE));
    const events = modelFromEventsIr(buildEventsIR(ASYNCAPI));
    const merged = mergeModels([http, events]);
    expect(merged.groups).toHaveLength(1);
    expect(merged.channelGroups).toHaveLength(1);
    expect(merged.name).toBe('Petstore');
  });
});
