/**
 * Request validation engine.
 *
 * Contracts describe *closed* request schemas: only declared parameters are
 * accepted, unknown keys are rejected before any HTTP traffic, and every
 * declared value is coerced and checked against its constraints. Responses
 * on the other hand stay *open* — unknown response fields are data, not
 * errors (see `validation/response.ts`).
 */

import { ContractViolationError, type Violation } from '../errors.js';
import type { AnyParamSpec, ParamsShape } from '../dsl/params.js';
import type { MetaOptions } from '../types.js';

export interface ValidationResult {
  ok: boolean;
  /** Coerced values keyed by TypeScript parameter name. */
  values: Record<string, unknown>;
  /** Every constraint that failed, in declaration order. */
  issues: Violation[];
}

/** Meta options (underscore-prefixed) recognized per call. */
const KNOWN_META_KEYS = new Set<keyof MetaOptions>([
  '_headers',
  '_query',
  '_timeout',
  '_retries',
  '_retryDelay',
  '_idempotencyKey',
  '_skipAuth',
  '_signal',
  '_baseUrl',
]);

/**
 * Splits a call's arguments into declared params, recognized meta options,
 * and unknown keys. Unknown keys produce violations (closed request schema);
 * unknown underscore keys get a dedicated message naming the legal meta keys.
 */
export function splitArgs(
  specs: ParamsShape,
  input: Record<string, unknown> | undefined,
): {
  params: Record<string, unknown>;
  meta: MetaOptions;
  issues: Violation[];
} {
  const params: Record<string, unknown> = {};
  const meta: MetaOptions = {};
  const issues: Violation[] = [];

  for (const [key, value] of Object.entries(input ?? {})) {
    if (key.startsWith('_')) {
      if (KNOWN_META_KEYS.has(key as keyof MetaOptions)) {
        (meta as Record<string, unknown>)[key] = value;
      } else {
        issues.push({
          param: key,
          rule: 'unknownMeta',
          message: `is not a recognized meta option (allowed: ${[...KNOWN_META_KEYS].join(', ')})`,
          value,
        });
      }
      continue;
    }
    if (key in specs) {
      params[key] = value;
    } else {
      issues.push({
        param: key,
        rule: 'unknown',
        message: 'is not declared in this contract',
        value,
      });
    }
  }

  return { params, meta, issues };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerces a raw value into the spec's type. Returns `{ ok, value }`; on
 * failure `message` explains what went wrong.
 */
function coerce(
  name: string,
  spec: AnyParamSpec,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (spec.kind) {
    case 'string':
      if (typeof raw === 'string') return { ok: true, value: raw };
      if (typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: String(raw) };
      return { ok: false, message: `expected a string, got ${typeof raw}` };
    case 'integer': {
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
          return { ok: false, message: `expected an integer, got ${raw}` };
        }
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim())) {
        return { ok: true, value: Number.parseInt(raw.trim(), 10) };
      }
      return { ok: false, message: `expected an integer, got ${JSON.stringify(raw)}` };
    }
    case 'float': {
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return { ok: false, message: `expected a finite number, got ${raw}` };
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
        return { ok: true, value: Number(raw) };
      }
      return { ok: false, message: `expected a number, got ${JSON.stringify(raw)}` };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, message: `expected a boolean or "true"/"false", got ${JSON.stringify(raw)}` };
    }
    case 'array':
      if (Array.isArray(raw)) return { ok: true, value: raw };
      return { ok: false, message: `expected an array, got ${typeof raw}` };
    case 'hash':
      if (isPlainObject(raw)) return { ok: true, value: raw };
      return { ok: false, message: `expected an object, got ${typeof raw}` };
    case 'custom': {
      const check = spec.check;
      if (typeof check !== 'function') {
        return { ok: false, message: 'custom validator is missing' };
      }
      const outcome = check(raw);
      if (outcome === true) return { ok: true, value: raw };
      return { ok: false, message: typeof outcome === 'string' ? outcome : 'failed custom validation' };
    }
    default:
      return { ok: false, message: `unknown parameter kind ${String(spec.kind)}` };
  }
}

function checkLength(value: string | unknown[], constraint: number | { min?: number; max?: number }): string | null {
  const n = value.length;
  if (typeof constraint === 'number') {
    return n === constraint ? null : `must have exactly ${constraint} element(s), got ${n}`;
  }
  if (constraint.min !== undefined && n < constraint.min) {
    return `must have at least ${constraint.min} element(s), got ${n}`;
  }
  if (constraint.max !== undefined && n > constraint.max) {
    return `must have at most ${constraint.max} element(s), got ${n}`;
  }
  return null;
}

/** Validates a single (already coerced) value against the spec constraints. */
function checkConstraints(
  name: string,
  spec: AnyParamSpec,
  value: unknown,
  issues: Violation[],
  label = name,
): void {
  const push = (rule: string, message: string): void => {
    issues.push({ param: label, rule, message, value });
  };

  if (spec.inclusion !== undefined && !spec.inclusion.some((allowed) => allowed === value)) {
    push('inclusion', `must be one of ${JSON.stringify(spec.inclusion)}, got ${JSON.stringify(value)}`);
    return;
  }

  switch (spec.kind) {
    case 'string':
    case 'integer':
    case 'float':
      if (typeof value === 'number') {
        if (spec.min !== undefined && value < spec.min) push('min', `must be >= ${spec.min}, got ${value}`);
        if (spec.max !== undefined && value > spec.max) push('max', `must be <= ${spec.max}, got ${value}`);
      }
      if (typeof value === 'string') {
        if (spec.length !== undefined) {
          const problem = checkLength(value, spec.length);
          if (problem) push('length', problem);
        }
        if (spec.pattern !== undefined && !spec.pattern.test(value)) {
          push('pattern', `must match ${spec.pattern}, got ${JSON.stringify(value)}`);
        }
      }
      break;
    case 'array': {
      if (!Array.isArray(value)) break;
      if (spec.min !== undefined && value.length < spec.min) {
        push('min', `must have at least ${spec.min} element(s), got ${value.length}`);
      }
      if (spec.max !== undefined && value.length > spec.max) {
        push('max', `must have at most ${spec.max} element(s), got ${value.length}`);
      }
      if (spec.of) {
        for (let i = 0; i < value.length; i++) {
          validateOne(`${name}[${i}]`, spec.of, value[i], issues);
        }
      }
      break;
    }
    case 'hash': {
      const keys = Object.keys(value as Record<string, unknown>).length;
      if (spec.min !== undefined && keys < spec.min) push('min', `must have at least ${spec.min} key(s), got ${keys}`);
      if (spec.max !== undefined && keys > spec.max) push('max', `must have at most ${spec.max} key(s), got ${keys}`);
      break;
    }
    default:
      break;
  }
}

function validateOne(name: string, spec: AnyParamSpec, raw: unknown, issues: Violation[]): unknown | undefined {
  // `null` and `undefined` mean "not provided" (mirrors contractful's nil).
  if (raw === undefined || raw === null) {
    if (spec.default !== undefined) {
      const coercedDefault = coerce(name, spec, spec.default);
      if (!coercedDefault.ok) {
        issues.push({ param: name, rule: 'default', message: `default value is invalid: ${coercedDefault.message}`, value: spec.default });
        return undefined;
      }
      checkConstraints(name, spec, coercedDefault.value, issues);
      return coercedDefault.value;
    }
    if (spec.required) {
      issues.push({ param: name, rule: 'required', message: 'is required but was not provided', value: undefined });
    }
    return undefined;
  }

  const coerced = coerce(name, spec, raw);
  if (!coerced.ok) {
    issues.push({ param: name, rule: spec.kind, message: coerced.message, value: raw });
    return undefined;
  }
  checkConstraints(name, spec, coerced.value, issues);
  return coerced.value;
}

/**
 * Validates and coerces a full argument object against a contract's params.
 * Collects *every* violation (not just the first) so callers see the complete
 * picture of what went wrong.
 */
export function validateParams(
  specs: ParamsShape,
  input: Record<string, unknown> | undefined,
): ValidationResult {
  const values: Record<string, unknown> = {};
  const issues: Violation[] = [];

  for (const [name, spec] of Object.entries(specs)) {
    // Absent optionals stay `undefined`; the placement step skips them.
    values[name] = validateOne(name, spec, input?.[name], issues);
  }

  return { ok: issues.length === 0, values, issues };
}

/** Throws a {@link ContractViolationError} when `issues` is non-empty. */
export function assertNoIssues(issues: Violation[]): void {
  if (issues.length > 0) {
    throw new ContractViolationError(issues);
  }
}
