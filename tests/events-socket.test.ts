import { beforeEach, describe, expect, it } from 'vitest';
import { EventsConnectionError, EventsError } from '../src/errors.js';
import { backoffDelayMs, ReconnectingSocket } from '../src/events/socket.js';
import { FakeSocket, fakeSocketFactory, waitFor } from './events-helpers.js';

beforeEach(() => {
  FakeSocket.reset();
});

describe('backoffDelayMs', () => {
  it('stays within [0, min(max, base * 2^(attempt-1))]', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = Math.min(30_000, 250 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const delay = backoffDelayMs(attempt, 250, 30_000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe('ReconnectingSocket', () => {
  it('resolves open() when the socket opens and reports state transitions', async () => {
    const states: string[] = [];
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory((s) => {
        setTimeout(() => s.serverOpen(), 0);
      }),
      onStateChange: (state) => states.push(state),
    });

    expect(socket.state).toBe('idle');
    await socket.open();
    expect(socket.state).toBe('open');
    expect(states).toEqual(['connecting', 'open']);

    await socket.close();
    expect(socket.state).toBe('closed');
  });

  it('resolves a repeated open() immediately', async () => {
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory((s) => setTimeout(() => s.serverOpen(), 0)),
    });
    await socket.open();
    await socket.open(); // no second attempt
    expect(FakeSocket.all()).toHaveLength(1);
    await socket.close();
  });

  it('reconnects with a fresh socket after an unexpected drop', async () => {
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory((s) => setTimeout(() => s.serverOpen(), 0)),
      reconnectBaseDelayMs: 5,
    });

    await socket.open();
    FakeSocket.first().serverClose(1006);
    await waitFor(() => socket.state === 'open');
    expect(FakeSocket.all()).toHaveLength(2);

    await socket.close();
  });

  it('does not reconnect after a user-initiated close', async () => {
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory((s) => setTimeout(() => s.serverOpen(), 0)),
      reconnectBaseDelayMs: 5,
    });

    await socket.open();
    await socket.close(1000, 'bye');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(FakeSocket.all()).toHaveLength(1);
    expect(socket.state).toBe('closed');
  });

  it('rejects open() and enters failed after exhausting attempts', async () => {
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: () => {
        throw new Error('dns broke');
      },
      reconnect: true,
      reconnectMaxAttempts: 2,
      reconnectBaseDelayMs: 5,
    });

    await expect(socket.open()).rejects.toBeInstanceOf(EventsConnectionError);
    expect(socket.state).toBe('failed');
    expect(socket.failedAttempts).toBe(2);
  });

  it('fails fast when reconnect is disabled', async () => {
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory(), // never opens
      reconnect: false,
      connectTimeoutMs: 20,
    });

    await expect(socket.open()).rejects.toBeInstanceOf(EventsConnectionError);
    expect(socket.state).toBe('failed');
    // The connect timeout closed the socket.
    expect(FakeSocket.first().closed?.code).toBe(4001);
  });

  it('times out a socket that never opens and retries', async () => {
    let opened = false;
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory((_s, index) => {
        if (index === 1) {
          setTimeout(() => {
            opened = true;
            FakeSocket.all()[1]!.serverOpen();
          }, 0);
        }
      }),
      reconnect: true,
      reconnectMaxAttempts: 5,
      reconnectBaseDelayMs: 5,
      connectTimeoutMs: 15,
    });

    await socket.open();
    expect(opened).toBe(true);
    expect(FakeSocket.all()[0]!.closed?.code).toBe(4001);
    await socket.close();
  });

  it('send() throws when the socket is not open', () => {
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory(),
    });
    expect(() => socket.send('hi')).toThrow(EventsError);
  });

  it('delivers received frames through onMessage', async () => {
    const received: unknown[] = [];
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory((s) => setTimeout(() => s.serverOpen(), 0)),
      onMessage: (data) => received.push(data),
    });

    await socket.open();
    FakeSocket.first().serverMessage('{"hello":"world"}');
    await waitFor(() => received.length === 1);
    expect(received[0]).toBe('{"hello":"world"}');
    await socket.close();
  });

  it('sends heartbeats and force-closes on liveness timeout', async () => {
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory((s) => setTimeout(() => s.serverOpen(), 0)),
      reconnect: false,
      heartbeat: { intervalMs: 10, timeoutMs: 40 },
    });

    await socket.open();
    const fake = FakeSocket.first();
    await waitFor(() => (fake.sent ?? []).length > 0, 1_000);
    expect(fake.sent[0]).toBe('{"type":"ping"}');

    // Server stays silent → liveness timeout closes the socket with 4000.
    await waitFor(() => fake.closed?.code === 4000, 2_000);
    await waitFor(() => socket.state === 'failed', 2_000);
  });

  it('keeps the connection alive when heartbeats are answered', async () => {
    const pongTimers: ReturnType<typeof setTimeout>[] = [];
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory((s) => {
        setTimeout(() => s.serverOpen(), 0);
        // Answer the first few pings so the liveness clock keeps resetting;
        // bounded timers only, so the process can exit cleanly.
        for (let i = 1; i <= 6; i++) {
          pongTimers.push(setTimeout(() => s.serverMessage('{"type":"pong"}'), i * 15));
        }
      }),
      heartbeat: { intervalMs: 10, timeoutMs: 500 },
    });

    await socket.open();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(socket.state).toBe('open');
    expect(FakeSocket.first().closed).toBeNull();
    await socket.close();
    for (const timer of pongTimers) clearTimeout(timer);
  });

  it('rejects open() when the user closes before the socket opens', async () => {
    const socket = new ReconnectingSocket({
      url: 'wss://example.test/events',
      socketFactory: fakeSocketFactory(), // hangs in connecting
      connectTimeoutMs: 10_000,
    });

    const opening = socket.open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await socket.close();
    await expect(opening).rejects.toBeInstanceOf(EventsError);
  });
});
