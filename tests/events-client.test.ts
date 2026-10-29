import { beforeEach, describe, expect, it } from 'vitest';
import { EventsClient } from '../src/events/client.js';
import { FakeSocket, fakeSocketFactory, waitFor } from './events-helpers.js';

beforeEach(() => {
  FakeSocket.reset();
});

function openedFactory(
  onCreated?: (socket: FakeSocket, index: number) => void,
) {
  return fakeSocketFactory((socket, index) => {
    setTimeout(() => socket.serverOpen(), 0);
    onCreated?.(socket, index);
  });
}

describe('EventsClient', () => {
  it('publishes through the default { topic, payload } envelope', async () => {
    const client = new EventsClient({ url: 'wss://example.test/events', socketFactory: openedFactory() });
    await client.connect();
    await client.publish('order.create', { productId: 'p1', quantity: 2 });

    const frame = FakeSocket.first().lastSentJson();
    expect(frame).toEqual({ topic: 'order.create', payload: { productId: 'p1', quantity: 2 } });
    await client.disconnect();
  });

  it('routes incoming envelope frames by topic', async () => {
    const received: Array<{ message: unknown; topic: string | null }> = [];
    const client = new EventsClient({ url: 'wss://example.test/events', socketFactory: openedFactory() });
    client.subscribe('order.created', (message, ctx) => {
      received.push({ message, topic: ctx.topic });
    });
    await client.connect();

    FakeSocket.first().serverMessage({ topic: 'order.created', payload: { orderId: 'o1' } });
    FakeSocket.first().serverMessage({ topic: 'user.signup', payload: { userId: 'u1' } });
    await waitFor(() => received.length === 1);

    expect(received[0]).toEqual({ message: { orderId: 'o1' }, topic: 'order.created' });
    await client.disconnect();
  });

  it('captures :param segments from subscribed patterns', async () => {
    const captured: Array<Record<string, string>> = [];
    const client = new EventsClient({ url: 'wss://example.test/events', socketFactory: openedFactory() });
    client.subscribe('order/:id/created', (_message, ctx) => captured.push(ctx.params));
    await client.connect();

    FakeSocket.first().serverMessage({ topic: 'order/o-42/created', payload: {} });
    FakeSocket.first().serverMessage({ topic: 'order/o-42/deleted', payload: {} });
    await waitFor(() => captured.length === 1);

    expect(captured[0]).toEqual({ id: 'o-42' });
    await client.disconnect();
  });

  it('delivers topicless frames only to * subscribers', async () => {
    const wildcards: unknown[] = [];
    const exact: unknown[] = [];
    const client = new EventsClient({ url: 'wss://example.test/events', socketFactory: openedFactory() });
    client.subscribe('*', (message) => wildcards.push(message));
    client.subscribe('order.created', (message) => exact.push(message));
    await client.connect();

    FakeSocket.first().serverMessage('just a string');
    await waitFor(() => wildcards.length === 1);
    expect(wildcards[0]).toBe('just a string');
    expect(exact).toHaveLength(0);
    await client.disconnect();
  });

  it('supports custom envelopes ({ event, data }) via extractors', async () => {
    const received: unknown[] = [];
    const client = new EventsClient({
      url: 'wss://example.test/events',
      socketFactory: openedFactory(),
      publishEnvelope: (topic, message) => ({ event: topic, data: message }),
      topicExtractor: (message) =>
        typeof message === 'object' && message !== null && 'event' in message
          ? String((message as { event: unknown }).event)
          : null,
      payloadExtractor: (message) =>
        typeof message === 'object' && message !== null && 'data' in message
          ? (message as { data: unknown }).data
          : message,
    });
    client.subscribe('chat.message', (message) => received.push(message));
    await client.connect();

    await client.publish('chat.message', { text: 'hello' });
    FakeSocket.first().serverMessage({ event: 'chat.message', data: { text: 'hello' } });
    await waitFor(() => received.length === 1);

    expect(received[0]).toEqual({ text: 'hello' });
    expect(FakeSocket.first().lastSentJson()).toEqual({ event: 'chat.message', data: { text: 'hello' } });
    await client.disconnect();
  });

  it('authMode query appends a fresh token per attempt', async () => {
    let calls = 0;
    const client = new EventsClient({
      url: 'wss://example.test/events',
      socketFactory: openedFactory(),
      authMode: 'query',
      tokenProvider: () => `tok-${++calls}`,
      reconnectBaseDelayMs: 5,
    });
    await client.connect();
    expect(FakeSocket.first().url).toBe('wss://example.test/events?access_token=tok-1');

    FakeSocket.first().serverClose(1006);
    await waitFor(() => FakeSocket.all().length === 2);
    await waitFor(() => client.state === 'open');
    expect(FakeSocket.all()[1]!.url).toBe('wss://example.test/events?access_token=tok-2');
    await client.disconnect();
  });

  it('authMode subprotocol passes the token as a protocol', async () => {
    const client = new EventsClient({
      url: 'wss://example.test/events',
      socketFactory: openedFactory(),
      authMode: 'subprotocol',
      tokenProvider: () => 'jwt-abc',
    });
    await client.connect();
    expect(FakeSocket.first().protocols).toEqual(['jwt-abc']);
    await client.disconnect();
  });

  it('authMode first-message sends an auth frame on connect', async () => {
    const client = new EventsClient({
      url: 'wss://example.test/events',
      socketFactory: openedFactory(),
      authMode: 'first-message',
      tokenProvider: () => 'secret',
    });
    await client.connect();
    expect(FakeSocket.first().lastSentJson()).toEqual({ type: 'auth', token: 'secret' });
    await client.disconnect();
  });

  it('keeps subscriptions across reconnections', async () => {
    const received: unknown[] = [];
    const client = new EventsClient({
      url: 'wss://example.test/events',
      socketFactory: openedFactory(),
      reconnectBaseDelayMs: 5,
    });
    client.subscribe('order.created', (message) => received.push(message));
    await client.connect();

    FakeSocket.first().serverClose(1006);
    await waitFor(() => FakeSocket.all().length === 2 && client.state === 'open');
    FakeSocket.all()[1]!.serverMessage({ topic: 'order.created', payload: { orderId: 'o9' } });
    await waitFor(() => received.length === 1);

    expect(received[0]).toEqual({ orderId: 'o9' });
    await client.disconnect();
  });

  it('fires onConnected on every (re)connection', async () => {
    const opens: number[] = [];
    const client = new EventsClient({
      url: 'wss://example.test/events',
      socketFactory: openedFactory(),
      reconnectBaseDelayMs: 5,
    });
    client.onConnected(() => opens.push(FakeSocket.all().length));
    await client.connect();
    FakeSocket.first().serverClose(1006);
    await waitFor(() => client.state === 'open' && FakeSocket.all().length === 2);

    expect(opens).toEqual([1, 2]);
    await client.disconnect();
  });

  it('reports handler exceptions through onError without dropping the connection', async () => {
    const errors: unknown[] = [];
    const received: unknown[] = [];
    const client = new EventsClient({ url: 'wss://example.test/events', socketFactory: openedFactory() });
    client.onError((error) => errors.push(error));
    client.subscribe('boom', () => {
      throw new Error('handler blew up');
    });
    client.subscribe('fine', (message) => received.push(message));
    await client.connect();

    FakeSocket.first().serverMessage({ topic: 'boom', payload: {} });
    FakeSocket.first().serverMessage({ topic: 'fine', payload: { ok: true } });
    await waitFor(() => received.length === 1);

    expect(errors).toHaveLength(1);
    expect(client.state).toBe('open');
    await client.disconnect();
  });

  it('publish throws when the connection is not open', async () => {
    const client = new EventsClient({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory(), // never opens
      connectTimeoutMs: 60_000,
    });
    await expect(client.publish('t', {})).rejects.toThrow(/Cannot send while/);
  });
});
