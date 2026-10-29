import { describe, expect, it } from 'vitest';
import {
  ContractViolationError,
  P,
  splitArgs,
  validateParams,
} from '../src/index.js';

describe('validateParams — coercion', () => {
  it('coerces numeric strings to integers', () => {
    const result = validateParams({ page: P.integer() }, { page: '42' });
    expect(result.ok).toBe(true);
    expect(result.values.page).toBe(42);
  });

  it('rejects non-integer numbers for integer params', () => {
    const result = validateParams({ n: P.integer() }, { n: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.rule).toBe('integer');
  });

  it('coerces float strings', () => {
    const result = validateParams({ x: P.float() }, { x: '0.25' });
    expect(result.ok).toBe(true);
    expect(result.values.x).toBe(0.25);
  });

  it('coerces boolean strings', () => {
    expect(validateParams({ b: P.boolean() }, { b: 'true' }).values.b).toBe(true);
    expect(validateParams({ b: P.boolean() }, { b: 'false' }).values.b).toBe(false);
    const bad = validateParams({ b: P.boolean() }, { b: 'yes' });
    expect(bad.ok).toBe(false);
  });

  it('coerces numbers and booleans to strings', () => {
    expect(validateParams({ s: P.string() }, { s: 1234 }).values.s).toBe('1234');
  });

  it('rejects arrays for hash params and vice versa', () => {
    expect(validateParams({ h: P.hash() }, { h: [1, 2] }).ok).toBe(false);
    expect(validateParams({ a: P.array() }, { a: { x: 1 } }).ok).toBe(false);
  });

  it('treats null as missing (contractful nil semantics)', () => {
    const result = validateParams({ s: P.string({ default: 'fallback' }) }, { s: null });
    expect(result.values.s).toBe('fallback');
  });
});

describe('validateParams — required / default', () => {
  it('flags missing required params', () => {
    const result = validateParams({ owner: P.string({ required: true }) }, {});
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ param: 'owner', rule: 'required' });
  });

  it('applies defaults when absent', () => {
    const result = validateParams({ perPage: P.integer({ default: 30 }) }, {});
    expect(result.values.perPage).toBe(30);
  });

  it('validates the default value itself', () => {
    const result = validateParams({ n: P.integer({ default: 999, max: 100 }) }, {});
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.rule).toBe('max');
  });

  it('keeps optional params absent when omitted', () => {
    const result = validateParams({ maybe: P.string() }, {});
    expect(result.ok).toBe(true);
    expect(result.values.maybe).toBeUndefined();
  });
});

describe('validateParams — constraints', () => {
  it('checks inclusion', () => {
    const ok = validateParams({ sort: P.string({ inclusion: ['asc', 'desc'] }) }, { sort: 'asc' });
    expect(ok.ok).toBe(true);
    const bad = validateParams({ sort: P.string({ inclusion: ['asc', 'desc'] }) }, { sort: 'up' });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]?.rule).toBe('inclusion');
  });

  it('checks min / max on numbers', () => {
    expect(validateParams({ n: P.integer({ min: 1, max: 100 }) }, { n: 100 }).ok).toBe(true);
    const bad = validateParams({ n: P.integer({ min: 1, max: 100 }) }, { n: 101 });
    expect(bad.issues[0]?.rule).toBe('max');
  });

  it('checks exact length on strings', () => {
    expect(validateParams({ s: P.string({ length: 3 }) }, { s: 'abc' }).ok).toBe(true);
    expect(validateParams({ s: P.string({ length: 3 }) }, { s: 'abcd' }).ok).toBe(false);
  });

  it('checks length ranges on strings', () => {
    const spec = P.string({ length: { min: 2, max: 4 } });
    expect(validateParams({ s: spec }, { s: 'a' }).ok).toBe(false);
    expect(validateParams({ s: spec }, { s: 'ab' }).ok).toBe(true);
    expect(validateParams({ s: spec }, { s: 'abcde' }).ok).toBe(false);
  });

  it('checks patterns', () => {
    const spec = P.string({ pattern: /^[A-Z]{2,10}$/ });
    expect(validateParams({ s: spec }, { s: 'BTCUSDT' }).ok).toBe(true);
    expect(validateParams({ s: spec }, { s: 'btc' }).ok).toBe(false);
  });

  it('checks array size and elements with indexed names', () => {
    const spec = P.array({ of: P.integer({ min: 0 }), min: 1, max: 3 });
    const bad = validateParams({ a: spec }, { a: [1, -5] });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]?.param).toBe('a[1]');
    expect(bad.issues[0]?.rule).toBe('min');
    const empty = validateParams({ a: spec }, { a: [] });
    expect(empty.issues[0]?.rule).toBe('min');
  });

  it('checks hash key counts', () => {
    const spec = P.hash({ min: 1, max: 2 });
    expect(validateParams({ h: spec }, { h: { a: 1 } }).ok).toBe(true);
    expect(validateParams({ h: spec }, { h: {} }).ok).toBe(false);
    expect(validateParams({ h: spec }, { h: { a: 1, b: 2, c: 3 } }).ok).toBe(false);
  });

  it('runs custom validators with error messages', () => {
    const spec = P.custom<Date>((v) => (v instanceof Date ? true : 'expected a Date instance'));
    expect(validateParams({ d: spec }, { d: new Date() }).ok).toBe(true);
    const bad = validateParams({ d: spec }, { d: '2020-01-01' });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]?.message).toBe('expected a Date instance');
  });

  it('collects every violation, not just the first', () => {
    const result = validateParams(
      {
        a: P.string({ required: true }),
        b: P.integer({ min: 10 }),
        c: P.string({ pattern: /^x/ }),
      },
      { b: 1, c: 'nope' },
    );
    expect(result.issues).toHaveLength(3);
  });
});

describe('splitArgs — closed request schema', () => {
  it('rejects undeclared parameters', () => {
    const { issues } = splitArgs({ page: P.integer() }, { page: 1, pagee: 2 });
    expect(issues[0]).toMatchObject({ param: 'pagee', rule: 'unknown' });
  });

  it('extracts known meta options and rejects unknown ones', () => {
    const { meta, issues } = splitArgs({}, { _timeout: 500, _bogus: true });
    expect(meta._timeout).toBe(500);
    expect(issues[0]?.rule).toBe('unknownMeta');
    expect(issues[0]?.message).toContain('_headers');
  });

  it('keeps declared params separate from meta', () => {
    const { params, meta } = splitArgs(
      { perPage: P.integer() },
      { perPage: 10, _retries: 5 },
    );
    expect(params).toEqual({ perPage: 10 });
    expect(meta._retries).toBe(5);
  });
});

describe('ContractViolationError', () => {
  it('carries structured violations and is terminal', () => {
    const err = new ContractViolationError([
      { param: 'page', rule: 'min', message: 'must be >= 1', value: 0 },
    ]);
    expect(err.retryable).toBe(false);
    expect(err.violations[0]?.param).toBe('page');
    expect(err.message).toContain('page');
  });
});
