/**
 * Lifecycle races and cancellation — the seams the happy-path tests skip:
 *
 *  - aborting while parked in the rate-limit queue (must reject promptly and
 *    free the slot, not hang until the turn arrives)
 *  - queue-full surfacing through the client method
 *  - retries re-acquiring limiter slots (pacing applies to every attempt)
 *  - abort during retry backoff
 *  - circuit breakers: aborts are not failures; an aborted half-open probe
 *    frees its slot
 *  - events runtime: close-during-backoff, concurrent open(), exhausted
 *    budgets, failing factories and forced reconnects during backoff
 */

import { describe, expect, it } from 'vitest';
import { defineApi, contract, P } from '../src/index.js';
import {
  CircuitOpenError,
  QueueFullError,
  RateLimitError,
  RequestAbortedError,
  TransportError,
} from '../src/errors.js';
import { jsonResponse, type Transport, type TransportRequest, type TransportResponse } from './helpers.js';
import { FakeSocket, fakeSocketFactory, waitFor } from './events-helpers.js';
import { ReconnectingSocket } from '../src/events/socket.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A transport whose every send resolves only when the test decides —
 * and which honors AbortSignals exactly like the real axios transport.
 */
class DeferredTransport implements Transport {
  readonly sent: TransportRequest[] = [];
  readonly #entries: { settle: (value: TransportResponse | Error) => void }[] = [];

  send(req: TransportRequest): Promise<TransportResponse> {
    this.sent.push(req);
    return new Promise<TransportResponse>((resolve, reject) => {
      const entry = {
        settle: (value: TransportResponse | Error): void => {
          if (value instanceof Error) reject(value);
          else resolve(value);
        },
      };
      this.#entries.push(entry);
      const onAbort = (): void => {
        const index = this.#entries.indexOf(entry);
        if (index >= 0) this.#entries.splice(index, 1);
        reject(new RequestAbortedError('Request aborted through AbortSignal'));
      };
      if (req.signal) {
        if (req.signal.aborted) {
          onAbort();
          return;
        }
        req.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  get pending(): number {
    return this.#entries.length;
  }

  /** Resolves the n-th pending send (default: the oldest). */
  resolve(value: TransportResponse | Error, n = 0): void {
    const entry = this.#entries.splice(n, 1)[0];
    if (entry) entry.settle(value);
  }
}

function netError(): Error {
  return new TransportError('socket hang up', { code: 'ECONNRESET' });
}

describe('cancellation through the pipeline', () => {
  it('aborting while queued in the rate limiter rejects promptly and frees the slot', async () => {
    const transport = new DeferredTransport();
    const Api = defineApi({
      base: 'https://api.test',
      rateLimit: { requestsPerSecond: 4, burst: 1 }, // one slot now, next at +250ms
      contracts: {
        ping: contract('GET /ping', { responds: [{ status: 200, type: 'hash' }] }),
      },
    });
    const client = new Api({ transport });

    // A occupies the only immediate slot and hangs.
    const a = client.ping();
    await waitFor(() => transport.pending === 1);

    // B queues behind A, then aborts long before its slot would arrive.
    const controller = new AbortController();
    const startedAt = Date.now();
    const b = client.ping({ _signal: controller.signal });
    await delay(30);
    controller.abort();

    const err = await b.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(Date.now() - startedAt).toBeLessThan(200); // far below the 250ms slot

    // The queue accounting survived: finishing A lets a fresh C through.
    transport.resolve(jsonResponse(200, { ok: 'a' }));
    await expect(a).resolves.toEqual({ ok: 'a' });
    const c = client.ping();
    await waitFor(() => transport.pending === 1);
    transport.resolve(jsonResponse(200, { ok: 'c' }));
    await expect(c).resolves.toEqual({ ok: 'c' });
  });

  it('a pre-aborted signal rejects before any traffic or queueing', async () => {
    const transport = new DeferredTransport();
    const Api = defineApi({
      base: 'https://api.test',
      rateLimit: { requestsPerSecond: 100 },
      contracts: { ping: contract('GET /ping', { responds: [{ status: 200, type: 'hash' }] }) },
    });
    const client = new Api({ transport });

    const controller = new AbortController();
    controller.abort();

    await expect(client.ping({ _signal: controller.signal })).rejects.toBeInstanceOf(
      RequestAbortedError,
    );
    expect(transport.sent.length).toBe(0);
  });

  it('queue-full surfaces as QueueFullError from the client method', async () => {
    const transport = new DeferredTransport();
    const Api = defineApi({
      base: 'https://api.test',
      rateLimit: { requestsPerSecond: 4, maxQueue: 2 },
      contracts: { ping: contract('GET /ping', { responds: [{ status: 200, type: 'hash' }] }) },
    });
    const client = new Api({ transport });

    const a = client.ping(); // 1st outstanding acquire — immediate slot
    const b = client.ping(); // 2nd — paced ~250ms out
    await expect(client.ping()).rejects.toBeInstanceOf(QueueFullError); // 3rd

    await waitFor(() => transport.pending === 1); // a reached the transport
    transport.resolve(jsonResponse(200, { ok: true }));
    await expect(a).resolves.toEqual({ ok: true });

    await waitFor(() => transport.pending === 1); // b's paced slot arrived
    transport.resolve(jsonResponse(200, { ok: true }));
    await expect(b).resolves.toEqual({ ok: true });
  });

  it('retries pass through the rate limiter again — pacing covers every attempt', async () => {
    const transport = new DeferredTransport();
    const Api = defineApi({
      base: 'https://api.test',
      rateLimit: { requestsPerSecond: 4, burst: 1 }, // 250ms between slots
      retry: { retries: 1, baseDelay: 5 },
      contracts: { ping: contract('GET /ping', { responds: [{ status: 200, type: 'hash' }] }) },
    });
    const client = new Api({ transport });

    const startedAt = Date.now();
    const p = client.ping();
    await waitFor(() => transport.pending === 1);

    // Attempt 1 fails; the retry must wait for the next limiter slot (~250ms).
    transport.resolve(netError(), 0);
    await waitFor(() => transport.pending === 1);
    transport.resolve(jsonResponse(200, { ok: true }), 0);

    await expect(p).resolves.toEqual({ ok: true });
    expect(transport.sent.length).toBe(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120); // paced, not immediate
  });

  it('aborting during retry backoff rejects with RequestAbortedError', async () => {
    const transport = new DeferredTransport();
    const Api = defineApi({
      base: 'https://api.test',
      contracts: { ping: contract('GET /ping', { responds: [{ status: 200, type: 'hash' }] }) },
    });
    const client = new Api({ transport });

    const controller = new AbortController();
    const startedAt = Date.now();
    const p = client.ping({ _retries: 1, _retryDelay: 60_000, _signal: controller.signal });
    await waitFor(() => transport.pending === 1);
    transport.resolve(netError(), 0);

    await delay(50);
    controller.abort(); // deep inside the backoff sleep now

    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(Date.now() - startedAt).toBeLessThan(5_000); // did not wait the 60s backoff
    expect(transport.sent.length).toBe(1); // exactly one attempt was made
  });
});

describe('circuit breaker × cancellation interplay', () => {
  it('an aborted request is not a circuit failure, and an aborted half-open probe frees its slot', async () => {
    const transport = new DeferredTransport();
    const Api = defineApi({
      base: 'https://api.test',
      circuit: { failureThreshold: 1, cooldownMs: 60, halfOpenProbes: 1 },
      retry: { retries: 0 },
      contracts: { ping: contract('GET /ping', { responds: [{ status: 200, type: 'hash' }] }) },
    });
    const client = new Api({ transport });

    // One failure opens the circuit (threshold 1).
    const f = client.ping();
    await waitFor(() => transport.pending === 1);
    transport.resolve(netError(), 0);
    await expect(f).rejects.toBeInstanceOf(TransportError);

    // While open: fail fast.
    await expect(client.ping()).rejects.toBeInstanceOf(CircuitOpenError);

    // Cooldown elapses → half-open. The probe starts, then gets aborted.
    await delay(80);
    const controller = new AbortController();
    const probe = client.ping({ _signal: controller.signal });
    await waitFor(() => transport.pending === 1);
    controller.abort();
    await expect(probe).rejects.toBeInstanceOf(RequestAbortedError);

    // The aborted probe must NOT count as a failure nor hold the probe slot:
    // the very next request is allowed through and closes the circuit.
    const heal = client.ping();
    await waitFor(() => transport.pending === 1);
    transport.resolve(jsonResponse(200, { ok: true }));
    await expect(heal).resolves.toEqual({ ok: true });
  });

  it('a 429 without Retry-After still classifies as RateLimitError and is retryable for GET', async () => {
    const transport = new DeferredTransport();
    const Api = defineApi({
      base: 'https://api.test',
      retry: { retries: 1, baseDelay: 5 },
      contracts: { ping: contract('GET /ping', { responds: [{ status: 200, type: 'hash' }] }) },
    });
    const client = new Api({ transport });

    const p = client.ping();
    await waitFor(() => transport.pending === 1);
    transport.resolve({ status: 429, headers: {}, body: { error: 'slow' } }, 0);
    await waitFor(() => transport.pending === 1);
    transport.resolve(jsonResponse(200, { ok: true }), 0);

    await expect(p).resolves.toEqual({ ok: true });
    expect(transport.sent.length).toBe(2);
  });
});

describe('events runtime lifecycle races', () => {
  it('close() during reconnect backoff stops reconnection — no zombie timer', async () => {
    FakeSocket.reset();
    let created = 0;
    const socket = new ReconnectingSocket({
      url: 'ws://x',
      socketFactory: fakeSocketFactory((s) => {
        created += 1;
        if (created === 1) {
          // First connection opens, then the server drops it.
          setTimeout(() => {
            s.serverOpen();
            setTimeout(() => s.serverClose(1006, 'dropped'), 10);
          }, 5);
        }
      }),
      reconnectBaseDelayMs: 150,
      reconnectMaxAttempts: 10,
    });

    await socket.open();
    await waitFor(() => socket.state === 'reconnecting');

    await socket.close(1000, 'user done'); // while the backoff timer is pending
    expect(socket.state).toBe('closed');

    await delay(400); // the 150ms timer (plus slack) would have fired by now
    expect(created).toBe(1); // no second connection attempt
  });

  it('concurrent open() callers share one connection attempt and all resolve', async () => {
    FakeSocket.reset();
    let created = 0;
    const socket = new ReconnectingSocket({
      url: 'ws://x',
      socketFactory: fakeSocketFactory(() => {
        created += 1;
      }),
    });

    const opens = [socket.open(), socket.open(), socket.open()];
    expect(created).toBe(1); // a single socket for all three callers

    await delay(5); // let #connect's await settle so the socket is wired
    FakeSocket.last().serverOpen();
    await Promise.all(opens);
    expect(socket.state).toBe('open');
  });

  it('after the budget is exhausted, a fresh open() resets and reconnects', async () => {
    FakeSocket.reset();
    let failures = 0;
    let healthy = false;
    const socket = new ReconnectingSocket({
      url: 'ws://x',
      socketFactory: () => {
        if (!healthy) {
          failures += 1;
          throw new Error(`connect refused ${failures}`);
        }
        return new FakeSocket('ws://x', []);
      },
      reconnectMaxAttempts: 1,
      reconnectBaseDelayMs: 1,
    });

    // The budget counts retries after the initial attempt: maxAttempts 1
    // means two factory calls before the connection is declared failed.
    await expect(socket.open()).rejects.toThrow(/Connection failed after 1 attempt/);
    expect(socket.state).toBe('failed');
    expect(failures).toBe(2);

    healthy = true;
    const reopened = socket.open();
    await delay(5); // let the factory's await settle so the socket is wired
    FakeSocket.last().serverOpen();
    await expect(reopened).resolves.toBeUndefined();
    expect(socket.state).toBe('open');
  });

  it('a failing factory counts attempts, retries, and eventually connects', async () => {
    FakeSocket.reset();
    let failures = 0;
    const socket = new ReconnectingSocket({
      url: 'ws://x',
      socketFactory: () => {
        failures += 1;
        if (failures <= 2) throw new Error(`nope ${failures}`);
        return new FakeSocket('ws://x', []);
      },
      reconnectMaxAttempts: 10,
      reconnectBaseDelayMs: 1,
    });

    const opened = socket.open();
    await waitFor(() => FakeSocket.all().length === 1, 2_000);
    FakeSocket.last().serverOpen();
    await expect(opened).resolves.toBeUndefined();
    expect(failures).toBe(3); // two refusals, then success
    expect(socket.state).toBe('open');
  });

  it('a forced reconnect during backoff connects exactly once — no double-connect', async () => {
    FakeSocket.reset();
    let created = 0;
    const socket = new ReconnectingSocket({
      url: 'ws://x',
      socketFactory: fakeSocketFactory((s, i) => {
        created += 1;
        if (i === 0) {
          setTimeout(() => {
            s.serverOpen();
            setTimeout(() => s.serverClose(1006, 'dropped'), 5);
          }, 5);
        }
      }),
      reconnectBaseDelayMs: 120,
    });

    await socket.open();
    await waitFor(() => socket.state === 'reconnecting');

    // Force a reconnect while the 120ms backoff timer is still pending.
    const forced = socket.reconnect();
    await waitFor(() => created === 2, 2_000);
    FakeSocket.last().serverOpen();
    await expect(forced).resolves.toBeUndefined();
    expect(socket.state).toBe('open');

    await delay(300); // the old timer would have fired by now
    expect(created).toBe(2); // exactly one new connection
  });
});

describe('connect-timeout against a standard-constructor zombie socket', () => {
  /**
   * Reproduces the WHATWG-conformant hazard the global `WebSocket` has on
   * servers that accept TCP but never complete the upgrade: `close()`
   * during CONNECTING cannot abort the handshake, so `onclose` never
   * fires and a naive implementation waits forever. (`ws` aborts
   * immediately — which is why Node 18/20 CI jobs never saw this.)
   */
  it('force-recovers when the timed-out socket never produces onclose', async () => {
    let created = 0;
    let closes = 0;
    const socket = new ReconnectingSocket({
      url: 'ws://zombie.test',
      // A socket whose close() is silently swallowed while CONNECTING and
      // which never opens, never errors, never closes.
      socketFactory: () => {
        created++;
        return {
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: () => undefined,
          close: () => {
            closes++;
            // swallowed: no onclose, exactly like the standard constructor
            // against a never-upgrading server.
          },
        };
      },
      connectTimeoutMs: 40,
      reconnectMaxAttempts: 2,
      reconnectBaseDelayMs: 10,
    });

    await expect(socket.open()).rejects.toThrow();
    expect(socket.state).toBe('failed');
    // Budget 2 = the initial attempt + 2 reconnects (3 connections), and
    // every attempt tried the polite close() first before force-recovery.
    expect(socket.failedAttempts).toBe(2);
    expect(created).toBe(3);
    expect(closes).toBe(3);
  });
});
