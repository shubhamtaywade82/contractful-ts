/**
 * `defineApi` — turn a bag of contracts into a typed client class.
 *
 * This is the runtime equivalent of contractful's metaprogramming: instead
 * of writing imperative request code, you declare the HTTP shape of an API
 * and the library derives the client, one method per contract, each wired
 * through the full request lifecycle:
 *
 *   validate args → build path → place params → hooks → auth →
 *   rate-limit → circuit-break → dispatch → classify → retry →
 *   validate response → return body
 */

import { randomUUID } from 'node:crypto';
import {
  ContractViolationError,
  HttpStatusError,
  RequestAbortedError,
  TransportError,
} from '../errors.js';
import { AxiosTransport } from '../http/axios-transport.js';
import { buildPath } from '../http/path.js';
import { joinUrl, type Transport } from '../http/transport.js';
import {
  CircuitBreakerRegistry,
} from '../middleware/circuit.js';
import { RateLimiterRegistry } from '../middleware/rate-limit.js';
import {
  DEFAULT_RETRY_OPTIONS,
  isRetryableError,
  retryDelayFor,
  sleep,
  type ResolvedRetryOptions,
} from '../middleware/retry.js';
import type { AuthResolver } from '../middleware/auth.js';
import { assertNoIssues, splitArgs, validateParams } from '../validation/validate.js';
import { validateResponse } from '../validation/response.js';
import type { AnyParamSpec } from './params.js';
import type {
  ContractArgs,
  ContractDefinition,
  ContractReturn,
} from './contract.js';
import {
  BODY_METHODS,
  type CircuitOptions,
  type MetaOptions,
  type RateLimitOptions,
  type RequestContext,
  type RequestHook,
  type ResponseContext,
  type ResponseHook,
  type RetryOptions,
} from '../types.js';

/* -------------------------------------------------------------------------- */
/* Public option types                                                         */
/* -------------------------------------------------------------------------- */

export type ApiContracts = Record<string, ContractDefinition<any, any>>;

export interface ApiOptions<C extends ApiContracts = ApiContracts> {
  /** Name used in error messages and `describe()` output. */
  name?: string;
  /** Base URL every route is resolved against. */
  base: string;
  /** Headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** Hook fired before auth on every attempt (signing, telemetry, ...). */
  beforeRequest?: RequestHook;
  /** Hook fired on every successful (contract-satisfying) response. */
  afterResponse?: ResponseHook;
  /** Auth resolver applied to every request (skip with `_skipAuth`). */
  auth?: AuthResolver;
  /** Default retry policy for all contracts. */
  retry?: RetryOptions;
  /** Circuit-breaker settings; `false` disables breaking entirely. */
  circuit?: CircuitOptions | false;
  /** Client-side rate-limit pacing; `false` disables pacing. */
  rateLimit?: RateLimitOptions | false;
  /** Default timeout in milliseconds for all contracts. */
  timeout?: number;
  /** Header used for idempotency keys. Default `Idempotency-Key`. */
  idempotencyHeader?: string;
  /** The contracts — one client method is derived per entry. */
  contracts: C;
}

export interface ClientOptions {
  base?: string;
  headers?: Record<string, string>;
  auth?: AuthResolver;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  circuit?: CircuitOptions | false;
  rateLimit?: RateLimitOptions | false;
  /** Custom transport (testing hook — see `MockTransport` in tests). */
  transport?: Transport;
  /** Extra configuration forwarded to the axios instance. */
  axios?: import('axios').AxiosRequestConfig;
  beforeRequest?: RequestHook;
  afterResponse?: ResponseHook;
}

/* -------------------------------------------------------------------------- */
/* Derived method types                                                        */
/* -------------------------------------------------------------------------- */

type RequiredArgKeys<A> = { [K in keyof A]-?: undefined extends A[K] ? never : K }[keyof A];

type MethodParams<A> = [RequiredArgKeys<A>] extends [never]
  ? [args?: A & MetaOptions]
  : [args: A & MetaOptions];

/**
 * The callable produced for each contract. Accepts the inferred argument
 * object (merged with per-call `_meta` options) and resolves to the
 * contract's declared return type.
 */
export interface ContractMethod<R = unknown, A = Record<string, never>> {
  (...args: MethodParams<A>): Promise<R>;
  /** The contract definition this method was derived from. */
  readonly contract: ContractDefinition<R, A>;
}

/** Introspection surface available on every client instance. */
export interface ApiClientBase {
  readonly apiName: string;
  /** Renders all contracts (or a single one) as a readable description. */
  describe(name?: string): string;
}

export type ApiClientInstance<C extends ApiContracts> = {
  [K in keyof C]: ContractMethod<ContractReturn<C[K]>, ContractArgs<C[K]>>;
} & ApiClientBase;

export interface ApiClientConstructor<C extends ApiContracts> {
  new (options?: ClientOptions): ApiClientInstance<C>;
  /** The contract map this class was derived from. */
  readonly contracts: C;
  readonly apiName: string;
  describe(): string;
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

interface PreparedRequest {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  timeout?: number;
  retries: number;
  retryBaseDelay: number;
  meta: MetaOptions;
}

function appendQuery(query: URLSearchParams, name: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      query.append(name, serializeQueryValue(item));
    }
    return;
  }
  query.set(name, serializeQueryValue(value));
}

function serializeQueryValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function cloneBody(body: unknown): unknown {
  if (body === undefined || body === null) return body;
  try {
    return structuredClone(body);
  } catch {
    return body;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || 'relative';
  } catch {
    return 'relative';
  }
}

/** Wraps axios-style cancellations into {@link RequestAbortedError}. */
function normalizeAbortLike(err: unknown): unknown {
  if (err instanceof RequestAbortedError) return err;
  if (
    err instanceof Error &&
    (err.name === 'CanceledError' ||
      err.name === 'AbortError' ||
      (err as Error & { code?: string }).code === 'ERR_CANCELED')
  ) {
    return new RequestAbortedError('Request aborted through AbortSignal', err);
  }
  return err;
}

function mergeCircuit(
  apiOpt: CircuitOptions | false | undefined,
  clientOpt: CircuitOptions | false | undefined,
): CircuitOptions | false | undefined {
  if (clientOpt === false) return false;
  if (clientOpt !== undefined) return clientOpt;
  return apiOpt;
}

function mergeRateLimit(
  apiOpt: RateLimitOptions | false | undefined,
  clientOpt: RateLimitOptions | false | undefined,
): RateLimitOptions | false | undefined {
  if (clientOpt === false) return false;
  if (clientOpt !== undefined) return clientOpt;
  return apiOpt;
}

/**
 * Defines an API client class from a set of contracts.
 *
 * ```ts
 * export const GitHubApi = defineApi({
 *   name: 'GitHubApi',
 *   base: 'https://api.github.com',
 *   contracts: {
 *     listUsers: contract('GET /users', {
 *       params: { page: P.integer({ default: 1 }) },
 *       responds: [{ status: 200, type: 'array' }],
 *     }),
 *   },
 * });
 *
 * const github = new GitHubApi();
 * const users = await github.listUsers({ page: 2 });
 * ```
 */
export function defineApi<C extends ApiContracts>(
  options: ApiOptions<C>,
): ApiClientConstructor<C> {
  const apiName = options.name ?? 'api';

  class ApiClient implements ApiClientBase {
    readonly apiName = apiName;

    readonly #base: string;
    readonly #headers: Record<string, string>;
    readonly #defaultTimeout: number | undefined;
    readonly #transport: Transport;
    readonly #auth: AuthResolver | undefined;
    readonly #beforeRequest: RequestHook | undefined;
    readonly #afterResponse: ResponseHook | undefined;
    readonly #retry: ResolvedRetryOptions;
    readonly #breakers: CircuitBreakerRegistry | undefined;
    readonly #limiters: RateLimiterRegistry | undefined;
    readonly #idempotencyHeader: string;

    constructor(clientOptions: ClientOptions = {}) {
      this.#base = clientOptions.base ?? options.base;
      this.#headers = {
        ...(options.defaultHeaders ?? {}),
        ...(clientOptions.headers ?? {}),
      };
      this.#defaultTimeout = clientOptions.timeout ?? options.timeout;
      this.#auth = clientOptions.auth ?? options.auth;
      this.#beforeRequest = clientOptions.beforeRequest ?? options.beforeRequest;
      this.#afterResponse = clientOptions.afterResponse ?? options.afterResponse;
      this.#retry = {
        ...DEFAULT_RETRY_OPTIONS,
        ...(options.retry ?? {}),
        retries: clientOptions.retries ?? options.retry?.retries ?? DEFAULT_RETRY_OPTIONS.retries,
        baseDelay:
          clientOptions.retryDelay ?? options.retry?.baseDelay ?? DEFAULT_RETRY_OPTIONS.baseDelay,
      };

      const circuit = mergeCircuit(options.circuit, clientOptions.circuit);
      this.#breakers = circuit === false ? undefined : new CircuitBreakerRegistry(circuit ?? {});
      const rateLimit = mergeRateLimit(options.rateLimit, clientOptions.rateLimit);
      this.#limiters =
        rateLimit === false ? undefined : rateLimit ? new RateLimiterRegistry(rateLimit) : undefined;
      this.#idempotencyHeader = options.idempotencyHeader ?? 'Idempotency-Key';
      this.#transport = clientOptions.transport ?? new AxiosTransport(clientOptions.axios);

      for (const [name, def] of Object.entries(options.contracts)) {
        const method = ((args?: Record<string, unknown>) =>
          this.#dispatch(name, def, args)) as ContractMethod<any, any>;
        Object.defineProperty(method, 'contract', {
          value: def,
          enumerable: false,
          writable: false,
        });
        Object.defineProperty(this, name, {
          value: method,
          enumerable: true,
          writable: false,
          configurable: true,
        });
      }
    }

    describe(name?: string): string {
      return name ? describeContract(apiName, options.contracts[name]) : describeApi(apiName, options);
    }

    async #dispatch(
      name: string,
      def: ContractDefinition<any, any>,
      rawArgs: Record<string, unknown> | undefined,
    ): Promise<unknown> {
      const specs = def.options.params ?? {};

      // 1. Closed-schema validation: unknown keys, coercion, constraints.
      const { params, meta, issues: unknownIssues } = splitArgs(specs, rawArgs);
      const validation = validateParams(specs, params);
      const issues = [...unknownIssues, ...validation.issues];
      if (issues.length > 0) {
        throw new ContractViolationError(issues);
      }

      // 2. Path building.
      const { path, consumed } = buildPath(def.route.template, validation.values);

      // 3. Parameter placement.
      const query = new URLSearchParams();
      const headers: Record<string, string> = { ...this.#headers, ...(meta._headers ?? {}) };
      let body: Record<string, unknown> | undefined;

      for (const [paramName, spec] of Object.entries(specs) as [string, AnyParamSpec][]) {
        if (paramName in consumed) continue;
        const value = validation.values[paramName];
        if (value === undefined) continue;
        const wireName = spec.as ?? paramName;
        const location =
          spec.in && spec.in !== 'auto'
            ? spec.in
            : def.route.pathParams.includes(paramName)
              ? 'path'
              : BODY_METHODS.includes(def.route.method)
                ? 'body'
                : 'query';

        if (location === 'query') {
          appendQuery(query, wireName, value);
        } else if (location === 'body') {
          body ??= {};
          body[wireName] = value;
        } else if (location === 'header') {
          headers[wireName] = String(value);
        }
      }

      if (meta._query) {
        const extra =
          meta._query instanceof URLSearchParams
            ? [...meta._query.entries()]
            : Object.entries(meta._query).flatMap(([k, v]) =>
                Array.isArray(v) ? v.map((item) => [k, item] as [string, string]) : [[k, String(v)] as [string, string]],
              );
        for (const [k, v] of extra) query.set(k, v);
      }

      // 4. Idempotency key.
      const idem = def.options.idempotent;
      if (idem) {
        const header = typeof idem === 'object' ? idem.header : this.#idempotencyHeader;
        headers[header] ??= meta._idempotencyKey ?? randomUUID();
      }

      // 5. Resolve per-call knobs.
      const timeout = meta._timeout ?? def.options.timeout ?? this.#defaultTimeout;
      const retries = meta._retries ?? def.options.retries ?? this.#retry.retries;
      const retryBaseDelay = meta._retryDelay ?? def.options.retryDelay ?? this.#retry.baseDelay;

      const base = meta._baseUrl ?? this.#base;
      const url = joinUrl(base, path);

      return this.#execute(name, def, {
        method: def.route.method,
        path,
        url,
        headers,
        query,
        body,
        timeout,
        retries,
        retryBaseDelay,
        meta,
      });
    }

    async #execute(
      name: string,
      def: ContractDefinition<any, any>,
      prepared: PreparedRequest,
    ): Promise<unknown> {
      const maxAttempts = 1 + Math.max(0, prepared.retries);
      const retryOptions: ResolvedRetryOptions = {
        ...this.#retry,
        baseDelay: prepared.retryBaseDelay,
        retries: prepared.retries,
      };
      const host = hostOf(prepared.url);
      let authRefreshed = false;

      for (let attempt = 0; ; attempt++) {
        if (this.#breakers) {
          await this.#breakers.beforeRequest(host);
        }
        if (this.#limiters) {
          await this.#limiters.for(host).acquire();
        }

        // Fresh, mutation-safe copies per attempt (hooks/auth may edit them).
        const ctx: RequestContext = {
          api: apiName,
          contract: name,
          method: def.route.method,
          path: prepared.path,
          url: prepared.url,
          attempt,
          headers: { ...prepared.headers },
          query: new URLSearchParams(prepared.query.toString()),
          body: cloneBody(prepared.body),
          meta: prepared.meta,
        };

        try {
          await this.#beforeRequest?.(ctx);
          if (!prepared.meta._skipAuth && this.#auth) {
            await this.#auth({
              headers: ctx.headers,
              query: ctx.query,
              request: {
                transport: 'http',
                method: ctx.method,
                path: ctx.path,
                url: ctx.url,
                operationId: ctx.contract,
                attempt,
                scopes: def.options.security ? [...def.options.security] : undefined,
              },
            });
          }

          const attemptStartedAt = Date.now();
          const res = await this.#transport.send({
            method: def.route.method,
            url: ctx.url,
            headers: ctx.headers,
            query: ctx.query,
            body: ctx.body,
            timeout: prepared.timeout,
            signal: prepared.meta._signal,
          });

          // The host answered — breaker sees a success regardless of status.
          this.#breakers?.recordSuccess(host);

          // Refresh-and-retry: on a single 401, ask the provider whether a
          // retry is warranted (AuthProvider.handleUnauthorized bridges
          // here) and retry at most once. Legacy providers without the
          // async hook fall back to invalidate() + unconditional retry.
          const provider = this.#auth?.provider;
          if (
            res.status === 401 &&
            provider &&
            !authRefreshed &&
            !prepared.meta._skipAuth
          ) {
            authRefreshed = true;
            if (provider.onUnauthorized) {
              const shouldRetry = await provider.onUnauthorized({
                url: ctx.url,
                method: ctx.method,
                path: ctx.path,
                operationId: ctx.contract,
                attempt,
                scopes: def.options.security ? [...def.options.security] : undefined,
              });
              if (shouldRetry) continue;
            } else {
              provider.invalidate?.(this.#auth?.lastToken?.());
              continue;
            }
          }

          const outcome = validateResponse(def.options.responds, res);
          const responseCtx: ResponseContext = {
            request: ctx,
            status: res.status,
            headers: res.headers,
            body: outcome.body,
            durationMs: Date.now() - attemptStartedAt,
            attempt,
          };
          await this.#afterResponse?.(responseCtx);
          return outcome.body;
        } catch (err) {
          // Normalize transport-level cancellations even if a custom
          // transport forgets to map them.
          const normalized = normalizeAbortLike(err);
          if (normalized instanceof RequestAbortedError) {
            this.#breakers?.recordAbort(host);
            throw normalized;
          }

          // Retryable transport failures (network / timeout / 5xx) count
          // against the circuit breaker; answered 4xx do not.
          if (
            err instanceof TransportError ||
            (err instanceof HttpStatusError && err.status >= 500)
          ) {
            this.#breakers?.recordFailure(host);
          }

          const mayRetry = attempt + 1 < maxAttempts && isRetryableError(err, retryOptions.retryOn);
          if (!mayRetry) {
            throw err;
          }

          await sleep(retryDelayFor(err, attempt, retryOptions), prepared.meta._signal);
        }
      }
    }
  }

  const ctor = ApiClient as unknown as ApiClientConstructor<C>;
  Object.defineProperty(ctor, 'contracts', {
    value: options.contracts,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(ctor, 'apiName', {
    value: apiName,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(ctor, 'describe', {
    value: () => describeApi(apiName, options),
    enumerable: false,
    writable: false,
  });
  return ctor;
}

/* -------------------------------------------------------------------------- */
/* Introspection                                                               */
/* -------------------------------------------------------------------------- */

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function describeParam(name: string, spec: AnyParamSpec): string {
  const bits: string[] = [spec.kind];
  if (spec.required) bits.push('required');
  if (spec.default !== undefined) bits.push(`default ${JSON.stringify(spec.default)}`);
  if (spec.inclusion) bits.push(`inclusion ${JSON.stringify(spec.inclusion)}`);
  if (spec.min !== undefined) bits.push(`min ${spec.min}`);
  if (spec.max !== undefined) bits.push(`max ${spec.max}`);
  if (spec.length !== undefined) {
    bits.push(
      typeof spec.length === 'number'
        ? `length ${spec.length}`
        : `length ${spec.length.min ?? 0}..${spec.length.max ?? '∞'}`,
    );
  }
  if (spec.pattern) bits.push(`pattern ${String(spec.pattern)}`);
  if (spec.as) bits.push(`as ${JSON.stringify(spec.as)}`);
  if (spec.in && spec.in !== 'auto') bits.push(`in ${spec.in}`);
  if (spec.of) bits.push('of <param>');
  return `      ${pad(name, 18)} ${bits.join(', ')}`;
}

function describeContract(apiName: string, def: ContractDefinition<any, any> | undefined): string {
  if (!def) return `No such contract on ${apiName}.`;
  const lines: string[] = [];
  lines.push(`${def.route.method} ${def.route.template}`);
  if (def.options.description) lines.push(`  ${def.options.description}`);
  const specs = def.options.params ?? {};
  const entries = Object.entries(specs);
  if (entries.length > 0) {
    lines.push('    params:');
    for (const [name, spec] of entries) lines.push(describeParam(name, spec));
  }
  const responds = def.options.responds;
  if (responds && responds.length > 0) {
    lines.push(
      `    responds: ${responds
        .map((r) => `${r.status}${r.type ? ` (${r.type})` : ''}`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

function describeApi(apiName: string, options: ApiOptions): string {
  const lines: string[] = [`${apiName} (${options.base})`];
  const entries = Object.entries(options.contracts);
  if (entries.length === 0) {
    lines.push('  (no contracts declared)');
  }
  for (const [name, def] of entries) {
    lines.push(`  ${pad(name, 24)} ${pad(def.route.method, 7)} ${def.route.template}`);
  }
  return lines.join('\n');
}

export { assertNoIssues };
