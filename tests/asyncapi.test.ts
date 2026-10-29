import { describe, expect, it } from 'vitest';
import { buildEventsIR, AsyncApiError } from '../src/codegen/asyncapi.js';
import { emitEvents } from '../src/codegen/events-emit.js';
import type { OpenApiSpec } from '../src/codegen/openapi.js';

const V2_SPEC: OpenApiSpec = {
  asyncapi: '2.6.0',
  info: { title: 'Order Events', version: '1.2.0' },
  servers: {
    production: { url: 'wss://orders.test/events', protocol: 'wss' },
    kafka: { url: 'kafka://ignored', protocol: 'kafka' },
  },
  channels: {
    'order.created': {
      publish: {
        message: {
          name: 'OrderCreated',
          description: 'Fired when an order is created.',
          payload: {
            type: 'object',
            properties: {
              orderId: { type: 'string', minLength: 2 },
              total: { type: 'number', minimum: 0 },
              status: { type: 'string', enum: ['pending', 'paid'] },
            },
            required: ['orderId'],
          },
        },
      },
    },
    'order.updated': {
      subscribe: {
        message: {
          name: 'OrderUpdate',
          payload: {
            type: 'object',
            properties: { patch: { type: 'object' } },
          },
        },
      },
    },
    'user/{userId}/notification': {
      parameters: {
        userId: { schema: { type: 'string', minLength: 1 } },
      },
      publish: {
        message: {
          payload: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
    },
  },
} as unknown as OpenApiSpec;

const V3_SPEC: OpenApiSpec = {
  asyncapi: '3.0.0',
  info: { title: 'Signals', version: '2.0.0' },
  servers: { production: { host: 'signals.test/ws', protocol: 'wss' } },
  channels: {
    order: {
      address: 'order.events',
      messages: {
        created: {
          payload: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    },
    commands: {
      address: 'commands',
      messages: {
        ping: { payload: { type: 'object', properties: { nonce: { type: 'integer' } } } },
      },
    },
  },
  operations: {
    onOrderCreated: {
      action: 'send',
      channel: { name: 'order' },
      messages: [{ $ref: '#/channels/order/messages/created' }],
    },
    sendPing: {
      action: 'receive',
      channel: { name: 'commands' },
      messages: [{ $ref: '#/channels/commands/messages/ping' }],
    },
  },
} as unknown as OpenApiSpec;

describe('buildEventsIR (AsyncAPI 2.x)', () => {
  it('maps server publish → client subscribe under the server perspective', () => {
    const ir = buildEventsIR(V2_SPEC);
    expect(ir.url).toBe('wss://orders.test/events');
    expect(ir.title).toBe('Order Events');
    const channels = ir.groups[0]!.channels;
    const created = channels.find((c) => c.name === 'onOrderCreated')!;
    expect(created).toBeDefined();
    expect(created.direction).toBe('in');
    expect(created.topic).toBe('order.created');
    expect(created.description).toContain('order is created');
    expect(created.fields.map((f) => f.wireName)).toEqual(['orderId', 'total', 'status']);
    expect(created.fields[0]!.required).toBe(true);
    expect(created.fields[1]!.required).toBe(false);
  });

  it('maps server subscribe → client publish', () => {
    const ir = buildEventsIR(V2_SPEC);
    const update = ir.groups[0]!.channels.find((c) => c.name === 'publishOrderUpdate')!;
    expect(update.direction).toBe('out');
    expect(update.topic).toBe('order.updated');
  });

  it('flips directions under the client perspective', () => {
    const ir = buildEventsIR(V2_SPEC, { perspective: 'client' });
    const created = ir.groups[0]!.channels.find((c) => c.name === 'onOrderCreated');
    expect(created).toBeUndefined();
    const publishCreate = ir.groups[0]!.channels.find((c) => c.name === 'publishOrderCreated')!;
    expect(publishCreate.direction).toBe('out');
  });

  it('converts {param} addresses to :param patterns with topic params', () => {
    const ir = buildEventsIR(V2_SPEC);
    const channel = ir.groups[0]!.channels.find((c) => c.topic === 'user/:userId/notification')!;
    expect(channel.params).toHaveLength(1);
    expect(channel.params[0]!.wireName).toBe('userId');
    expect(channel.params[0]!.required).toBe(true);
  });

  it('derives method names from the channel when the message is anonymous', () => {
    const ir = buildEventsIR(V2_SPEC);
    const channel = ir.groups[0]!.channels.find((c) => c.topic === 'user/:userId/notification')!;
    expect(channel.name).toBe('onUserUserIdNotification'); // on + Pascal(channel label)
  });

  it('supports oneOf messages as separate channels on one topic', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'Multi' },
      servers: { prod: { url: 'wss://x.test', protocol: 'wss' } },
      channels: {
        events: {
          publish: {
            message: {
              oneOf: [
                { name: 'UserSignedUp', payload: { type: 'object', properties: { userId: { type: 'string' } } } },
                { name: 'UserDeleted', payload: { type: 'object', properties: { userId: { type: 'string' } } } },
              ],
            },
          },
        },
      },
    } as unknown as OpenApiSpec;
    const ir = buildEventsIR(spec);
    const names = ir.groups[0]!.channels.map((c) => c.name).sort();
    expect(names).toEqual(['onUserDeleted', 'onUserSignedUp']);
    expect(new Set(ir.groups[0]!.channels.map((c) => c.topic))).toEqual(new Set(['events']));
  });

  it('rejects unsupported versions and non-AsyncAPI documents', () => {
    expect(() => buildEventsIR({ asyncapi: '1.2.0' } as OpenApiSpec)).toThrow(AsyncApiError);
    expect(() => buildEventsIR({} as OpenApiSpec)).toThrow(AsyncApiError);
  });
});

describe('buildEventsIR (AsyncAPI 3.x)', () => {
  it('resolves channels, addresses, actions and message refs', () => {
    const ir = buildEventsIR(V3_SPEC);
    expect(ir.url).toBe('wss://signals.test/ws'); // protocol + host
    const channels = ir.groups[0]!.channels;

    const created = channels.find((c) => c.name === 'onOrderCreated')!;
    expect(created.direction).toBe('in'); // server sends
    expect(created.topic).toBe('order.events');
    expect(created.fields[0]!.wireName).toBe('id');

    const ping = channels.find((c) => c.name === 'sendPing')!;
    expect(ping.direction).toBe('out'); // server receives
    expect(ping.topic).toBe('commands');
  });

  it('emits channels without operations as inbound (best effort)', () => {
    const spec = {
      asyncapi: '3.0.0',
      info: { title: 'Orphan' },
      servers: { prod: { host: 'x.test', protocol: 'wss' } },
      channels: {
        ticks: {
          address: 'ticks',
          messages: { tick: { payload: { type: 'object', properties: { n: { type: 'integer' } } } } },
        },
      },
    } as unknown as OpenApiSpec;
    const ir = buildEventsIR(spec);
    expect(ir.groups[0]!.channels[0]!.name).toBe('onTick');
    expect(ir.groups[0]!.channels[0]!.direction).toBe('in');
  });
});

describe('emitEvents', () => {
  it('generates a defineEvents module with subscribe/publish channels', () => {
    const ir = buildEventsIR(V2_SPEC);
    const files = emitEvents(ir, { specOrigin: 'orders.yaml' });
    expect(files.map((f) => f.path)).toEqual(['order-events-events.ts', 'index.ts']);

    const content = files[0]!.content;
    expect(content).toContain('import { defineEvents, subscribe, publish, P } from "contractful-ts"');
    expect(content).toContain('export const orderEventsEvents = defineEvents({');
    expect(content).toContain('onOrderCreated: subscribe("order.created", {');
    expect(content).toContain('orderId: P.string({ required: true, length: { min: 2 } }),');
    expect(content).toContain('inclusion: ["pending", "paid"]'),
    expect(content).toContain('publishOrderUpdate: publish("order.updated", {');
    expect(content).toContain('onUserUserIdNotification: subscribe("user/:userId/notification", {');
    expect(content).toContain('userId: P.string({ required: true, length: { min: 1 } }),');

    const index = files[1]!.content;
    expect(index).toContain("export * from './order-events-events.js';");
  });
});
