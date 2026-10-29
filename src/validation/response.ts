/**
 * Response validation — the "open response" half of the contract.
 *
 * A contract may declare which statuses it expects (`responds`) and,
 * optionally, the top-level body type for those statuses. Unknown response
 * *fields* are never rejected — they are data. Unexpected statuses and
 * top-level type mismatches are errors.
 */

import {
  HttpStatusError,
  RateLimitError,
  ResponseShapeError,
} from '../errors.js';
import type { ResponseDecl, ResponseType } from '../types.js';

export interface IncomingResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function matchesDecl(decl: ResponseDecl, status: number): boolean {
  if (typeof decl.status === 'number') {
    return decl.status === status;
  }
  const classDigit = Number.parseInt(decl.status[0]!, 10);
  return Math.floor(status / 100) === classDigit;
}

function isOkDecl(decl: ResponseDecl): boolean {
  if (decl.ok !== undefined) return decl.ok;
  if (typeof decl.status === 'number') return decl.status >= 200 && decl.status < 300;
  return decl.status === '2xx';
}

function jsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'hash';
  return typeof value;
}

function topLevelTypeOf(value: unknown): ResponseType | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'hash';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return undefined;
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Parses a `Retry-After` header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 1000;
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return undefined;
}

export interface ResponseOutcome {
  /** The validated body to return to the caller. */
  body: unknown;
}

/**
 * Validates an incoming response against the contract's `responds`
 * declarations and either returns the body or throws the appropriate error:
 *
 * - undeclared / declared-error statuses → {@link HttpStatusError}
 *   (HTTP 429 specifically → {@link RateLimitError})
 * - top-level type mismatch on a declared success → {@link ResponseShapeError}
 */
export function validateResponse(
  decls: ResponseDecl[] | undefined,
  res: IncomingResponse,
): ResponseOutcome {
  const headers = lowerHeaders(res.headers);
  const retryAfterMs = parseRetryAfter(headers['retry-after']);

  if (!decls || decls.length === 0) {
    // No `responds` declared: default contract — any 2xx is fine.
    if (res.status >= 200 && res.status < 300) {
      return { body: res.body };
    }
    throw httpErrorFor(res, headers, { declared: false, retryAfterMs });
  }

  const matched = decls.find((decl) => matchesDecl(decl, res.status));

  if (!matched) {
    const declared = decls.map((d) => String(d.status)).join(', ');
    const err = httpErrorFor(res, headers, {
      declared: false,
      retryAfterMs,
      note: `status not declared under responds (declared: ${declared})`,
    });
    throw err;
  }

  if (!isOkDecl(matched)) {
    throw httpErrorFor(res, headers, { declared: true, retryAfterMs });
  }

  if (matched.type !== undefined) {
    const actual = topLevelTypeOf(res.body);
    if (actual !== undefined && actual !== matched.type) {
      throw new ResponseShapeError({
        status: res.status,
        body: res.body,
        expectedType: matched.type,
        actualType: actual,
      });
    }
  }

  return { body: res.body };
}

function httpErrorFor(
  res: IncomingResponse,
  headers: Record<string, string>,
  opts: { declared: boolean; retryAfterMs?: number; note?: string },
): HttpStatusError {
  const base = {
    status: res.status,
    body: res.body,
    headers,
    declared: opts.declared,
    retryAfterMs: opts.retryAfterMs,
    statusText: headers['x-status-text'],
  };

  if (res.status === 429) {
    return new RateLimitError(base);
  }

  const note = opts.note ? ` (${opts.note})` : '';
  return new HttpStatusError(`HTTP ${res.status}${note}`, base);
}
