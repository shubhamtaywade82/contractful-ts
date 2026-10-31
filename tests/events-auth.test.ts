/**
 * WebSocket-side authentication: the AuthProvider integration (query /
 * subprotocol / header / connect-message material), the close-code policy
 * (4001 refresh + reconnect, 4003/4004 terminal), onAuthStateChanged
 * reconnects, event-id tracking and server-side resubscription.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  EventsClient,
  WebSocketApiError,
  WS_CLOSE_CODES,
  shouldReconnectOnClose,
  type AuthProvider,
} from '../src/index.js';
import type { SocketFactory, SocketLike } from '../src/events/types.js';
import { FakeSocket, waitFor } from './events-helpers.js';

/** Factory that also records the upgrade-request init (headers). */
function recordingFactory(log: { url: string; protocols: string[]; headers?: Record<string, string> }[]) {
  const factory: SocketFactory = (url, protocols, init) => {
    log.push({ url, protocols, headers: init?.headers });
    const socket = new FakeSocket(url, protocols);
    setTimeout(() => socket.serverOpen(), 0);
    return socket;
  };
  return factory;
}

function tokenProviderAuth(token: string): AuthProvider {
  return {
    async getAuth() {
      return { query: { access_token: token } };
    },
  };
}

describe('EventsClient + AuthProvider', () => {
  it('applies query material from getAuth to the connection URL', async () => {
    const log: { url: string; protocols: string[]; headers?: Record<string, string> }[] = [];
    const client = new EventsClient({
      url: 'wss://x/events',
      authProvider: tokenProviderAuth('tok-1'),
      socketFactory: recordingFactory(log),
    });
    await client.connect();
    expect(log[0]!.url).toBe('wss://x/events?access_token=tok-1');
    await client.disconnect();
  });

  it('applies subprotocol material', async () => {
    const log: { url: string; protocols: string[]; headers?: Record<string, string> }[] = [];
    const provider: AuthProvider = {
      async getAuth() {
        return { protocols: ['bearer-token', 'tok'] };
      },
    };
    const client = new EventsClient({
      url: 'wss://x/events',
      protocols: ['json'],
      authProvider: provider,
      socketFactory: recordingFactory(log),
    });
    await client.connect();
    expect(log[0]!.protocols).toEqual(['json', 'bearer-token', 'tok']);
    await client.disconnect();
  });

  it('applies header material to the upgrade request (Node ws-style factories)', async () => {
    const log: { url: string; protocols: string[]; headers?: Record<string, string> }[] = [];
    const provider: AuthProvider = {
      async getAuth() {
        return { headers: { Authorization: 'Bearer tok' } };
      },
    };
    const client = new EventsClient({
      url: 'wss://x/events',
      authProvider: provider,
      socketFactory: recordingFactory(log),
    });
    await client.connect();
    expect(log[0]!.headers).toEqual({ Authorization: 'Bearer tok' });
    await client.disconnect();
  });

  it('sends the connect message after the socket opens', async () => {
    const provider: AuthProvider = {
      async getAuth() {
        return { connectMessage: { type: 'auth', token: 'tok-9' } };
      },
    };
    const client = new EventsClient({
      url: 'wss://x/events',
      authProvider: provider,
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    await client.connect();
    expect(FakeSocket.last().lastSentJson()).toEqual({ type: 'auth', token: 'tok-9' });
    await client.disconnect();
  });

  it('ticket mode sends a one-time ticket as a query parameter', async () => {
    const log: { url: string; protocols: string[] }[] = [];
    const client = new EventsClient({
      url: 'wss://x/events',
      authMode: 'ticket',
      tokenProvider: () => 'ws_ticket_123',
      socketFactory: (url, protocols) => {
        log.push({ url, protocols });
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    await client.connect();
    expect(log[0]!.url).toBe('wss://x/events?ticket=ws_ticket_123');
    await client.disconnect();
  });

  it('header mode (tokenProvider) stamps a bearer header on the upgrade request', async () => {
    const log: { url: string; protocols: string[]; headers?: Record<string, string> }[] = [];
    const client = new EventsClient({
      url: 'wss://x/events',
      authMode: 'header',
      tokenProvider: () => 'tok-h',
      socketFactory: recordingFactory(log),
    });
    await client.connect();
    expect(log[0]!.headers).toEqual({ Authorization: 'Bearer tok-h' });
    await client.disconnect();
  });
});

describe('close-code policy', () => {
  it('shouldReconnectOnClose: 4001 reconnects, 4003/4004 do not', () => {
    expect(shouldReconnectOnClose(WS_CLOSE_CODES.TOKEN_EXPIRED)).toBe(true);
    expect(shouldReconnectOnClose(WS_CLOSE_CODES.UNAUTHORIZED)).toBe(false);
    expect(shouldReconnectOnClose(WS_CLOSE_CODES.FORBIDDEN)).toBe(false);
    expect(shouldReconnectOnClose(1006)).toBe(true);
    expect(shouldReconnectOnClose(undefined)).toBe(true);
  });

  it('4001 → handleUnauthorized(true) reconnects with fresh credentials', async () => {
    FakeSocket.reset();
    let generation = 1;
    const provider: AuthProvider = {
      async getAuth() {
        return { query: { access_token: `tok-g${generation}` } };
      },
      async handleUnauthorized() {
        generation++;
        return true;
      },
    };
    const client = new EventsClient({
      url: 'wss://x/events',
      authProvider: provider,
      reconnectBaseDelayMs: 5,
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    await client.connect();
    expect(FakeSocket.first().url).toContain('access_token=tok-g1');

    // Server expires our token.
    FakeSocket.first().serverClose(WS_CLOSE_CODES.TOKEN_EXPIRED, 'token expired');

    await waitFor(() => FakeSocket.all().length === 2);
    await waitFor(() => client.state === 'open');
    expect(FakeSocket.all()[1]!.url).toContain('access_token=tok-g2');
    await client.disconnect();
  });

  it('4001 → handleUnauthorized(false) fails terminally with WebSocketApiError', async () => {
    FakeSocket.reset();
    const provider: AuthProvider = {
      async getAuth() {
        return { query: { access_token: 'tok' } };
      },
      async handleUnauthorized() {
        return false; // refresh failed
      },
    };
    const client = new EventsClient({
      url: 'wss://x/events',
      authProvider: provider,
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    const errors: unknown[] = [];
    client.onError((e) => errors.push(e));
    await client.connect();
    FakeSocket.first().serverClose(WS_CLOSE_CODES.TOKEN_EXPIRED, 'token expired');

    await waitFor(() => client.state === 'failed');
    expect(errors[0]).toBeInstanceOf(WebSocketApiError);
    expect((errors[0] as WebSocketApiError).code).toBe(WS_CLOSE_CODES.TOKEN_EXPIRED);
    expect(FakeSocket.all()).toHaveLength(1); // no reconnect was attempted
  });

  it('4003 is terminal even without handleUnauthorized', async () => {
    FakeSocket.reset();
    const provider: AuthProvider = {
      async getAuth() {
        return { query: { access_token: 'tok' } };
      },
    };
    const client = new EventsClient({
      url: 'wss://x/events',
      authProvider: provider,
      reconnectBaseDelayMs: 5,
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    const errors: unknown[] = [];
    client.onError((e) => errors.push(e));
    await client.connect();
    FakeSocket.first().serverClose(WS_CLOSE_CODES.UNAUTHORIZED, 'bad credentials');

    await waitFor(() => client.state === 'failed');
    expect(errors[0]).toBeInstanceOf(WebSocketApiError);
    expect((errors[0] as WebSocketApiError).code).toBe(WS_CLOSE_CODES.UNAUTHORIZED);
    expect(FakeSocket.all()).toHaveLength(1);
  });

  it('onAuthStateChanged forces a reconnect with fresh material', async () => {
    FakeSocket.reset();
    let token = 't1';
    const listeners = new Set<() => void>();
    const provider: AuthProvider = {
      async getAuth() {
        return { query: { access_token: token } };
      },
      onAuthStateChanged(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const client = new EventsClient({
      url: 'wss://x/events',
      authProvider: provider,
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    await client.connect();
    expect(FakeSocket.first().url).toContain('access_token=t1');

    token = 't2';
    for (const listener of listeners) listener();

    await waitFor(() => FakeSocket.all().length === 2);
    await waitFor(() => client.state === 'open');
    expect(FakeSocket.all()[1]!.url).toContain('access_token=t2');
    await client.disconnect();
  });
});

describe('event ids and resubscription', () => {
  it('tracks the last event id from envelopes and hands it to handlers', async () => {
    FakeSocket.reset();
    const seen: (string | undefined)[] = [];
    const client = new EventsClient({
      url: 'wss://x/events',
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    await client.connect();
    client.subscribe('order.created', (_msg, ctx) => seen.push(ctx.eventId));

    expect(client.getLastEventId()).toBeNull();
    FakeSocket.last().serverMessage({ topic: 'order.created', eventId: 'evt-1', payload: { n: 1 } });
    FakeSocket.last().serverMessage({ topic: 'order.created', id: 'evt-2', payload: { n: 2 } });

    expect(seen).toEqual(['evt-1', 'evt-2']);
    expect(client.getLastEventId()).toBe('evt-2');
    await client.disconnect();
  });

  it('honors a custom eventIdExtractor', async () => {
    FakeSocket.reset();
    const client = new EventsClient({
      url: 'wss://x/events',
      eventIdExtractor: (message) => {
        const payload =
          typeof message === 'object' && message !== null && 'payload' in message
            ? (message as { payload?: unknown }).payload
            : undefined;
        return payload && typeof payload === 'object' && 'seq' in payload
          ? String((payload as { seq: number }).seq)
          : null;
      },
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    await client.connect();
    FakeSocket.last().serverMessage({ topic: 't', payload: { seq: 42 } });
    expect(client.getLastEventId()).toBe('42');
    await client.disconnect();
  });

  it('re-sends server-side subscriptions after a reconnect', async () => {
    FakeSocket.reset();
    const client = new EventsClient({
      url: 'wss://x/events',
      reconnectBaseDelayMs: 5,
      subscribeEnvelope: (pattern) => ({ type: 'subscribe', topic: pattern }),
      unsubscribeEnvelope: (pattern) => ({ type: 'unsubscribe', topic: pattern }),
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });

    await client.connect();
    const off = client.subscribe('order.created', () => {});
    // First connection: subscribe frame sent immediately.
    expect(FakeSocket.first().lastSentJson()).toEqual({ type: 'subscribe', topic: 'order.created' });

    // Drop and reconnect.
    FakeSocket.first().serverClose(1006, 'drop');
    await waitFor(() => FakeSocket.all().length === 2);
    await waitFor(() => client.state === 'open');
    expect(FakeSocket.all()[1]!.lastSentJson()).toEqual({ type: 'subscribe', topic: 'order.created' });

    // Unsubscribing sends the unsubscribe frame.
    off();
    expect(FakeSocket.all()[1]!.lastSentJson()).toEqual({ type: 'unsubscribe', topic: 'order.created' });
    await client.disconnect();
  });
});

describe('shouldReconnect socket hook', () => {
  it('a vetoed close fails with WebSocketApiError carrying code and reason', async () => {
    FakeSocket.reset();
    const shouldReconnect = vi.fn(async (info: { code?: number }) => info.code !== 4100);
    let failure: unknown;
    const { ReconnectingSocket } = await import('../src/events/socket.js');
    const socket = new ReconnectingSocket({
      url: 'wss://x',
      reconnectBaseDelayMs: 5,
      socketFactory: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        setTimeout(() => s.serverOpen(), 0);
        return s;
      },
      shouldReconnect,
      onStateChange: (state, info) => {
        if (state === 'failed') failure = info?.error;
      },
    });
    await socket.open();
    FakeSocket.first().serverClose(4100, 'policy');
    await waitFor(() => socket.state === 'failed');
    expect(failure).toBeInstanceOf(WebSocketApiError);
    expect((failure as WebSocketApiError).code).toBe(4100);
    expect((failure as WebSocketApiError).reason).toBe('policy');
    expect(shouldReconnect).toHaveBeenCalled();
  });
});
