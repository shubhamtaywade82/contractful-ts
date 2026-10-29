/**
 * Rate-limit pacing (token-bucket + GCRA-style scheduling).
 *
 * Instead of answering a burst and being throttled by the server, the
 * client paces its own requests at `requestsPerSecond` with an optional
 * `burst` allowance. Callers await `acquire()` before dispatching.
 */

import { QueueFullError } from '../errors.js';

interface Waiter {
  resolve: () => void;
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

  /** Resolves when the caller may dispatch its request. */
  acquire(): Promise<void> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(new QueueFullError(this.#maxPending));
    }
    this.#pending += 1;
    return new Promise<void>((resolve) => {
      this.#queue.push({
        resolve: () => {
          this.#pending -= 1;
          resolve();
        },
      });
      this.#drain();
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
        setTimeout(() => waiter.resolve(), waitMs);
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
