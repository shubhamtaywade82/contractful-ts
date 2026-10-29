import { describe, expect, it } from 'vitest';
import { QueueFullError, RateLimiter } from '../src/index.js';

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
    expect(Date.now() - t0).toBeLessThan(20);
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
});
