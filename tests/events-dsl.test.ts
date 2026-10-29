import { beforeEach, describe, expect, it } from 'vitest';
import { P } from '../src/dsl/params.js';
import { ContractViolationError, MessageShapeError } from '../src/errors.js';
import { defineEvents, publish, subscribe } from '../src/events/dsl.js';
import { FakeSocket, fakeSocketFactory, waitFor } from './events-helpers.js';

beforeEach(() => {
  FakeSocket.reset();
});

const OrderEvents = defineEvents({
  name: 'OrderEvents',
  url: 'wss://example.test/events',
  channels: {
    onOrderCreated: subscribe<{ orderId: string; total?: number }>('order.created', {
      description: 'Fired when an order is created.',
      fields: {
        orderId: P.string({ required: true, length: { min: 2 } }),
        total: P.float({ min: 0 }),
      },
    }),
    onItemAdded: subscribe<{ sku: string }>('order/:orderId/item.added', {
      params: { orderId: P.string({ required: true }) },
      fields: { sku: P.string({ required: true }) },
    }),
    createOrder: publish<{ productId: string; quantity: number }>('order.create', {
      fields: {
        productId: P.string({ required: true }),
        quantity: P.integer({ required: true, min: 1 }),
      },
    }),
    notifyOrder: publish<{ note: string }>('order/:id/notify', {
      params: { id: P.string({ required: true }) },
      fields: { note: P.string({ required: true }) },
    }),
    ping: publish('ping'),
  },
});

function connectOrderEvents() {
  const events = new OrderEvents({
    socketFactory: fakeSocketFactory((socket) => {
      setTimeout(() => socket.serverOpen(), 0);
    }),
  });
  return { events, connect: () => events.connect() };
}

describe('defineEvents', () => {
  it('derives typed channel methods and delivers validated messages', async () => {
    const { events, connect } = connectOrderEvents();
    const received: Array<{ orderId: string; total?: number }> = [];
    events.onOrderCreated((message) => received.push(message));
    await connect();

    FakeSocket.first().serverMessage({ topic: 'order.created', payload: { orderId: 'o-1', total: 9.5 } });
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ orderId: 'o-1', total: 9.5 });

    // Unknown response fields are data, not errors (open-world).
    FakeSocket.first().serverMessage({ topic: 'order.created', payload: { orderId: 'o-2', extra: true } });
    await waitFor(() => received.length === 2);
    expect(received[1]).toEqual({ orderId: 'o-2', extra: true });
    await events.disconnect();
  });

  it('skips messages that fail the incoming shape gate and reports them', async () => {
    const { events, connect } = connectOrderEvents();
    const errors: unknown[] = [];
    const received: unknown[] = [];
    events.onError((error) => errors.push(error));
    events.onOrderCreated((message) => received.push(message));
    await connect();

    FakeSocket.first().serverMessage({ topic: 'order.created', payload: { total: 'not-an-order' } });
    await waitFor(() => errors.length === 1);

    expect(received).toHaveLength(0);
    expect(errors[0]).toBeInstanceOf(MessageShapeError);
    const shapeError = errors[0] as MessageShapeError;
    expect(shapeError.topic).toBe('order.created');
    expect(shapeError.violations.some((v) => v.param === 'orderId')).toBe(true);
    await events.disconnect();
  });

  it('honors a custom onInvalidMessage handler', async () => {
    const seen: Array<string | null> = [];
    const events = new OrderEvents({
      socketFactory: fakeSocketFactory((socket) => {
        setTimeout(() => socket.serverOpen(), 0);
      }),
      onInvalidMessage: (error) => seen.push(error.topic),
    });
    const received: unknown[] = [];
    events.onOrderCreated((message) => received.push(message));
    await events.connect();

    FakeSocket.first().serverMessage({ topic: 'order.created', payload: { total: 1 } });
    await waitFor(() => seen.length === 1);

    expect(seen).toEqual(['order.created']);
    expect(received).toHaveLength(0);
    await events.disconnect();
  });

  it('publishes validated, coerced messages through the envelope', async () => {
    const { events, connect } = connectOrderEvents();
    await connect();

    await events.createOrder({ productId: 'p1', quantity: 2 });
    expect(FakeSocket.first().lastSentJson()).toEqual({
      topic: 'order.create',
      payload: { productId: 'p1', quantity: 2 },
    });

    // Numeric string coerces to integer.
    await events.createOrder({ productId: 'p2', quantity: '3' });
    expect(FakeSocket.first().lastSentJson()).toEqual({
      topic: 'order.create',
      payload: { productId: 'p2', quantity: 3 },
    });
    await events.disconnect();
  });

  it('rejects unknown fields (typos) and constraint violations on publish', async () => {
    const { events, connect } = connectOrderEvents();
    await connect();

    await expect(
      events.createOrder({ productId: 'p1', quantity: 1, quanitity: 2 } as never),
    ).rejects.toBeInstanceOf(ContractViolationError);

    await expect(events.createOrder({ productId: 'p1' } as never)).rejects.toBeInstanceOf(
      ContractViolationError,
    );

    await expect(
      events.createOrder({ productId: 'p1', quantity: 0 }),
    ).rejects.toBeInstanceOf(ContractViolationError);

    // Nothing reached the wire.
    expect(FakeSocket.first().sent).toHaveLength(0);
    await events.disconnect();
  });

  it('interpolates topic params for pattern publishes', async () => {
    const { events, connect } = connectOrderEvents();
    await connect();

    await events.notifyOrder({ note: 'hi' }, { id: 'o-7' });
    expect(FakeSocket.first().lastSentJson()).toEqual({
      topic: 'order/o-7/notify',
      payload: { note: 'hi' },
    });

    await expect(events.notifyOrder({ note: 'hi' }, {} as never)).rejects.toBeInstanceOf(
      ContractViolationError,
    );
    await events.disconnect();
  });

  it('types topic params on subscribe handlers', async () => {
    const { events, connect } = connectOrderEvents();
    const contexts: Array<{ topic: string | null; params: Record<string, string> }> = [];
    events.onItemAdded((_message, ctx) => contexts.push({ topic: ctx.topic, params: ctx.params }));
    await connect();

    FakeSocket.first().serverMessage({ topic: 'order/o-3/item.added', payload: { sku: 'S-1' } });
    await waitFor(() => contexts.length === 1);
    expect(contexts[0]).toEqual({ topic: 'order/o-3/item.added', params: { orderId: 'o-3' } });
    await events.disconnect();
  });

  it('publishes free-form messages on channels without fields', async () => {
    const { events, connect } = connectOrderEvents();
    await connect();
    await events.ping({ anything: 'goes', nested: { a: 1 } });
    expect(FakeSocket.first().lastSentJson()).toEqual({
      topic: 'ping',
      payload: { anything: 'goes', nested: { a: 1 } },
    });
    await events.disconnect();
  });

  it('exposes the raw client, state and describe()', async () => {
    const { events, connect } = connectOrderEvents();
    expect(events.state).toBe('idle');
    expect(events.eventsName).toBe('OrderEvents');
    const summary = OrderEvents.describe();
    expect(summary).toContain('OrderEvents');
    expect(summary).toContain('order.created');
    expect(summary).toContain('SUB');
    expect(summary).toContain('PUB');

    await connect();
    expect(events.state).toBe('open');
    expect(events.raw.state).toBe('open');
    await events.disconnect();
    expect(events.state).toBe('closed');
  });
});
