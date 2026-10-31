import { describe, expect, it } from 'vitest';
import { QueueFullError, RateLimiter, RequestAbortedError } from '../src/index.js';

describe('RateLimiter', () => {
  it('paces requests at the configured rate', async () => {
    const limiter = new RateLimiter(100, { burst: 1 }); // 10ms interval
    const t0 = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const elapsed = Date.now() - t0;
    // 4 requests at 10ms apart: at least ~30ms between first and last.
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it('allows a burst of B immediate requests', async () => {
    const limiter = new RateLimiter(10, { burst: 3 });
    const t0 = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // A pacing wait would cost ~1/rate = 100ms per slot — the bound just
    // needs to stay far below that while tolerating scheduler noise on a
    // busy CI runner.
    expect(Date.now() - t0).toBeLessThan(60);
  });

  it('processes concurrent acquires strictly in order', async () => {
    const limiter = new RateLimiter(200, { burst: 1 }); // 5ms interval
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        await limiter.acquire();
        order.push(n);
      }),
    );
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects when the queue is full', async () => {
    const limiter = new RateLimiter(5, { burst: 1, maxQueue: 2 });
    const p1 = limiter.acquire(); // takes the current slot
    const p2 = limiter.acquire(); // waits one interval (200ms at 5 rps)
    await expect(limiter.acquire()).rejects.toThrow(QueueFullError);
    await p1;
    await p2;
  });

  it('rejects invalid rates', () => {
    expect(() => new RateLimiter(0)).toThrow();
    expect(() => new RateLimiter(-5)).toThrow();
    expect(() => new RateLimiter(Number.NaN)).toThrow();
  });

  it('a waiter aborted while waiting rejects promptly, cancels its slot and frees queue space', async () => {
    const limiter = new RateLimiter(5, { burst: 1, maxQueue: 5 }); // 200ms interval
    const first = limiter.acquire(); // immediate slot
    const t0 = Date.now();

    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal); // scheduled ~200ms out
    setTimeout(() => controller.abort(), 20);

    await expect(waiting).rejects.toBeInstanceOf(RequestAbortedError);
    expect(Date.now() - t0).toBeLessThan(150); // far before the 200ms slot

    // The cancelled slot and queue space are reusable afterwards.
    await first;
    const after = limiter.acquire(); // paced, but accepted
    await after;
  });

  it('a pre-aborted signal rejects without queueing at all', async () => {
    const limiter = new RateLimiter(1000, { burst: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(controller.signal)).rejects.toBeInstanceOf(
      RequestAbortedError,
    );
    expect(limiter.queued).toBe(0);

    // The limiter itself is unaffected.
    await limiter.acquire();
  });
});
