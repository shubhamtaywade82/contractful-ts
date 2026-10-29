/**
 * P0 regression suite: method-aware retry safety.
 *
 * Ambiguous failures (network errors, timeouts, 5xx — the server may or may
 * not have applied the side effect) must only be retried when repeating the
 * request is known-safe:
 *
 *   - GET / HEAD / OPTIONS / PUT / DELETE (idempotent per RFC 9110)
 *   - contracts declaring `idempotent` (stable key across attempts)
 *   - contracts declaring `retry: 'always'`
 *   - calls carrying an explicit `_idempotencyKey`
 *   - APIs opting in with `retry.retryUnsafeMethods`
 *
 * A 429 is a server-sanctioned "retry later" and stays retryable for every
 * method; `retry: 'never'` opts out of everything.
 */
import { describe, expect, it } from 'vitest';
import {
  contract,
  defineApi,
  P,
  TransportError,
  TimeoutError,
} from '../src/index.js';
import { MockTransport, jsonResponse, type TransportHandler } from './helpers.js';

const FAST = { retries: 2, baseDelay: 1, jitter: 'none' as const };

function apiWith(handler: TransportHandler, extra: Record<string, unknown> = {}) {
  const transport = new MockTransport(handler);
  const Api = defineApi({
    name: 'RetrySafetyApi',
    base: 'https://retry.test',
    retry: { ...FAST, ...(extra.retry as object) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'retry')),
    contracts: {
      createThing: contract('POST /things', {
        params: { name: P.string({ required: true }) },
        responds: [{ status: 201 }, { status: 500 }],
      }),
      patchThing: contract('PATCH /things/:id', {
        params: { id: P.string({ required: true }), name: P.string({ required: true }) },
        responds: [{ status: 200 }, { status: 500 }],
      }),
      getThing: contract('GET /things/:id', {
        params: { id: P.string({ required: true }) },
        responds: [{ status: 200 }, { status: 500 }],
      }),
      putThing: contract('PUT /things/:id', {
        params: { id: P.string({ required: true }), name: P.string({ required: true }) },
        responds: [{ status: 200 }, { status: 500 }],
      }),
      deleteThing: contract('DELETE /things/:id', {
        params: { id: P.string({ required: true }) },
        responds: [{ status: 204 }, { status: 500 }],
      }),
      createIdempotent: contract('POST /things/idem', {
        idempotent: true,
        params: { name: P.string({ required: true }) },
        responds: [{ status: 201 }, { status: 500 }],
      }),
      createAlways: contract('POST /things/always', {
        retry: 'always',
        params: { name: P.string({ required: true }) },
        responds: [{ status: 201 }, { status: 500 }],
      }),
      createNever: contract('POST /things/never', {
        retry: 'never',
        params: { name: P.string({ required: true }) },
        responds: [{ status: 201 }, { status: 500 }],
      }),
      getNever: contract('GET /things/never/:id', {
        retry: 'never',
        params: { id: P.string({ required: true }) },
        responds: [{ status: 200 }, { status: 500 }],
      }),
    },
  });
  return { transport, client: new Api({ transport }) };
}

describe('retry safety — ambiguous failures on non-idempotent methods', () => {
  it('a POST is NOT retried after a network error (ambiguous: server may have applied it)', async () => {
    const { transport, client } = apiWith(() => new TransportError('connection reset'));
    await expect(client.createThing({ name: 'x' })).rejects.toThrow(TransportError);
    expect(transport.callCount).toBe(1);
  });

  it('a POST is NOT retried after a timeout', async () => {
    const { transport, client } = apiWith(() => new TimeoutError(500));
    await expect(client.createThing({ name: 'x' })).rejects.toThrow(TimeoutError);
    expect(transport.callCount).toBe(1);
  });

  it('a POST is NOT retried after a 5xx (the side effect may have happened)', async () => {
    const { transport, client } = apiWith(() => jsonResponse(500, { error: 'boom' }));
    await expect(client.createThing({ name: 'x' })).rejects.toThrow(/500/);
    expect(transport.callCount).toBe(1);
  });

  it('a PATCH is NOT retried after a network error', async () => {
    const { transport, client } = apiWith(() => new TransportError('dns'));
    await expect(client.patchThing({ id: '1', name: 'x' })).rejects.toThrow(TransportError);
    expect(transport.callCount).toBe(1);
  });

  it('a GET IS retried after a network error (idempotent method)', async () => {
    const { transport, client } = apiWith((_req, i) =>
      i === 0 ? new TransportError('flaky') : jsonResponse(200, { ok: true }),
    );
    await expect(client.getThing({ id: '1' })).resolves.toEqual({ ok: true });
    expect(transport.callCount).toBe(2);
  });

  it('PUT and DELETE are retried; HEAD/OPTIONS are in the idempotent set', async () => {
    const { transport, client } = apiWith((_req, i) =>
      i === 0 ? new TransportError('flaky') : jsonResponse(200, { ok: true }),
    );
    await expect(client.putThing({ id: '1', name: 'x' })).resolves.toEqual({ ok: true });
    expect(transport.callCount).toBe(2);
  });

  it('retry: "never" disables retries even for GET', async () => {
    const { transport, client } = apiWith(() => new TransportError('flaky'));
    await expect(client.getNever({ id: '1' })).rejects.toThrow(TransportError);
    expect(transport.callCount).toBe(1);
  });
});

describe('retry safety — explicit opt-ins for non-idempotent methods', () => {
  it('idempotent: true makes a POST retryable AND reuses the SAME idempotency key on every attempt', async () => {
    const keys: (string | undefined)[] = [];
    const { transport, client } = apiWith((req, i) => {
      keys.push(req.headers['Idempotency-Key']);
      return i < 2 ? jsonResponse(500, {}) : jsonResponse(201, { id: 7 });
    });
    await expect(client.createIdempotent({ name: 'x' })).resolves.toEqual({ id: 7 });
    expect(transport.callCount).toBe(3);
    // One key, generated once per dispatch, stable across all attempts.
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });

  it('an explicit _idempotencyKey is stamped as the header and enables retries', async () => {
    const keys: (string | undefined)[] = [];
    const { transport, client } = apiWith((req, i) => {
      keys.push(req.headers['Idempotency-Key']);
      return i === 0 ? new TransportError('flaky') : jsonResponse(201, { id: 8 });
    });
    await expect(
      client.createThing({ name: 'x', _idempotencyKey: 'my-stable-key' }),
    ).resolves.toEqual({ id: 8 });
    expect(transport.callCount).toBe(2);
    expect(keys).toEqual(['my-stable-key', 'my-stable-key']);
  });

  it('retry: "always" opts the contract in', async () => {
    const { transport, client } = apiWith((_req, i) =>
      i === 0 ? new TransportError('flaky') : jsonResponse(201, { id: 9 }),
    );
    await expect(client.createAlways({ name: 'x' })).resolves.toEqual({ id: 9 });
    expect(transport.callCount).toBe(2);
  });

  it('API-level retry.retryUnsafeMethods opts every contract in', async () => {
    const { transport, client } = apiWith(
      (_req, i) => (i === 0 ? new TransportError('flaky') : jsonResponse(201, { id: 10 })),
      { retry: { ...FAST, retryUnsafeMethods: true } },
    );
    await expect(client.createThing({ name: 'x' })).resolves.toEqual({ id: 10 });
    expect(transport.callCount).toBe(2);
  });
});

describe('retry safety — server-sanctioned 429', () => {
  it('a 429 IS retried even on a POST (the server rejected it before processing)', async () => {
    const { transport, client } = apiWith((_req, i) =>
      i === 0
        ? jsonResponse(429, { error: 'slow down' }, { 'retry-after': '0' })
        : jsonResponse(201, { id: 11 }),
    );
    await expect(client.createThing({ name: 'x' })).resolves.toEqual({ id: 11 });
    expect(transport.callCount).toBe(2);
  });

  it('retry: "never" opts out of 429 retries too', async () => {
    const { transport, client } = apiWith(() =>
      jsonResponse(429, { error: 'slow down' }, { 'retry-after': '0' }),
    );
    await expect(client.createNever({ name: 'x' })).rejects.toThrow(/429/);
    expect(transport.callCount).toBe(1);
  });
});
