import { beforeEach, describe, expect, it } from 'vitest';
import { createGraphQLWsClient } from '../src/events/graphql-ws.js';
import { FakeSocket, fakeSocketFactory, waitFor } from './events-helpers.js';

beforeEach(() => {
  FakeSocket.reset();
});

function connectClient(initPayload?: unknown) {
  const client = createGraphQLWsClient({
    url: 'wss://example.test/graphql',
    connectionInitPayload: initPayload,
    socketFactory: fakeSocketFactory((socket) => {
      // A real server answers connection_init asynchronously.
      setTimeout(() => socket.serverOpen(), 0);
      setTimeout(() => socket.serverMessage({ type: 'connection_ack' }), 8);
    }),
  });
  return client;
}

describe('createGraphQLWsClient', () => {
  it('sends connection_init on connect and resolves after connection_ack', async () => {
    const client = connectClient({ token: 't1' });
    await client.connect();

    const fake = FakeSocket.first();
    expect(fake.protocols).toEqual(['graphql-transport-ws']);
    expect(fake.lastSentJson()).toEqual({ type: 'connection_init', payload: { token: 't1' } });
    expect(client.state).toBe('open');
    await client.disconnect();
  });

  it('sends connection_init without payload when none is configured', async () => {
    const client = connectClient();
    await client.connect();
    expect(FakeSocket.first().lastSentJson()).toEqual({ type: 'connection_init' });
    await client.disconnect();
  });

  it('routes next/error/complete frames by operation id', async () => {
    const client = connectClient();
    await client.connect();
    const fake = FakeSocket.first();

    const nextData: unknown[] = [];
    const errors: unknown[] = [];
    const completed: number[] = [];

    const subA = client.subscribe(
      { query: 'subscription A { a }' },
      {
        next: (payload) => nextData.push(payload),
        error: (err) => errors.push(err),
        complete: () => completed.push(1),
      },
    );
    const subB = client.subscribe(
      { query: 'subscription B { b }', variables: { x: 1 }, operationName: 'B' },
      { next: () => undefined },
    );

    await waitFor(() => fake.sent.length >= 3); // connection_init + both subscribe frames
    expect(fake.sentJson()[1]).toEqual({ id: '1', type: 'subscribe', payload: { query: 'subscription A { a }' } });
    expect(fake.sentJson()[2]).toEqual({
      id: '2',
      type: 'subscribe',
      payload: { query: 'subscription B { b }', variables: { x: 1 }, operationName: 'B' },
    });

    fake.serverMessage({ id: '2', type: 'next', payload: { data: { b: true } } });
    fake.serverMessage({ id: '1', type: 'next', payload: { data: { a: 42 } } });
    await waitFor(() => nextData.length === 1);
    expect(nextData).toEqual([{ data: { a: 42 } }]); // id 1 only — id 2 goes to subB

    fake.serverMessage({ id: '1', type: 'complete' });
    await waitFor(() => completed.length === 1);

    fake.serverMessage({ id: '1', type: 'next', payload: { data: { a: 'ignored' } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nextData).toHaveLength(1); // the completed operation no longer delivers
    expect(errors).toHaveLength(0);

    subA.unsubscribe();
    subB.unsubscribe();
    await client.disconnect();
  });

  it('sends complete on unsubscribe', async () => {
    const client = connectClient();
    await client.connect();
    const fake = FakeSocket.first();

    const sub = client.subscribe({ query: 'subscription X { x }' }, { next: () => undefined });
    await waitFor(() => fake.sent.length >= 2); // connection_init + subscribe
    sub.unsubscribe();
    await waitFor(() => fake.lastSentJson().id === '1' && fake.lastSentJson().type === 'complete');
    expect(fake.lastSentJson()).toEqual({ id: '1', type: 'complete' });
    await client.disconnect();
  });

  it('replies pong to server ping frames', async () => {
    const client = connectClient();
    await client.connect();
    const fake = FakeSocket.first();

    fake.serverMessage({ type: 'ping' });
    await waitFor(() => fake.sent.some((frame) => frame.includes('pong')));
    expect(fake.lastSentJson()).toEqual({ type: 'pong' });
    await client.disconnect();
  });

  it('reports operation errors through the error handler', async () => {
    const client = connectClient();
    await client.connect();
    const fake = FakeSocket.first();

    const errors: unknown[] = [];
    client.subscribe({ query: 'subscription E { e }' }, {
      next: () => undefined,
      error: (err) => errors.push(err),
    });
    await waitFor(() => fake.sent.length >= 2); // connection_init + subscribe

    fake.serverMessage({ id: '1', type: 'error', payload: [{ message: 'nope' }] });
    await waitFor(() => errors.length === 1);
    expect(errors[0]).toEqual([{ message: 'nope' }]);
    await client.disconnect();
  });

  it('resubscribes active operations after a reconnect', async () => {
    const client = createGraphQLWsClient({
      url: 'wss://example.test/graphql',
      reconnect: true,
      reconnectMaxAttempts: 5,
      reconnectBaseDelayMs: 5,
      socketFactory: fakeSocketFactory((socket) => {
        setTimeout(() => socket.serverOpen(), 0);
        setTimeout(() => socket.serverMessage({ type: 'connection_ack' }), 8);
      }),
    });
    await client.connect();
    const first = FakeSocket.first();

    const nextData: unknown[] = [];
    client.subscribe({ query: 'subscription R { r }' }, { next: (payload) => nextData.push(payload) });
    await waitFor(() => first.sent.length === 2); // init + subscribe

    first.serverClose(1006);
    await waitFor(() => FakeSocket.all().length === 2);
    const second = FakeSocket.all()[1]!;
    await waitFor(() => second.sent.length === 2);

    // Reconnect replays connection_init then the active subscription.
    expect(second.sentJson()[0]).toEqual({ type: 'connection_init' });
    expect(second.sentJson()[1]).toEqual({ id: '1', type: 'subscribe', payload: { query: 'subscription R { r }' } });

    second.serverMessage({ id: '1', type: 'next', payload: { data: { r: 'ok' } } });
    await waitFor(() => nextData.length === 1);
    expect(nextData[0]).toEqual({ data: { r: 'ok' } });

    await client.disconnect();
  });
});
