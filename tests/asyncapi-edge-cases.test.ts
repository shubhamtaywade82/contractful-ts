/**
 * AsyncAPI adapter edge cases beyond the core mapping tests: 2.x
 * `operationId`, server-URL `{variables}` substitution (2.x url and 3.x
 * host), `$ref`'d messages and channel parameters, bidirectional
 * channels, and the documented untyped-payload limitation for
 * non-object payloads.
 */

import { describe, expect, it } from 'vitest';
import { buildEventsIR } from '../src/codegen/asyncapi.js';
import type { OpenApiSpec } from '../src/codegen/openapi.js';

function channelsOf(spec: OpenApiSpec, options?: Parameters<typeof buildEventsIR>[1]) {
  const ir = buildEventsIR(spec, options);
  return ir.groups.flatMap((group) => group.channels);
}

describe('AsyncAPI 2.x edge cases', () => {
  it('uses publish/subscribe operationId as the method name (like 3.x operation keys)', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'Ops', version: '1.0.0' },
      channels: {
        'order.created': {
          publish: {
            operationId: 'onOrderCreated',
            message: { payload: { type: 'object', properties: { id: { type: 'string' } } } },
          },
        },
        'order.ack': {
          subscribe: {
            operationId: 'acknowledgeOrder',
            message: { payload: { type: 'object', properties: { ok: { type: 'boolean' } } } },
          },
        },
      },
    } as unknown as OpenApiSpec;

    const channels = channelsOf(spec);
    expect(channels.map((c) => c.name).sort()).toEqual(['acknowledgeOrder', 'onOrderCreated']);
    expect(channels.find((c) => c.name === 'onOrderCreated')?.direction).toBe('in');
    expect(channels.find((c) => c.name === 'acknowledgeOrder')?.direction).toBe('out');
  });

  it('substitutes server-URL {variables} from their defaults', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'Var', version: '1.0.0' },
      servers: {
        production: {
          url: 'wss://{host}:{port}/v{version}/events',
          protocol: 'wss',
          variables: {
            host: { default: 'events.example.com' },
            port: { default: '443', enum: ['443', '8443'] },
            version: { default: '2' },
          },
        },
      },
      channels: {
        ping: { publish: { message: { payload: { type: 'object' } } } },
      },
    } as unknown as OpenApiSpec;

    expect(buildEventsIR(spec).url).toBe('wss://events.example.com:443/v2/events');
  });

  it('leaves variables without a default in place (visible, not silently wrong)', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'Var', version: '1.0.0' },
      servers: {
        production: {
          url: 'wss://{host}/events',
          protocol: 'wss',
          variables: { host: { enum: ['a.test', 'b.test'] } }, // no default
        },
      },
      channels: { ping: { publish: { message: { payload: { type: 'object' } } } } },
    } as unknown as OpenApiSpec;

    expect(buildEventsIR(spec).url).toBe('wss://{host}/events');
  });

  it('resolves $ref’d messages from components and keeps the message `name`', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'Refs', version: '1.0.0' },
      channels: {
        'order.created': {
          publish: { message: { $ref: '#/components/messages/orderCreated' } },
        },
      },
      components: {
        messages: {
          orderCreated: {
            name: 'OrderCreated',
            payload: {
              type: 'object',
              properties: { orderId: { type: 'string' } },
              required: ['orderId'],
            },
          },
        },
      },
    } as unknown as OpenApiSpec;

    const [channel] = channelsOf(spec);
    expect(channel.name).toBe('onOrderCreated'); // from the message name, not the channel label
    expect(channel.fields.map((f) => f.wireName)).toEqual(['orderId']);
    expect(channel.fields[0]).toMatchObject({ required: true });
  });

  it('emits both directions of a bidirectional channel as distinct methods', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'Bi', version: '1.0.0' },
      channels: {
        'chat.room': {
          publish: { message: { name: 'RoomMessage', payload: { type: 'object' } } },
          subscribe: { message: { name: 'RoomCommand', payload: { type: 'object' } } },
        },
      },
    } as unknown as OpenApiSpec;

    const channels = channelsOf(spec);
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.name).sort()).toEqual(['onRoomMessage', 'publishRoomCommand']);
    expect(new Set(channels.map((c) => c.direction))).toEqual(new Set(['in', 'out']));
  });

  it('non-object payloads yield untyped channels (fields: []) — the documented limitation', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'Scalar', version: '1.0.0' },
      channels: {
        telemetry: {
          publish: { message: { payload: { type: 'number' } } }, // scalar payload
        },
        tags: {
          publish: { message: { payload: { type: 'array', items: { type: 'string' } } } }, // array payload
        },
      },
    } as unknown as OpenApiSpec;

    const channels = channelsOf(spec);
    expect(channels).toHaveLength(2);
    for (const channel of channels) {
      expect(channel.fields).toEqual([]);
    }
  });
});

describe('AsyncAPI 3.x edge cases', () => {
  it('substitutes {variables} in the server host', () => {
    const spec = {
      asyncapi: '3.0.0',
      info: { title: 'V3Var', version: '1.0.0' },
      servers: {
        production: {
          host: '{region}.events.example.com',
          protocol: 'wss',
          variables: { region: { default: 'eu-west' } },
        },
      },
      channels: {
        ping: {
          address: 'ping',
          messages: { m: { payload: { type: 'object' } } },
        },
      },
    } as unknown as OpenApiSpec;

    expect(buildEventsIR(spec).url).toBe('wss://eu-west.events.example.com');
  });

  it('resolves channel parameters that are themselves $refs', () => {
    const spec = {
      asyncapi: '3.0.0',
      info: { title: 'V3Refs', version: '1.0.0' },
      channels: {
        orders: {
          address: 'orders/{orderId}/events',
          parameters: {
            orderId: { $ref: '#/components/parameters/orderIdParam' },
          },
          messages: {
            created: { payload: { type: 'object', properties: { id: { type: 'string' } } } },
          },
        },
      },
      operations: {
        onOrderEvent: {
          action: 'send',
          channel: { $ref: '#/channels/orders' },
          messages: [{ $ref: '#/channels/orders/messages/created' }],
        },
      },
      components: {
        parameters: {
          orderIdParam: { schema: { type: 'string', minLength: 1 } },
        },
      },
    } as unknown as OpenApiSpec;

    const [channel] = channelsOf(spec);
    expect(channel.topic).toBe('orders/:orderId/events');
    expect(channel.params).toHaveLength(1);
    expect(channel.params[0]).toMatchObject({
      wireName: 'orderId',
      location: 'path',
      required: true,
    });
    expect(channel.params[0]!.schema).toMatchObject({ type: 'string' });
  });
});
