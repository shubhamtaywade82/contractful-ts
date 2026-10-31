/**
 * Rate-limit pacing (token-bucket + GCRA-style scheduling).
 *
 * Instead of answering a burst and being throttled by the server, the
 * client paces its own requests at `requestsPerSecond` with an optional
 * `burst` allowance. Callers await `acquire()` before dispatching.
 */

import { QueueFullError, RequestAbortedError } from '../errors.js';

interface Waiter {
  /** Signals the caller that its slot arrived (no-op after the first settle). */
  resolve: () => void;
  /** Rejects the caller (abort) — cancels a scheduled but unfired slot. */
  reject: (err: Error) => void;
  /** The pending slot timer while the waiter is scheduled but unfired. */
  timer: ReturnType<typeof setTimeout> | null;
}

export class RateLimiter {
  readonly #intervalMs: number;
  readonly #maxPending: number;
  readonly #queue: Waiter[] = [];
  /** Extra immediate slots available beyond the base rate. */
  readonly #maxCredit: number;
  #credit: number;
  #lastRefill: number;
  /** Timestamp after which the next rate-bound request may leave. */
  #nextFreeAt = 0;
  #pending = 0;
  #draining = false;

  constructor(requestsPerSecond: number, options: { burst?: number; maxQueue?: number } = {}) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new Error(`requestsPerSecond must be > 0, got ${requestsPerSecond}`);
    }
    this.#intervalMs = 1000 / requestsPerSecond;
    this.#maxPending = options.maxQueue ?? Number.POSITIVE_INFINITY;
    const burst = Math.max(1, Math.floor(options.burst ?? 1));
    this.#maxCredit = burst - 1;
    this.#credit = this.#maxCredit;
    this.#lastRefill = Date.now();
  }

  /**
   * Resolves when the caller may dispatch its request.
   *
   * Honors an `AbortSignal`: a caller aborted while waiting for its slot —
   * whether still queued or already scheduled by the pacing clock — leaves
   * cleanly (cancelling the unfired slot timer) and rejects with
   * {@link RequestAbortedError} instead of holding the request open until
   * its turn would have arrived.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(new QueueFullError(this.#maxPending));
    }
    if (signal?.aborted) {
      return Promise.reject(
        new RequestAbortedError('Aborted while waiting for a rate-limit slot'),
      );
    }
    this.#pending += 1;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter: Waiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          this.#pending -= 1;
          resolve();
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          this.#pending -= 1;
          reject(err);
        },
        timer: null,
      };
      const onAbort = (): void => {
        // Not yet scheduled: leave the pending queue.
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        // Scheduled but unfired: give the slot back before leaving.
        if (waiter.timer) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        waiter.reject(new RequestAbortedError('Aborted while waiting for a rate-limit slot'));
      };
      this.#queue.push(waiter);
      this.#drain();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const now = Date.now();
        const elapsed = now - this.#lastRefill;
        if (elapsed > 0) {
          this.#credit = Math.min(this.#maxCredit, this.#credit + elapsed / this.#intervalMs);
          this.#lastRefill = now;
        }

        const waiter = this.#queue.shift()!;
        let slotAt: number;
        if (this.#credit >= 1) {
          // Burst allowance: dispatch immediately, do not advance the clock.
          this.#credit -= 1;
          slotAt = now;
        } else {
          slotAt = Math.max(this.#nextFreeAt, now);
          this.#nextFreeAt = slotAt + this.#intervalMs;
        }
        const waitMs = Math.max(0, slotAt - now);
        waiter.timer = setTimeout(() => {
          waiter.timer = null;
          waiter.resolve();
        }, waitMs);
      }
    } finally {
      this.#draining = false;
    }
  }

  /** Test helper: acquires currently scheduled or waiting. */
  get queued(): number {
    return this.#pending;
  }
}

/** One rate limiter per host, created lazily. */
export class RateLimiterRegistry {
  readonly #limiters = new Map<string, RateLimiter>();
  readonly #requestsPerSecond: number;
  readonly #burst?: number;
  readonly #maxQueue?: number;

  constructor(options: { requestsPerSecond: number; burst?: number; maxQueue?: number }) {
    this.#requestsPerSecond = options.requestsPerSecond;
    this.#burst = options.burst;
    this.#maxQueue = options.maxQueue;
  }

  for(host: string): RateLimiter {
    let limiter = this.#limiters.get(host);
    if (!limiter) {
      limiter = new RateLimiter(this.#requestsPerSecond, {
        burst: this.#burst,
        maxQueue: this.#maxQueue,
      });
      this.#limiters.set(host, limiter);
    }
    return limiter;
  }
}
