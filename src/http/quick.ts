/**
 * Quick one-shot helpers, mirroring contractful's module-level API:
 *
 * ```ruby
 * Contractful.get(url, headers: {})
 * ```
 *
 * These bypass contracts entirely — no validation, no retries — and simply
 * resolve (or classify) a single HTTP exchange.
 */

import { AxiosTransport } from './axios-transport.js';
import { HttpStatusError } from '../errors.js';
import type { HttpMethod } from '../types.js';
import type { TransportResponse } from './transport.js';

export interface QuickOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | ReadonlyArray<string>> | URLSearchParams;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
}

const transport = new AxiosTransport();

async function request(
  method: HttpMethod,
  url: string,
  options: QuickOptions = {},
): Promise<TransportResponse> {
  const query = new URLSearchParams();
  if (options.query) {
    const entries =
      options.query instanceof URLSearchParams
        ? [...options.query.entries()]
        : Object.entries(options.query).flatMap(([k, v]) =>
            Array.isArray(v) ? v.map((item) => [k, String(item)] as [string, string]) : [[k, String(v)] as [string, string]],
          );
    for (const [k, v] of entries) query.append(k, v);
  }

  const res = await transport.send({
    method,
    url,
    headers: options.headers ?? {},
    query,
    body: options.body,
    timeout: options.timeout,
    signal: options.signal,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new HttpStatusError(`HTTP ${res.status} for ${method} ${url}`, {
      status: res.status,
      body: res.body,
      headers: res.headers,
    });
  }
  return res;
}

/** The contractful quick-call surface: `Contractful.get(url, opts)`. */
export const Contractful = {
  get: (url: string, options?: QuickOptions) => request('GET', url, options),
  post: (url: string, options?: QuickOptions) => request('POST', url, options),
  put: (url: string, options?: QuickOptions) => request('PUT', url, options),
  patch: (url: string, options?: QuickOptions) => request('PATCH', url, options),
  delete: (url: string, options?: QuickOptions) => request('DELETE', url, options),
  head: (url: string, options?: QuickOptions) => request('HEAD', url, options),
  options: (url: string, options?: QuickOptions) => request('OPTIONS', url, options),
};
