/**
 * Transport abstraction. The request lifecycle (validation, auth, retries,
 * circuit breaking, rate limiting) is transport-agnostic; axios is the
 * default implementation but anything implementing {@link Transport} can be
 * injected — which is also how the test suite runs without a network.
 */

import type { HttpMethod } from '../types.js';

export interface TransportRequest {
  method: HttpMethod;
  /** Full URL: base + built path, without the query string. */
  url: string;
  headers: Record<string, string>;
  query: URLSearchParams;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the payload was JSON, otherwise the raw string. */
  body: unknown;
}

export interface Transport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

/** Joins a base URL and a path, normalizing duplicate slashes. */
export function joinUrl(base: string, path: string): string {
  if (!base) return path;
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/** Builds the final URL including the query string. */
export function buildUrl(req: TransportRequest): string {
  const qs = req.query.toString();
  return qs ? `${req.url}?${qs}` : req.url;
}
