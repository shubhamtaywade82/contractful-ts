import { describe, expect, it } from 'vitest';
import { CircuitBreakerRegistry, CircuitOpenError } from '../src/index.js';
import { delay } from './helpers.js';

describe('CircuitBreakerRegistry', () => {
  it('stays closed under the failure threshold', () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 3 });
    registry.recordFailure('api.test');
    registry.recordFailure('api.test');
    expect(registry.state('api.test')).toBe('closed');
  });

  it('opens after consecutive failures and fails fast', async () => {
    const states: string[] = [];
    const registry = new CircuitBreakerRegistry({
      failureThreshold: 2,
      cooldownMs: 10_000,
      onStateChange: (from, to) => states.push(`${from}->${to}`),
    });
    registry.recordFailure('api.test');
    registry.recordFailure('api.test');
    expect(registry.state('api.test')).toBe('open');
    expect(states).toEqual(['closed->open']);

    await expect(registry.beforeRequest('api.test')).rejects.toThrow(CircuitOpenError);
  });

  it('resets the failure count after a success', () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 3 });
    registry.recordFailure('api.test');
    registry.recordFailure('api.test');
    registry.recordSuccess('api.test');
    registry.recordFailure('api.test');
    registry.recordFailure('api.test');
    expect(registry.state('api.test')).toBe('closed');
  });

  it('half-opens after the cooldown and closes on a successful probe', async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 40 });
    registry.recordFailure('api.test');
    expect(registry.state('api.test')).toBe('open');

    await delay(50);
    await registry.beforeRequest('api.test'); // becomes half-open, probe allowed
    expect(registry.state('api.test')).toBe('half-open');

    registry.recordSuccess('api.test');
    expect(registry.state('api.test')).toBe('closed');
  });

  it('re-opens when a half-open probe fails', async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 40 });
    registry.recordFailure('api.test');
    await delay(50);
    await registry.beforeRequest('api.test');
    expect(registry.state('api.test')).toBe('half-open');
    registry.recordFailure('api.test');
    expect(registry.state('api.test')).toBe('open');
  });

  it('limits concurrent half-open probes', async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 60, halfOpenProbes: 1 });
    registry.recordFailure('api.test');
    await delay(70);
    await registry.beforeRequest('api.test'); // probe 1 — allowed
    await expect(registry.beforeRequest('api.test')).rejects.toThrow(CircuitOpenError); // probe 2 — rejected
  });

  it('tracks hosts independently', async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1 });
    registry.recordFailure('a.test');
    expect(registry.state('a.test')).toBe('open');
    expect(registry.state('b.test')).toBe('closed');
    await registry.beforeRequest('b.test'); // does not throw
  });
});
