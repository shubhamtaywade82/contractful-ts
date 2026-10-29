/**
 * The `contract()` DSL — the TypeScript sibling of contractful's
 *
 * ```ruby
 * contract :list_users, 'GET /users' do
 *   param :page, Integer, default: 1
 *   responds 200, type: :array
 * end
 * ```
 *
 * A contract is pure data: the HTTP shape (verb + path template), typed
 * parameters, and the statuses the API is expected to answer with. All
 * behavior (validation, path building, auth, retries, ...) is derived from
 * that data by `defineApi`.
 */

import { ContractDefinitionError } from '../errors.js';
import { parseRoute, type ParsedRoute } from '../http/path.js';
import type { AnyParamSpec, InferArgs, ParamsShape } from './params.js';
import type { ContractRetryMode, ResponseDecl } from '../types.js';

/**
 * A `responds` entry carrying a phantom return type. `returns<T>(...)` stamps
 * it so `contract(...)` can infer BOTH the argument object (from `params`)
 * and the method's return type (from `responds`) in the same call — the fix
 * for the limitation that pinning `contract<T>(...)` disables argument
 * inference (supplying an explicit type argument makes TypeScript skip
 * inference for every remaining type parameter).
 */
export interface ReturnTypedDecl<R = unknown> extends ResponseDecl {
  readonly __returnType?: R;
}

/**
 * Pins a contract's return type through its `responds` list, keeping full
 * argument-type inference:
 *
 * ```ts
 * contract('GET /users', {
 *   params: { since: P.integer() },
 *   responds: returns<User[]>([{ status: 200, type: 'array' }]),
 * })
 * ```
 *
 * `contract<User[]>(...)` remains supported for simple cases, but there the
 * params generic falls back to its default (open index-signature args) —
 * prefer `returns<T>(...)` whenever you pin a return type on a contract
 * that declares params.
 */
export function returns<R>(decls: ResponseDecl[]): ReturnTypedDecl<R>[] {
  return decls as ReturnTypedDecl<R>[];
}

export interface ContractOptions<P extends ParamsShape, R = unknown> {
  /** Typed parameter declarations. */
  params?: P;
  /** Statuses (and optional top-level body types) the API answers with. */
  responds?: Array<ResponseDecl & { readonly __returnType?: R }>;
  /** Free-form documentation, surfaced by `describe()`. */
  description?: string;
  /** Organizational tags, used by `describe()` and tooling. */
  tags?: string[];
  /**
   * Marks the operation as idempotent: every call sends an
   * `Idempotency-Key` header (per-call override with `_idempotencyKey`),
   * kept STABLE across retry attempts, and ambiguous failures (network
   * errors, timeouts, 5xx) become retryable for this contract — the key is
   * the enforced-duplication mechanism that makes the retry safe.
   */
  idempotent?: boolean | { header: string };
  /**
   * Retry eligibility for this contract:
   * - `'auto'` (default) — retry only when the method is inherently
   *   idempotent (GET/HEAD/OPTIONS/PUT/DELETE), the contract is `idempotent`,
   *   an explicit `_idempotencyKey` is supplied, or the API opted in with
   *   `retry.retryUnsafeMethods`.
   * - `'always'` — explicit opt-in: retry this contract after ambiguous
   *   failures regardless of method.
   * - `'never'` — no retries at all, not even server-sanctioned 429s.
   */
  retry?: ContractRetryMode;
  /**
   * Sends body parameters as `application/x-www-form-urlencoded` instead of
   * JSON (Swagger 2.0 `formData`, HTML form APIs). Multipart file uploads
   * are not supported by this flag.
   */
  form?: boolean;
  /**
   * Guarantees a body is sent (an empty `{}` / empty form) even when every
   * body parameter is optional and none was provided — for specs that mark
   * the request body as required while leaving all its properties optional.
   */
  bodyRequired?: boolean;
  /** Per-contract timeout in milliseconds. */
  timeout?: number;
  /** Per-contract retry budget. */
  retries?: number;
  /** Per-contract base retry delay in milliseconds. */
  retryDelay?: number;
  /**
   * Security requirement(s) forwarded to the auth provider (e.g. OAuth
   * scopes) — generated from OpenAPI `security` / AsyncAPI `security`.
   * Purely declarative metadata: the resolver decides what to do with it.
   */
  security?: readonly string[];
}

/** A contract value: route + options plus phantom types for inference. */
export interface ContractDefinition<R = unknown, A = Record<string, never>> {
  readonly __contractful: 'contract';
  readonly route: ParsedRoute;
  readonly options: ContractOptions<ParamsShape>;
  /** Phantom: the method's return type. */
  readonly __returnType: R;
  /** Phantom: the method's argument type. */
  readonly __argsType: A;
}

/**
 * Declares one endpoint of an API.
 *
 * ```ts
 * contract('GET /users/:id', {
 *   params: { id: params.integer({ required: true, min: 1 }) },
 *   responds: [{ status: 200, type: 'hash' }, { status: 404 }],
 * })
 * ```
 *
 * The optional type parameter pins the method's return type:
 *
 * ```ts
 * contract<User>('GET /users/:id', { ... })
 * ```
 */
export function contract<R = unknown, P extends ParamsShape = ParamsShape>(
  route: string,
  options: ContractOptions<P, R> = {},
): ContractDefinition<R, InferArgs<P>> {
  let parsed: ParsedRoute;
  try {
    parsed = parseRoute(route);
  } catch (err) {
    throw new ContractDefinitionError(
      `Invalid route ${JSON.stringify(route)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  validateContractShape(parsed, options);

  return {
    __contractful: 'contract',
    route: parsed,
    options: options as ContractOptions<ParamsShape>,
    __returnType: undefined as never,
    __argsType: undefined as never,
  };
}

/** Type-level: narrows a contract's inferred argument type. */
export type ContractArgs<D> = D extends ContractDefinition<any, infer A> ? A : never;
/** Type-level: narrows a contract's return type. */
export type ContractReturn<D> = D extends ContractDefinition<infer R, any> ? R : never;

function validateContractShape<P extends ParamsShape>(
  route: ParsedRoute,
  options: ContractOptions<P, any>,
): void {
  const specs = options.params ?? {};

  let rawBodyParams = 0;
  let regularBodyParams = 0;
  for (const [name, spec] of Object.entries(specs) as [string, AnyParamSpec][]) {
    if (spec.required && spec.default !== undefined) {
      throw new ContractDefinitionError(
        `Parameter ${JSON.stringify(name)} declares both required and default — pick one.`,
      );
    }
    if (spec.in === 'path' && !route.pathParams.includes(name)) {
      throw new ContractDefinitionError(
        `Parameter ${JSON.stringify(name)} is declared in: 'path' but the route ${JSON.stringify(route.template)} has no :${name} placeholder.`,
      );
    }
    if (spec.raw) {
      rawBodyParams++;
      const location = spec.in ?? 'auto';
      if (location !== 'body' && location !== 'auto') {
        throw new ContractDefinitionError(
          `Parameter ${JSON.stringify(name)} declares raw: true but is placed in ${JSON.stringify(location)} — raw params must be body parameters.`,
        );
      }
    } else if (spec.in === 'body') {
      regularBodyParams++;
    }
  }
  if (rawBodyParams > 1) {
    throw new ContractDefinitionError(
      'At most one raw body parameter may be declared — it replaces the entire request body.',
    );
  }
  if (rawBodyParams === 1 && regularBodyParams > 0) {
    throw new ContractDefinitionError(
      'A raw body parameter cannot be combined with regular body parameters — it replaces the entire request body.',
    );
  }

  if (options.retry !== undefined && !['auto', 'always', 'never'].includes(options.retry)) {
    throw new ContractDefinitionError(
      `Invalid retry mode ${JSON.stringify(options.retry)} — expected 'auto', 'always' or 'never'.`,
    );
  }

  for (const placeholder of route.pathParams) {
    if (!(placeholder in specs)) {
      throw new ContractDefinitionError(
        `Route ${JSON.stringify(route.template)} references :${placeholder} but no param named ${JSON.stringify(placeholder)} is declared.`,
      );
    }
  }

  const statuses = (options.responds ?? []).map((d) => d.status);
  if (new Set(statuses).size !== statuses.length) {
    throw new ContractDefinitionError(
      `Duplicate status declarations in responds: ${statuses.join(', ')}`,
    );
  }
}
