/**
 * Per-host circuit breakers.
 *
 * Consecutive failures (network errors, timeouts, 5xx) open the circuit;
 * further requests fail fast with {@link CircuitOpenError} until the
 * cooldown elapses, after which a half-open probe decides whether the
 * host has recovered.
 */

import { CircuitOpenError } from '../errors.js';
import type { CircuitOptions, CircuitState } from '../types.js';

interface Breaker {
  state: CircuitState;
  failures: number;
  openedAt: number;
  halfOpenInFlight: number;
}

const DEFAULTS = {
  failureThreshold: 5,
  cooldownMs: 10_000,
  halfOpenProbes: 1,
};

export class CircuitBreakerRegistry {
  readonly #options: typeof DEFAULTS;
  readonly #breakers = new Map<string, Breaker>();

  constructor(options: CircuitOptions = {}) {
    this.#options = {
      failureThreshold: options.failureThreshold ?? DEFAULTS.failureThreshold,
      cooldownMs: options.cooldownMs ?? DEFAULTS.cooldownMs,
      halfOpenProbes: options.halfOpenProbes ?? DEFAULTS.halfOpenProbes,
    };
    this.#onStateChange = options.onStateChange;
  }

  readonly #onStateChange?: (from: CircuitState, to: CircuitState, host: string) => void;

  #breakerFor(host: string): Breaker {
    let breaker = this.#breakers.get(host);
    if (!breaker) {
      breaker = { state: 'closed', failures: 0, openedAt: 0, halfOpenInFlight: 0 };
      this.#breakers.set(host, breaker);
    }
    return breaker;
  }

  /**
   * Called before dispatching. Resolves when a request may proceed;
   * throws {@link CircuitOpenError} when the circuit is open.
   */
  async beforeRequest(host: string): Promise<void> {
    const b = this.#breakerFor(host);
    if (b.state === 'open') {
      const elapsed = Date.now() - b.openedAt;
      if (elapsed >= this.#options.cooldownMs) {
        this.#transition(b, 'half-open', host);
      } else {
        throw new CircuitOpenError(host, this.#options.cooldownMs - elapsed);
      }
    }
    if (b.state === 'half-open' && b.halfOpenInFlight >= this.#options.halfOpenProbes) {
      throw new CircuitOpenError(host, 0);
    }
    if (b.state === 'half-open') {
      b.halfOpenInFlight += 1;
    }
  }

  /** Called after a successful exchange (any answered response, even 4xx). */
  recordSuccess(host: string): void {
    const b = this.#breakerFor(host);
    if (b.state === 'half-open') {
      b.halfOpenInFlight = Math.max(0, b.halfOpenInFlight - 1);
    }
    if (b.state !== 'closed') {
      this.#transition(b, 'closed', host);
    }
    b.failures = 0;
  }

  /** Called after a retryable failure (network error, timeout, 5xx). */
  recordFailure(host: string): void {
    const b = this.#breakerFor(host);
    if (b.state === 'half-open') {
      b.halfOpenInFlight = Math.max(0, b.halfOpenInFlight - 1);
      this.#transition(b, 'open', host);
      return;
    }
    b.failures += 1;
    if (b.failures >= this.#options.failureThreshold) {
      this.#transition(b, 'open', host);
    }
  }

  /** Called when an in-flight half-open probe completes abnormally. */
  recordAbort(host: string): void {
    const b = this.#breakerFor(host);
    if (b.state === 'half-open') {
      b.halfOpenInFlight = Math.max(0, b.halfOpenInFlight - 1);
    }
  }

  #transition(b: Breaker, to: CircuitState, host: string): void {
    if (b.state === to) return;
    const from = b.state;
    b.state = to;
    if (to === 'open') {
      b.openedAt = Date.now();
    }
    if (to === 'closed') {
      b.halfOpenInFlight = 0;
    }
    this.#onStateChange?.(from, to, host);
  }

  /** Test / introspection helper. */
  state(host: string): CircuitState {
    return this.#breakerFor(host).state;
  }

  /** Test / introspection helper. */
  failureCount(host: string): number {
    return this.#breakerFor(host).failures;
  }
}
