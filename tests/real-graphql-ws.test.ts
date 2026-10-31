/**
 * GraphQL subscriptions over a REAL graphql-transport-ws link: the server
 * below is a minimal independent implementation of the protocol
 * (connection_init/ack, ping/pong, subscribe/next/error/complete) running
 * on a `ws` WebSocketServer. The client connects through the default
 * socket factory — the audit's "validate against real GraphQL servers"
 * item, without requiring a live GraphQL service.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGraphQLWsClient } from '../src/events/graphql-ws.js';
import { waitFor } from './events-helpers.js';
import { RealWsServer, waitForConnections, type ServerConnection } from './real-ws-helpers.js';

interface ServerFrame {
  id?: string;
  type?: string;
  payload?: unknown;
}

let server: RealWsServer;

beforeEach(async () => {
  server = await RealWsServer.start();
});

afterEach(async () => {
  await server.dispose();
});

/**
 * Minimal graphql-transport-ws server: acks after `connection_init`, answers
 * `ping` with `pong`, and hands every `subscribe` to `onSubscribe` for the
 * test to script.
 */
function startGraphqlServer(
  onSubscribe: (frame: ServerFrame, conn: ServerConnection) => void,
): void {
  server.onConnection((conn) => {
    conn.socket.on('message', () => {
      for (const raw of conn.jsonFrames()) {
        const frame = raw as ServerFrame;
        if (frame.type === 'connection_init') {
          conn.sendJson({ type: 'connection_ack' });
        } else if (frame.type === 'ping') {
          conn.sendJson({ type: 'pong' });
        } else if (frame.type === 'subscribe') {
          onSubscribe(frame, conn);
        }
      }
    });
  });
}

describe('graphql-transport-ws against a real server', () => {
  it('handshakes: connection_init with the auth payload, ack, and the graphql-transport-ws subprotocol', async () => {
    startGraphqlServer(() => undefined);

    const client = createGraphQLWsClient({
      url: server.url,
      connectionInitPayload: { token: 't1' },
    });
    await client.connect();

    expect(client.state).toBe('open');
    expect(server.connections[0]!.upgrade.headers['sec-websocket-protocol']).toBe(
      'graphql-transport-ws',
    );
    expect(server.connections[0]!.jsonFrames()[0]).toEqual({
      type: 'connection_init',
      payload: { token: 't1' },
    });
    await client.disconnect();
  });

  it('streams next → next → complete with variables, and unsubscribe sends complete to the server', async () => {
    startGraphqlServer((frame, conn) => {
      if (frame.id === '1') {
        conn.sendJson({ id: '1', type: 'next', payload: { data: { orderCreated: { id: 'o1' } } } });
        conn.sendJson({ id: '1', type: 'next', payload: { data: { orderCreated: { id: 'o2' } } } });
      }
    });

    const client = createGraphQLWsClient({ url: server.url });
    await client.connect();

    const events: unknown[] = [];
    let completed = 0;
    const sub = client.subscribe<{ orderCreated: { id: string } }>(
      {
        query: 'subscription ($min: Int!) { orderCreated(minPrice: $min) { id } }',
        variables: { min: 10 },
      },
      {
        next: (payload) => events.push(payload),
        complete: () => completed++,
      },
    );

    await waitFor(() => events.length >= 2);
    // Variables travel with the subscribe frame, exactly as sent.
    const subscribeFrame = server.connections[0]!.jsonFrames().find(
      (f) => (f as ServerFrame).type === 'subscribe',
    ) as { id?: string; payload?: { query?: string; variables?: unknown } };
    expect(subscribeFrame.id).toBe('1');
    expect(subscribeFrame.payload?.variables).toEqual({ min: 10 });
    expect(subscribeFrame.payload?.query).toContain('orderCreated');

    sub.unsubscribe(); // mid-stream unsubscribe → server receives `complete`
    await waitFor(() =>
      server.connections[0]!.jsonFrames().some((f) => (f as ServerFrame).type === 'complete'),
    );
    expect(completed).toBe(0); // the server never sent `complete`; we stopped locally
    await client.disconnect();
  });

  it('routes server error frames to the error handler and ignores later frames for that id', async () => {
    startGraphqlServer((frame, conn) => {
      if (frame.id === '1') {
        conn.sendJson({ id: '1', type: 'error', payload: [{ message: 'boom' }] });
        // Late frames for a dead operation must be ignored by the client.
        conn.sendJson({ id: '1', type: 'next', payload: { data: { stale: true } } });
      }
    });

    const client = createGraphQLWsClient({ url: server.url });
    await client.connect();

    const errors: unknown[] = [];
    const events: unknown[] = [];
    client.subscribe(
      { query: 'subscription { never }' },
      { next: (payload) => events.push(payload), error: (err) => errors.push(err) },
    );

    await waitFor(() => errors.length > 0);
    expect(errors[0]).toEqual([{ message: 'boom' }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual([]);
    await client.disconnect();
  });

  it('reconnects after a server drop and resubscribes active operations with the same id', async () => {
    startGraphqlServer((frame, conn) => {
      if (frame.id !== '1') return;
      if (conn.index === 0) {
        conn.socket.terminate(); // die mid-operation, no close frame
      } else {
        conn.sendJson({ id: '1', type: 'next', payload: { data: { orderCreated: { id: 'after' } } } });
      }
    });

    const client = createGraphQLWsClient({ url: server.url, reconnectBaseDelayMs: 15 });
    const events: unknown[] = [];
    client.subscribe(
      { query: 'subscription { orderCreated { id } }' },
      { next: (payload) => events.push(payload) },
    );
    await client.connect().catch(() => undefined); // may resolve before the drop

    await waitForConnections(server, 2);
    await waitFor(() => events.length > 0);

    // The resubscribe on connection 1 carries the SAME id and operation.
    const resub = server.connections[1]!.jsonFrames().find(
      (f) => (f as ServerFrame).type === 'subscribe',
    ) as { id?: string; payload?: { query?: string } };
    expect(resub.id).toBe('1');
    expect(resub.payload?.query).toContain('orderCreated');
    expect(events[0]).toEqual({ data: { orderCreated: { id: 'after' } } });
    await client.disconnect();
  });

  it('answers server pings with pongs (protocol keepalive)', async () => {
    server.onConnection((conn) => {
      conn.socket.on('message', () => {
        const seen = conn.jsonFrames() as Array<{ type?: string }>;
        if (seen.some((f) => f.type === 'connection_init')) {
          conn.sendJson({ type: 'connection_ack' });
          conn.sendJson({ type: 'ping' });
        }
      });
    });

    const client = createGraphQLWsClient({ url: server.url });
    await client.connect();

    await waitFor(() =>
      server.connections[0]!.jsonFrames().some((f) => (f as ServerFrame).type === 'pong'),
    );
    await client.disconnect();
  });
});
