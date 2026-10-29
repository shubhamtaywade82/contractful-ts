import { describe, expect, it } from 'vitest';
import {
  HttpStatusError,
  RateLimitError,
  ResponseShapeError,
  validateResponse,
  parseRetryAfter,
} from '../src/index.js';

describe('validateResponse — default behavior (no responds declared)', () => {
  it('accepts any 2xx and returns the body untouched', () => {
    const outcome = validateResponse(undefined, {
      status: 201,
      headers: {},
      body: { anything: { nested: [1, 2] } },
    });
    expect(outcome.body).toEqual({ anything: { nested: [1, 2] } });
  });

  it('throws HttpStatusError for non-2xx', () => {
    expect(() =>
      validateResponse(undefined, { status: 500, headers: {}, body: 'boom' }),
    ).toThrow(HttpStatusError);
    try {
      validateResponse(undefined, { status: 404, headers: {}, body: { message: 'nope' } });
      expect.unreachable();
    } catch (err) {
      const httpErr = err as HttpStatusError;
      expect(httpErr.status).toBe(404);
      expect(httpErr.declared).toBe(false);
      expect(httpErr.body).toEqual({ message: 'nope' });
      expect(httpErr.retryable).toBe(false);
    }
  });

  it('marks 5xx and 429 as retryable, other 4xx as terminal', () => {
    expect(new HttpStatusError('x', { status: 503 }).retryable).toBe(true);
    expect(new HttpStatusError('x', { status: 429 }).retryable).toBe(true);
    expect(new HttpStatusError('x', { status: 400 }).retryable).toBe(false);
  });
});

describe('validateResponse — declared statuses', () => {
  const decls = [
    { status: 200, type: 'array' as const },
    { status: 201 },
    { status: 422 },
    { status: '5xx' as const },
  ];

  it('returns the body for declared success statuses', () => {
    const outcome = validateResponse(decls, { status: 200, headers: {}, body: [1, 2, 3] });
    expect(outcome.body).toEqual([1, 2, 3]);
  });

  it('throws a declared HttpStatusError for declared error statuses', () => {
    try {
      validateResponse(decls, { status: 422, headers: {}, body: { errors: ['title'] } });
      expect.unreachable();
    } catch (err) {
      const httpErr = err as HttpStatusError;
      expect(httpErr.declared).toBe(true);
      expect(httpErr.body).toEqual({ errors: ['title'] });
    }
  });

  it('throws for statuses that were never declared', () => {
    try {
      validateResponse(decls, { status: 403, headers: {}, body: null });
      expect.unreachable();
    } catch (err) {
      expect((err as HttpStatusError).message).toContain('not declared');
    }
  });

  it('matches status class patterns like 5xx', () => {
    try {
      validateResponse(decls, { status: 503, headers: {}, body: null });
      expect.unreachable();
    } catch (err) {
      expect((err as HttpStatusError).declared).toBe(true);
    }
  });

  it('allows overriding ok for error-looking statuses', () => {
    const outcome = validateResponse(
      [{ status: 418, ok: true }],
      { status: 418, headers: {}, body: { tea: 'short' } },
    );
    expect(outcome.body).toEqual({ tea: 'short' });
  });
});

describe('validateResponse — open response shapes', () => {
  it('passes unknown fields through untouched (open world)', () => {
    const outcome = validateResponse(
      [{ status: 200, type: 'hash' }],
      { status: 200, headers: {}, body: { known: 1, surprise: { deep: true } } },
    );
    expect(outcome.body).toEqual({ known: 1, surprise: { deep: true } });
  });

  it('checks only the top-level declared type', () => {
    const ok = validateResponse(
      [{ status: 200, type: 'array' }],
      { status: 200, headers: {}, body: [{ id: 1 }] },
    );
    expect(ok.body).toEqual([{ id: 1 }]);
  });

  it('throws ResponseShapeError on top-level type mismatch', () => {
    expect(() =>
      validateResponse(
        [{ status: 200, type: 'array' }],
        { status: 200, headers: {}, body: { not: 'an array' } },
      ),
    ).toThrow(ResponseShapeError);
  });

  it('distinguishes hash vs array', () => {
    expect(() =>
      validateResponse([{ status: 200, type: 'hash' }], { status: 200, headers: {}, body: [] }),
    ).toThrow(ResponseShapeError);
  });
});

describe('RateLimitError', () => {
  it('is retryable and carries Retry-After', () => {
    const err = new RateLimitError({ status: 429, body: null, headers: {}, retryAfterMs: 1200 });
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(1200);
  });
});

describe('parseRetryAfter', () => {
  it('parses delay-seconds', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('1.5')).toBe(1500);
  });

  it('parses HTTP dates', () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(4_000);
    expect(ms).toBeLessThanOrEqual(5_000);
  });

  it('returns undefined for garbage', () => {
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
