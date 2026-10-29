/**
 * Shared public types: HTTP vocabulary, per-call meta options, lifecycle
 * hooks and client construction options.
 */

import type { AnyParamSpec, ParamLocation, ParamsShape } from './dsl/params.js';
import type { AxiosRequestConfig } from 'axios';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

/** Methods whose (non-path) parameters default to the JSON body. */
export const BODY_METHODS: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH'];

/**
 * Methods that are safe to retry by definition (RFC 9110 §9.2.2):
 * GET / HEAD / OPTIONS carry no request semantics, and PUT / DELETE are
 * idempotent — repeating them after an ambiguous failure (timeout, dropped
 * connection, 5xx) cannot change the outcome beyond the first attempt.
 * POST and PATCH are NOT in this list: an ambiguous failure may mean the
 * server already applied the side effect, so they are never auto-retried
 * unless the contract opts in (`idempotent`, `retry: 'always'`, an explicit
 * `_idempotencyKey`, or API-level `retry.retryUnsafeMethods`).
 */
export const IDEMPOTENT_METHODS: readonly HttpMethod[] = [
  'GET',
  'HEAD',
  'OPTIONS',
  'PUT',
  'DELETE',
];

/** Per-contract retry eligibility. */
export type ContractRetryMode = 'auto' | 'always' | 'never';

/**
 * Per-call meta options. Mirroring contractful, they are mixed into the
 * args object and prefixed with an underscore so they can never collide
 * with a declared parameter.
 */
export interface MetaOptions {
  /** Extra headers merged on top of the API / contract headers. */
  _headers?: Record<string, string>;
  /** Extra raw query parameters merged after contract params. */
  _query?: Record<string, string | number | boolean | ReadonlyArray<string>> | URLSearchParams;
  /** Per-call timeout in milliseconds. */
  _timeout?: number;
  /** Per-call retry budget (overrides API and contract settings). */
  _retries?: number;
  /** Per-call base retry delay in milliseconds. */
  _retryDelay?: number;
  /** Explicit idempotency key for idempotent contracts. */
  _idempotencyKey?: string;
  /** Skip the API's auth resolver for this call. */
  _skipAuth?: boolean;
  /** Abort the request through an `AbortSignal`. */
  _signal?: AbortSignal;
  /** Override the API base URL for this call. */
  _baseUrl?: string;
}

/** Mutable snapshot of a request as it flows through the pipeline. */
export interface RequestContext {
  /** API name given to `defineApi`, or `'api'`. */
  readonly api: string;
  /** Contract (method) name, e.g. `createIssue`. */
  readonly contract: string;
  readonly method: HttpMethod;
  /** Built path with path parameters already substituted. */
  readonly path: string;
  /** Base URL + built path (no query string). */
  readonly url: string;
  /** Zero-based attempt number (0 = first try). */
  readonly attempt: number;
  headers: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  readonly meta: MetaOptions;
}

/** Response snapshot handed to `afterResponse` hooks. */
export interface ResponseContext {
  readonly request: RequestContext;
  readonly status: number;
  readonly headers: Record<string, string>;
  body: unknown;
  readonly durationMs: number;
  readonly attempt: number;
}

export type RequestHook = (ctx: RequestContext) => void | Promise<void>;
export type ResponseHook = (ctx: ResponseContext) => void | Promise<void>;

/** Top-level response body type a contract may declare. */
export type ResponseType = 'array' | 'hash' | 'string' | 'number' | 'boolean' | 'null';

/** One entry of a contract's `responds` list. */
export interface ResponseDecl {
  /** Exact status (`200`) or a class pattern (`'2xx'`). */
  status: number | '2xx' | '3xx' | '4xx' | '5xx';
  /** Expected top-level body type; unknown fields stay open. */
  type?: ResponseType;
  /** Force-treat this status as success even when it is a 4xx/5xx. */
  ok?: boolean;
  describe?: string;
}

export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. Default `2`. */
  retries?: number;
  /** Base delay in ms for exponential backoff. Default `200`. */
  baseDelay?: number;
  /** Upper bound for a single backoff delay. Default `5_000`. */
  maxDelay?: number;
  /** `'full'` (default) randomizes the whole delay, `'half'` keeps >= 50%. */
  jitter?: 'full' | 'half' | 'none';
  /** Extra classifier deciding whether an error should be retried. */
  retryOn?: (err: unknown) => boolean;
  /** Upper bound applied to a server `Retry-After`. Default `30_000`. */
  retryAfterCapMs?: number;
  /**
   * Retry non-idempotent methods (POST / PATCH) after ambiguous failures
   * (network errors, timeouts, 5xx) instead of surfacing the error.
   * Default `false` — duplicate writes are worse than a visible failure.
   * A server-sanctioned `429 Retry-After` is honored for every method
   * regardless of this flag; set per-contract `retry: 'never'` to opt out.
   */
  retryUnsafeMethods?: boolean;
}

export interface CircuitOptions {
  /** Consecutive failures before the circuit opens. Default `5`. */
  failureThreshold?: number;
  /** How long the circuit stays open before a half-open probe. Default `10_000`. */
  cooldownMs?: number;
  /** Concurrent probes allowed while half-open. Default `1`. */
  halfOpenProbes?: number;
  onStateChange?: (from: CircuitState, to: CircuitState, host: string) => void;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RateLimitOptions {
  /** Sustained requests per second allowed toward the API host. */
  requestsPerSecond: number;
  /** Bucket capacity — how many requests may fire at once. Default `1`. */
  burst?: number;
  /** Max queued callers before throwing {@link QueueFullError}. Default `Infinity`. */
  maxQueue?: number;
}

/** Resolved placement for one parameter within a request. */
export interface ParamPlacement {
  location: Exclude<ParamLocation, 'auto'>;
  wireName: string;
  value: unknown;
}

export type { AnyParamSpec, ParamLocation, ParamsShape };

/** Extra axios configuration forwarded to the underlying axios instance. */
export type AxiosExtras = AxiosRequestConfig;
