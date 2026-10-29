/**
 * Parameter DSL — the TypeScript equivalent of contractful's
 * `param :name, Type, **constraints` declarations.
 *
 * Every factory returns a {@link ParamSpec} that carries two phantom type
 * parameters (`__tsType` / `__required`) so the compiler can infer the exact
 * argument object produced by a contract, while the runtime uses `kind` plus
 * the constraint fields to coerce and validate values before any HTTP
 * traffic happens.
 */

export type ParamKind =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'array'
  | 'hash'
  | 'custom';

/**
 * Where a parameter is placed on the wire.
 * - `path`: substituted into the route template (`/repos/:owner`)
 * - `query`: appended to the query string
 * - `body`: sent in the JSON body
 * - `header`: sent as a request header
 * - `auto` (default): path params are consumed by the template, the rest go
 *   to the JSON body for methods that have one, or to the query string.
 */
export type ParamLocation = 'path' | 'query' | 'body' | 'header' | 'auto';

export interface LengthConstraint {
  min?: number;
  max?: number;
}

export interface CommonParamOptions {
  /** Marks the parameter as mandatory. Mutually exclusive with `default`. */
  required?: boolean;
  /** Value used when the caller omits the parameter. */
  default?: unknown;
  /** Wire name when it differs from the TypeScript name (e.g. `per_page`). */
  as?: string;
  /** Forces the wire placement of this parameter. */
  in?: ParamLocation;
  /** Human-readable documentation, surfaced by `describe()`. */
  describe?: string;
}

export interface StringParamOptions extends CommonParamOptions {
  /** Restricts the value to a fixed set of strings. */
  inclusion?: readonly string[];
  /** Exact length, or `{ min, max }` bounds. */
  length?: number | LengthConstraint;
  /** The value must match this pattern (uses `RegExp.test`). */
  pattern?: RegExp;
}

export interface NumberParamOptions extends CommonParamOptions {
  /** Restricts the value to a fixed set of numbers. */
  inclusion?: readonly number[];
  /** Minimum value. */
  min?: number;
  /** Maximum value. */
  max?: number;
}

export interface ArrayParamOptions extends CommonParamOptions {
  /** Minimum number of elements. */
  min?: number;
  /** Maximum number of elements. */
  max?: number;
  /** Element spec — every element is validated against it. */
  of?: AnyParamSpec;
}

export interface HashParamOptions extends CommonParamOptions {
  /** Minimum number of keys. */
  min?: number;
  /** Maximum number of keys. */
  max?: number;
}

export interface CustomParamOptions extends CommonParamOptions {
  /**
   * User-supplied validator. Return `true` when the value is acceptable,
   * or a string with an error message when it is not.
   */
  check: (value: unknown) => true | string;
}

/**
 * Runtime shape of a parameter declaration. The `__tsType` and `__required`
 * fields are phantom markers (never assigned at runtime beyond their
 * `undefined` defaults) used purely for compile-time inference.
 */
export interface ParamSpec<T = unknown, R extends boolean = false> {
  readonly kind: ParamKind;
  readonly required?: boolean;
  readonly default?: T;
  readonly as?: string;
  readonly in?: ParamLocation;
  readonly describe?: string;
  readonly inclusion?: readonly unknown[];
  readonly length?: number | LengthConstraint;
  readonly pattern?: RegExp;
  readonly min?: number;
  readonly max?: number;
  readonly of?: AnyParamSpec;
  readonly check?: (value: unknown) => true | string;
  readonly __tsType?: T;
  readonly __required?: R;
}

export type AnyParamSpec = ParamSpec<any, any>;

export type ParamsShape = Record<string, AnyParamSpec>;

/* -------------------------------------------------------------------------- */
/* Factories                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Declares a string parameter.
 *
 * ```ts
 * params.string({ as: 'sort', inclusion: ['asc', 'desc'], default: 'asc' })
 * ```
 */
export function string<R extends boolean = false>(
  options: StringParamOptions & { required?: R } = {},
): ParamSpec<string, R> {
  return { kind: 'string', ...options } as ParamSpec<string, R>;
}

/**
 * Declares an integer parameter. Numeric strings such as `"42"` are coerced.
 *
 * ```ts
 * params.integer({ as: 'per_page', min: 1, max: 100, default: 30 })
 * ```
 */
export function integer<R extends boolean = false>(
  options: NumberParamOptions & { required?: R } = {},
): ParamSpec<number, R> {
  return { kind: 'integer', ...options } as ParamSpec<number, R>;
}

/**
 * Declares a float parameter. Numeric strings such as `"0.5"` are coerced.
 *
 * ```ts
 * params.float({ min: 0, max: 1 })
 * ```
 */
export function float<R extends boolean = false>(
  options: NumberParamOptions & { required?: R } = {},
): ParamSpec<number, R> {
  return { kind: 'float', ...options } as ParamSpec<number, R>;
}

/**
 * Declares a boolean parameter. The strings `"true"` / `"false"` are coerced.
 */
export function boolean<R extends boolean = false>(
  options: CommonParamOptions & { required?: R } = {},
): ParamSpec<boolean, R> {
  return { kind: 'boolean', ...options } as ParamSpec<boolean, R>;
}

/**
 * Declares an array parameter with an optional element spec.
 *
 * ```ts
 * params.array({ of: params.string(), min: 1 })
 * ```
 */
export function array<S extends AnyParamSpec | undefined = undefined, R extends boolean = false>(
  options: ArrayParamOptions & { required?: R; of?: S } = {},
): ParamSpec<S extends AnyParamSpec ? Array<S['__tsType']> : unknown[], R> {
  return { kind: 'array', ...options } as any;
}

/**
 * Declares a free-form object parameter (contractful's `Hash`).
 *
 * ```ts
 * params.hash({ as: 'metadata' })
 * ```
 */
export function hash<R extends boolean = false>(
  options: HashParamOptions & { required?: R } = {},
): ParamSpec<Record<string, unknown>, R> {
  return { kind: 'hash', ...options } as ParamSpec<Record<string, unknown>, R>;
}

/**
 * Declares a custom-typed parameter validated by a user function.
 *
 * ```ts
 * params.custom<Date>((v) => v instanceof Date || 'expected a Date')
 * ```
 */
export function custom<T, R extends boolean = false>(
  check: (value: unknown) => true | string,
  options: Omit<CustomParamOptions, 'check'> & { required?: R } = {},
): ParamSpec<T, R> {
  return { kind: 'custom', check, ...options } as ParamSpec<T, R>;
}

/**
 * Namespace bundling every parameter factory, so contracts read compactly:
 *
 * ```ts
 * contract('GET /users', { params: { page: P.integer({ default: 1 }) } })
 * ```
 */
export const params = { string, integer, float, boolean, array, hash, custom };

/** Short alias for {@link params}. */
export const P = params;

/* -------------------------------------------------------------------------- */
/* Type-level inference helpers                                                */
/* -------------------------------------------------------------------------- */

/** Flattens an intersection type for nicer hover / error messages. */
export type Pretty<T> = { [K in keyof T]: T[K] } & {};

type RequiredParamKeys<P extends ParamsShape> = {
  [K in keyof P]-?: P[K] extends { __required: true } ? K : never;
}[keyof P];

type OptionalParamKeys<P extends ParamsShape> = {
  [K in keyof P]-?: P[K] extends { __required: true } ? never : K;
}[keyof P];

/**
 * Computes the argument object a contract expects from its param specs:
 * required params become required keys, everything else becomes optional.
 */
export type InferArgs<P extends ParamsShape> = Pretty<
  { [K in RequiredParamKeys<P>]: NonNullable<P[K]['__tsType']> } &
    { [K in OptionalParamKeys<P>]?: NonNullable<P[K]['__tsType']> }
>;
