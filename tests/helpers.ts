import type { Transport, TransportRequest, TransportResponse } from '../src/http/transport.js';

export type TransportHandler = (
  req: TransportRequest,
  index: number,
) => TransportResponse | Promise<TransportResponse> | Error | Promise<Error>;

/** In-memory transport used across the suite — no network involved. */
export class MockTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  #handler: TransportHandler;
  #index = 0;

  constructor(handler: TransportHandler) {
    this.#handler = handler;
  }

  get callCount(): number {
    return this.requests.length;
  }

  get lastRequest(): TransportRequest {
    const last = this.requests[this.requests.length - 1];
    if (!last) throw new Error('no request was sent');
    return last;
  }

  async send(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    const index = this.#index++;
    const outcome = await this.#handler(req, index);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers, body };
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
