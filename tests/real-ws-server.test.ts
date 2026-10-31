/**
 * Real-transport integration tests for the events runtime: an actual
 * `ws` WebSocketServer on 127.0.0.1 and the DEFAULT socket factory
 * (global `WebSocket` on Node 22+, lazily imported `ws` on Node 18) —
 * real TCP, real frames, real close codes.
 *
 * The `FakeSocket` unit tests pin the state machine deterministically;
 * these prove the same machine against an independent server
 * implementation, which is what the completeness audit asked for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventsClient } from '../src/events/client.js';
import { ReconnectingSocket } from '../src/events/socket.js';
import { EventsConnectionError } from '../src/errors.js';
import type { AuthProvider } from '../src/auth/provider.js';
import { waitFor } from './events-helpers.js';
import {
  RealWsServer,
  startNeverUpgradingServer,
  waitForConnections,
  withGlobalWebSocket,
} from './real-ws-helpers.js';

let server: RealWsServer;

beforeEach(async () => {
  server = await RealWsServer.start();
});

afterEach(async () => {
  await server.dispose();
});

describe('events runtime against a real WebSocket server', () => {
  it('round-trips publish → server echo → subscriber through the default factory', async () => {
    server.onConnection((conn) => {
      conn.socket.on('message', () => {
        const last = conn.lastJson();
        if (last.topic === 'order.create') {
          conn.sendJson({ topic: 'order.created', payload: { id: 'e1', ...last.payload }, id: 'evt-42' });
        }
      });
    });

    const received: unknown[] = [];
    const client = new EventsClient({ url: server.url });
    client.subscribe('order.created', (message) => received.push(message));
    await client.connect();
    await client.publish('order.create', { productId: 'p1', quantity: 2 });

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ id: 'e1', productId: 'p1', quantity: 2 });
    expect(server.connections[0]!.jsonFrames()).toContainEqual({
      topic: 'order.create',
      payload: { productId: 'p1', quantity: 2 },
    });
    expect(client.getLastEventId()).toBe('evt-42');
    await client.disconnect();
  });

  it('falls back to the lazy ws import when no global WebSocket exists (the Node 18 path)', async () => {
    // Node 22+ ships a global WebSocket; hiding it reproduces the Node 18
    // situation, where the default factory must lazily `import('ws')`.
    await withGlobalWebSocket(undefined, async () => {
      const client = new EventsClient({ url: server.url });
      await client.connect();
      await client.publish('ping.topic', { via: 'hidden-global' });
      await waitFor(() => server.connections[0]!.frames.length > 0);
      expect(server.connections[0]!.lastJson()).toEqual({
        topic: 'ping.topic',
        payload: { via: 'hidden-global' },
      });
      await client.disconnect();
    });
    // With the global restored (Node 22+) the plain path works identically.
    const client = new EventsClient({ url: server.url });
    await client.connect();
    await client.disconnect();
    expect(server.connections.length).toBe(2);
  });

  it('reconnects after an abnormal server drop and resubscribes on the new connection', async () => {
    server.onConnection((conn) => {
      if (conn.index === 1) {
        conn.socket.on('message', () => {
          conn.sendJson({ topic: 'ticks', payload: { n: 1 } });
        });
      }
    });

    const received: unknown[] = [];
    const client = new EventsClient({
      url: server.url,
      reconnectBaseDelayMs: 15,
      subscribeEnvelope: (pattern) => ({ topic: '_sub', pattern }),
      unsubscribeEnvelope: (pattern) => ({ topic: '_unsub', pattern }),
    });
    client.subscribe('ticks', (message) => received.push(message));
    await client.connect();

    await waitFor(() =>
      server.connections[0]!.jsonFrames().some((f) => (f as { topic?: string }).topic === '_sub'),
    );
    server.connections[0]!.socket.terminate(); // abnormal close → 1006 on the client
    await waitForConnections(server, 2);

    await waitFor(() =>
      server.connections[1]!.jsonFrames().some((f) => (f as { topic?: string }).topic === '_sub'),
    );
    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ n: 1 });
    expect(client.state).toBe('open');
    await client.disconnect();
  });

  it('heartbeat: a silent server trips the liveness timeout (close 4000) and the client recovers', async () => {
    // Connection 0 stays silent (no frames ever); later connections echo
    // every frame back so `lastReceivedAt` stays fresh.
    server.onConnection((conn) => {
      if (conn.index > 0) {
        conn.socket.on('message', () => conn.sendJson({ topic: 'hb', payload: 'pong' }));
      }
    });

    const received: unknown[] = [];
    const client = new EventsClient({
      url: server.url,
      reconnectBaseDelayMs: 15,
      heartbeatIntervalMs: 30,
      heartbeatTimeoutMs: 150,
    });
    client.subscribe('hb', (message) => received.push(message));
    await client.connect();

    await waitFor(() => server.connections[0]!.closedWith?.code === 4000, 3_000);
    await waitForConnections(server, 2);
    await waitFor(() => client.state === 'open' && received.length > 0, 3_000);

    // The pacing pings themselves were on the wire.
    expect(server.connections[0]!.frames.length).toBeGreaterThan(0);
    await client.disconnect();
  });

  it('connect-message auth: 4001 token-expired → provider refresh → reconnect with the fresh token', async () => {
    let token = 'stale';
    let refreshes = 0;
    const provider: AuthProvider = {
      getAuth: async () => ({ connectMessage: { type: 'auth', token } }),
      handleUnauthorized: async () => {
        refreshes++;
        token = 'fresh';
        return true;
      },
    };

    server.onConnection((conn) => {
      conn.socket.on('message', () => {
        const first = conn.jsonFrames()[0] as { type?: string; token?: string };
        if (first?.token === 'stale') {
          conn.socket.close(4001, 'token expired');
        } else if (first?.token === 'fresh') {
          conn.sendJson({ topic: 'session', payload: { ok: true } });
        }
      });
    });

    const received: unknown[] = [];
    const client = new EventsClient({
      url: server.url,
      authProvider: provider,
      reconnectBaseDelayMs: 15,
    });
    client.subscribe('session', (message) => received.push(message));
    await client.connect();

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ ok: true });
    expect(refreshes).toBe(1);
    expect(server.connections).toHaveLength(2);
    expect(server.connections[0]!.closedWith?.code).toBe(4001);
    expect((server.connections[1]!.jsonFrames()[0] as { token?: string }).token).toBe('fresh');
    await client.disconnect();
  });

  it('header auth reaches the server as a real upgrade header (ws path of the default factory)', async () => {
    server.onConnection((conn) => {
      if (conn.upgrade.headers.authorization !== 'Bearer tok-1') {
        conn.socket.close(4003, 'missing bearer');
      }
    });

    const client = new EventsClient({
      url: server.url,
      authMode: 'header',
      tokenProvider: async () => 'tok-1',
    });
    await client.connect();
    await client.publish('probe', { ok: 1 });

    expect(server.connections[0]!.upgrade.headers.authorization).toBe('Bearer tok-1');
    await waitFor(() => server.connections[0]!.frames.length > 0);
    expect(client.state).toBe('open');
    await client.disconnect();
  });

  it('requested subprotocols arrive in the upgrade request', async () => {
    const client = new EventsClient({ url: server.url, protocols: ['v1', 'events'] });
    await client.connect();
    await client.disconnect();

    const requested = server.connections[0]!.upgrade.headers['sec-websocket-protocol'];
    expect(String(requested)).toContain('v1');
    expect(String(requested)).toContain('events');
  });

  it('a server that never completes the upgrade fails after the connect-timeout budget', async () => {
    const dead = await startNeverUpgradingServer();
    try {
      const socket = new ReconnectingSocket({
        url: dead.url,
        connectTimeoutMs: 120,
        reconnectMaxAttempts: 2,
        reconnectBaseDelayMs: 10,
      });
      await expect(socket.open()).rejects.toBeInstanceOf(EventsConnectionError);
      expect(socket.state).toBe('failed');
      expect(socket.failedAttempts).toBe(2);
    } finally {
      await dead.dispose();
    }
  });
});
