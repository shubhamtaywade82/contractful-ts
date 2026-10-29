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
import type { ResponseDecl } from '../types.js';

export interface ContractOptions<P extends ParamsShape> {
  /** Typed parameter declarations. */
  params?: P;
  /** Statuses (and optional top-level body types) the API answers with. */
  responds?: ResponseDecl[];
  /** Free-form documentation, surfaced by `describe()`. */
  description?: string;
  /** Organizational tags, used by `describe()` and tooling. */
  tags?: string[];
  /**
   * Marks the operation as idempotent: every call sends an
   * `Idempotency-Key` header (per-call override with `_idempotencyKey`).
   */
  idempotent?: boolean | { header: string };
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
  options: ContractOptions<P> = {},
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
  options: ContractOptions<P>,
): void {
  const specs = options.params ?? {};

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
