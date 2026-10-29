import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  isRetryableError,
  retryDelayFor,
  TransportError,
  TimeoutError,
  RequestAbortedError,
  ContractViolationError,
  AuthError,
  ResponseShapeError,
  RateLimitError,
  HttpStatusError,
} from '../src/index.js';

const baseOpts = { baseDelay: 100, maxDelay: 1_000, jitter: 'none' } as const;

describe('isRetryableError', () => {
  it('retries transport and timeout errors', () => {
    expect(isRetryableError(new TransportError('boom'))).toBe(true);
    expect(isRetryableError(new TimeoutError(500))).toBe(true);
  });

  it('retries 408/425/429/5xx status errors', () => {
    expect(isRetryableError(new HttpStatusError('x', { status: 408 }))).toBe(true);
    expect(isRetryableError(new RateLimitError({ status: 429 }))).toBe(true);
    expect(isRetryableError(new HttpStatusError('x', { status: 503 }))).toBe(true);
  });

  it('does not retry client errors', () => {
    expect(isRetryableError(new HttpStatusError('x', { status: 400 }))).toBe(false);
    expect(isRetryableError(new HttpStatusError('x', { status: 404 }))).toBe(false);
  });

  it('does not retry validation, auth, shape or abort errors', () => {
    expect(isRetryableError(new ContractViolationError([]))).toBe(false);
    expect(isRetryableError(new AuthError('nope'))).toBe(false);
    expect(
      isRetryableError(
        new ResponseShapeError({ status: 200, body: {}, expectedType: 'array', actualType: 'hash' }),
      ),
    ).toBe(false);
    expect(isRetryableError(new RequestAbortedError())).toBe(false);
  });

  it('consults the extra classifier last', () => {
    class WeirdError extends Error {}
    expect(isRetryableError(new WeirdError(), () => true)).toBe(true);
    expect(isRetryableError(new WeirdError())).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and caps at maxDelay', () => {
    expect(backoffDelay(0, baseOpts)).toBe(100);
    expect(backoffDelay(1, baseOpts)).toBe(200);
    expect(backoffDelay(2, baseOpts)).toBe(400);
    expect(backoffDelay(3, baseOpts)).toBe(800);
    expect(backoffDelay(10, baseOpts)).toBe(1_000);
  });

  it('full jitter keeps delays within [0, base]', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(0, { ...baseOpts, jitter: 'full' });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(100);
    }
  });

  it('half jitter keeps delays within [base/2, base]', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(0, { ...baseOpts, jitter: 'half' });
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(100);
    }
  });
});

describe('retryDelayFor', () => {
  const opts = { ...baseOpts, retries: 3, jitter: 'none', retryAfterCapMs: 1_000 } as const;

  it('prefers Retry-After on 429 within the cap', () => {
    const err = new RateLimitError({ status: 429, body: null, headers: {}, retryAfterMs: 700 });
    expect(retryDelayFor(err, 1, opts)).toBe(700);
  });

  it('clamps oversized Retry-After to the cap', () => {
    const err = new RateLimitError({ status: 429, body: null, headers: {}, retryAfterMs: 60_000 });
    expect(retryDelayFor(err, 0, opts)).toBe(1_000);
  });

  it('falls back to exponential backoff otherwise', () => {
    const err = new TransportError('connection refused');
    expect(retryDelayFor(err, 2, opts)).toBe(400);
  });
});
