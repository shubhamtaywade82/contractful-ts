/**
 * Retry policy: exponential backoff with jitter, `Retry-After` support and
 * the retryable / terminal error classification that drives it.
 */

import { ContractfulError } from '../errors.js';
import {
  RateLimitError,
  RequestAbortedError,
  TimeoutError,
  TransportError,
} from '../errors.js';
import { parseRetryAfter } from '../validation/response.js';
import type { RetryOptions } from '../types.js';

/** A `RetryOptions` with every numeric / enum field resolved. */
export type ResolvedRetryOptions = Omit<
  Required<RetryOptions>,
  'retryOn'
> & {
  retryOn?: (err: unknown) => boolean;
};

export const DEFAULT_RETRY_OPTIONS: ResolvedRetryOptions = {
  retries: 2,
  baseDelay: 200,
  maxDelay: 5_000,
  jitter: 'full',
  retryAfterCapMs: 30_000,
  retryUnsafeMethods: false,
};

/** True when the error class warrants another attempt. */
export function isRetryableError(err: unknown, extra?: (err: unknown) => boolean): boolean {
  if (err instanceof RequestAbortedError) return false;
  if (err instanceof TransportError) return true; // includes TimeoutError
  if (err instanceof RateLimitError) return true;
  if (err instanceof ContractfulError) return err.retryable;
  if (extra) return extra(err);
  return false;
}

/** Computes the backoff delay before attempt `attempt` (zero-based). */
export function backoffDelay(
  attempt: number,
  options: Pick<ResolvedRetryOptions, 'baseDelay' | 'maxDelay' | 'jitter'>,
): number {
  const base = Math.min(options.maxDelay, options.baseDelay * 2 ** attempt);
  switch (options.jitter) {
    case 'none':
      return base;
    case 'half':
      return Math.round(base * (0.5 + Math.random() * 0.5));
    case 'full':
    default:
      return Math.round(base * Math.random());
  }
}

/**
 * The delay to actually sleep after `err`: honors a server `Retry-After`
 * (clamped by `retryAfterCapMs`) and otherwise uses exponential backoff.
 */
export function retryDelayFor(
  err: unknown,
  attempt: number,
  options: ResolvedRetryOptions,
): number {
  if (err instanceof RateLimitError && err.retryAfterMs !== undefined) {
    return Math.min(err.retryAfterMs, options.retryAfterCapMs);
  }
  return backoffDelay(attempt, options);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new RequestAbortedError('Aborted while waiting to retry'));
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new RequestAbortedError('Aborted while waiting to retry'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Exposed for tests. */
export function retryAfterFromHeader(header: string | undefined): number | undefined {
  return parseRetryAfter(header);
}

export type { TimeoutError };
