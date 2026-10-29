/**
 * Axios-backed transport (the default). Responses are always resolved —
 * status classification is the pipeline's job — and axios errors are mapped
 * onto the library's error hierarchy.
 */

import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
} from 'axios';
import { RequestAbortedError, TimeoutError, TransportError } from '../errors.js';
import {
  buildUrl,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './transport.js';

export class AxiosTransport implements Transport {
  readonly #client: AxiosInstance;

  constructor(config: AxiosRequestConfig = {}) {
    this.#client = axios.create({
      // We classify statuses ourselves against the contract.
      validateStatus: () => true,
      maxRedirects: 0,
      ...config,
    });
  }

  async send(req: TransportRequest): Promise<TransportResponse> {
    const config: AxiosRequestConfig = {
      method: req.method,
      url: buildUrl(req),
      headers: req.headers,
      data: req.body,
      timeout: req.timeout,
      signal: req.signal,
    };

    try {
      const res = await this.#client.request(config);
      return {
        status: res.status,
        headers: normalizeHeaders(res.headers),
        body: res.data,
      };
    } catch (err) {
      throw mapAxiosError(err, req.timeout);
    }
  }
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value !== undefined && value !== null) {
        out[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
  }
  return out;
}

function mapAxiosError(err: unknown, timeoutMs?: number): Error {
  if (err instanceof AxiosError || (err as AxiosError)?.isAxiosError) {
    const axiosErr = err as AxiosError;

    if (axiosErr.code === 'ERR_CANCELED' || axiosErr.name === 'CanceledError') {
      return new RequestAbortedError('Request aborted through AbortSignal', axiosErr);
    }
    if (axiosErr.code === 'ECONNABORTED' || axiosErr.code === 'ETIMEDOUT') {
      return new TimeoutError(timeoutMs ?? 0, axiosErr);
    }
    return new TransportError(
      `Network error: ${axiosErr.message}`,
      { cause: axiosErr, code: axiosErr.code },
    );
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new RequestAbortedError('Request aborted through AbortSignal', err);
  }
  return new TransportError(
    `Unexpected transport failure: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
