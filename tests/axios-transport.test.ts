/**
 * Real-transport boundary tests: a genuine Node HTTP server on 127.0.0.1
 * exercised through the default AxiosTransport — no MockTransport anywhere.
 *
 * Everything else in the suite runs on the transport seam; these tests pin
 * what actually crosses the process boundary: URL/query/header/body wire
 * formats, axios error mapping (refused connections, timeouts, aborts) and
 * the full pipeline (validation → auth → retry safety → idempotency keys)
 * over a real socket.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AxiosTransport } from '../src/http/axios-transport.js';
import { defineApi, contract, P } from '../src/index.js';
import {
  HttpStatusError,
  RequestAbortedError,
  TimeoutError,
  TransportError,
} from '../src/errors.js';

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  hits: number;
}

interface ServerHandle {
  url: string;
  captured: Captured[];
  close(): Promise<void>;
}

/** Starts a real HTTP server; each request is captured then handled. */
function startServer(
  handler: (captured: Captured, res: http.ServerResponse) => void,
): Promise<ServerHandle> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: Captured = {
        method: req.method ?? '',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        hits: 0,
      };
      captured.push(entry);
      handler(entry, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        captured,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, rawHeaders: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(rawHeaders)) res.setHeader(k, v);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let handles: ServerHandle[] = [];

beforeEach(() => {
  handles = [];
});

afterEach(async () => {
  for (const h of handles) await h.close();
});

describe('AxiosTransport — wire format against a real server', () => {
  it('sends method, URL, query, headers and JSON body exactly as built, and parses the JSON response', async () => {
    const server = await startServer((c, res) =>
      json(res, 200, { echo: { method: c.method, url: c.url, body: c.body, accept: c.headers['accept'], custom: c.headers['x-custom'] } }),
    );
    handles.push(server);

    const transport = new AxiosTransport();
    const res = await transport.send({
      method: 'POST',
      url: `${server.url}/echo`,
      headers: { 'X-Custom': 'marker' },
      query: new URLSearchParams('a=1&b=two'),
      body: { hello: 'world', n: 7 },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      echo: {
        method: 'POST',
        url: '/echo?a=1&b=two',
        body: JSON.stringify({ hello: 'world', n: 7 }),
        accept: 'application/json, text/plain, */*',
        custom: 'marker',
      },
    });
  });

  it('serializes URLSearchParams bodies as form-urlencoded', async () => {
    const server = await startServer((c, res) =>
      json(res, 200, { contentType: c.headers['content-type'], body: c.body }),
    );
    handles.push(server);

    const transport = new AxiosTransport();
    const res = await transport.send({
      method: 'POST',
      url: `${server.url}/form`,
      headers: {},
      query: new URLSearchParams(),
      body: new URLSearchParams('grant_type=client_credentials&scope=read'),
    });

    expect(res.body).toEqual({
      contentType: expect.stringMatching(/^application\/x-www-form-urlencoded;charset=/i),
      body: 'grant_type=client_credentials&scope=read',
    });
  });

  it('resolves every answered status — even 5xx — classification is the pipeline’s job', async () => {
    const server = await startServer((_c, res) => json(res, 503, { error: 'unavailable' }));
    handles.push(server);

    const transport = new AxiosTransport();
    const res = await transport.send({
      method: 'GET',
      url: `${server.url}/flaky`,
      headers: {},
      query: new URLSearchParams(),
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'unavailable' });
  });

  it('returns the raw string body for non-JSON content types', async () => {
    const server = await startServer((_c, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('plain and simple');
    });
    handles.push(server);

    const transport = new AxiosTransport();
    const res = await transport.send({
      method: 'GET',
      url: `${server.url}/text`,
      headers: {},
      query: new URLSearchParams(),
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe('plain and simple');
  });

  it('yields an empty body for 204 No Content', async () => {
    const server = await startServer((_c, res) => res.writeHead(204).end());
    handles.push(server);

    const transport = new AxiosTransport();
    const res = await transport.send({
      method: 'DELETE',
      url: `${server.url}/gone`,
      headers: {},
      query: new URLSearchParams(),
    });

    expect(res.status).toBe(204);
    expect(res.body ?? '').toBe('');
  });

  it('joins repeated response headers into one comma-separated value', async () => {
    const server = await startServer((_c, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', ['a=1', 'b=2']);
      res.end('{}');
    });
    handles.push(server);

    const transport = new AxiosTransport();
    const res = await transport.send({
      method: 'GET',
      url: `${server.url}/cookies`,
      headers: {},
      query: new URLSearchParams(),
    });

    expect(res.headers['set-cookie']).toBe('a=1, b=2');
  });
});

describe('AxiosTransport — failure mapping over a real socket', () => {
  it('maps a refused connection to TransportError (ECONNREFUSED)', async () => {
    // Grab a port, then close the listener so nothing is listening on it.
    const probe = await startServer((_c, res) => json(res, 200, {}));
    const deadUrl = probe.url;
    await probe.close();

    const transport = new AxiosTransport();
    const err = await transport
      .send({ method: 'GET', url: deadUrl, headers: {}, query: new URLSearchParams() })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError & { code?: string }).code).toBe('ECONNREFUSED');
  });

  it('maps an exceeded timeout to TimeoutError', async () => {
    const server = await startServer(async (_c, res) => {
      await delay(500);
      json(res, 200, { late: true });
    });
    handles.push(server);

    const transport = new AxiosTransport();
    const err = await transport
      .send({
        method: 'GET',
        url: `${server.url}/slow`,
        headers: {},
        query: new URLSearchParams(),
        timeout: 40,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('maps an AbortSignal cancellation to RequestAbortedError', async () => {
    const server = await startServer(async (_c, res) => {
      await delay(500);
      json(res, 200, { late: true });
    });
    handles.push(server);

    const controller = new AbortController();
    const transport = new AxiosTransport();
    const pending = transport.send({
      method: 'GET',
      url: `${server.url}/slow`,
      headers: {},
      query: new URLSearchParams(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toBeInstanceOf(RequestAbortedError);
  });

  it('rejects a pre-aborted signal without reaching the server', async () => {
    const server = await startServer((_c, res) => json(res, 200, {}));
    handles.push(server);

    const controller = new AbortController();
    controller.abort();

    const transport = new AxiosTransport();
    await expect(
      transport.send({
        method: 'GET',
        url: `${server.url}/never`,
        headers: {},
        query: new URLSearchParams(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    expect(server.captured.length).toBe(0);
  });
});

describe('full pipeline over the default (axios) transport', () => {
  it('round-trips a typed GET through validation, query building and response validation', async () => {
    const server = await startServer((c, res) => json(res, 200, { id: Number(new URL(c.url, 'http://x').searchParams.get('id')), name: 'Ada' }));
    handles.push(server);

    const Api = defineApi({
      name: 'RealApi',
      base: server.url,
      contracts: {
        getUser: contract('GET /user', {
          params: { id: P.integer({ required: true }) },
          responds: [{ status: 200, type: 'hash' }],
        }),
      },
    });

    const client = new Api();
    const user = (await client.getUser({ id: 42 })) as { id: number; name: string };
    expect(user).toEqual({ id: 42, name: 'Ada' });
    expect(server.captured[0].url).toBe('/user?id=42');
  });

  it('retries a GET after a 5xx over the real transport and succeeds', async () => {
    const server = await startServer((_c, res) => {
      json(res, server.captured.length === 1 ? 500 : 200, server.captured.length === 1 ? { error: 'boom' } : { ok: true });
    });
    handles.push(server);

    const Api = defineApi({
      base: server.url,
      retry: { retries: 1, baseDelay: 10 },
      contracts: {
        flaky: contract('GET /flaky', { responds: [{ status: 200, type: 'hash' }] }),
      },
    });

    const client = new Api();
    await expect(client.flaky()).resolves.toEqual({ ok: true });
    expect(server.captured.length).toBe(2);
  });

  it('does NOT retry a POST after a 5xx (ambiguous failure) over the real transport', async () => {
    const server = await startServer((_c, res) => json(res, 500, { error: 'boom' }));
    handles.push(server);

    const Api = defineApi({
      base: server.url,
      retry: { retries: 2, baseDelay: 10 },
      contracts: {
        charge: contract('POST /charge', {
          params: { amount: P.integer({ required: true }) },
          responds: [{ status: 200, type: 'hash' }, { status: 500, type: 'hash' }],
        }),
      },
    });

    const client = new Api();
    await expect(client.charge({ amount: 100 })).rejects.toBeInstanceOf(HttpStatusError);
    expect(server.captured.length).toBe(1); // single attempt — no duplicate charge
  });

  it('retries a POST after a 429 with Retry-After (server-sanctioned)', async () => {
    const server = await startServer((_c, res) => {
      if (server.captured.length === 1) {
        json(res, 429, { error: 'slow down' }, { 'Retry-After': '0' });
      } else {
        json(res, 200, { ok: true });
      }
    });
    handles.push(server);

    const Api = defineApi({
      base: server.url,
      retry: { retries: 1, baseDelay: 10 },
      contracts: {
        create: contract('POST /things', {
          params: { name: P.string({ required: true }) },
          responds: [{ status: 200, type: 'hash' }],
        }),
      },
    });

    const client = new Api();
    await expect(client.create({ name: 'x' })).resolves.toEqual({ ok: true });
    expect(server.captured.length).toBe(2);
  });

  it('keeps the idempotency key identical across attempts of a retried POST', async () => {
    const server = await startServer((_c, res) => {
      json(res, server.captured.length === 1 ? 502 : 200, server.captured.length === 1 ? { error: 'bad gateway' } : { ok: true });
    });
    handles.push(server);

    const Api = defineApi({
      base: server.url,
      retry: { retries: 1, baseDelay: 10 },
      contracts: {
        transfer: contract('POST /transfer', {
          params: { to: P.string({ required: true }) },
          idempotent: true,
          responds: [{ status: 200, type: 'hash' }],
        }),
      },
    });

    const client = new Api();
    await expect(client.transfer({ to: 'bob' })).resolves.toEqual({ ok: true });
    expect(server.captured.length).toBe(2);

    const key = (i: number): string => String(server.captured[i].headers['idempotency-key']);
    expect(key(0)).toBeTruthy();
    expect(key(1)).toBe(key(0));
  });

  it('applies the auth resolver to real requests', async () => {
    const server = await startServer((c, res) => json(res, 200, { auth: c.headers['authorization'] }));
    handles.push(server);

    const Api = defineApi({
      base: server.url,
      auth: async ({ headers }) => {
        headers.Authorization = 'Bearer live-token';
      },
      contracts: {
        me: contract('GET /me', { responds: [{ status: 200, type: 'hash' }] }),
      },
    });

    const client = new Api();
    await expect(client.me()).resolves.toEqual({ auth: 'Bearer live-token' });
  });

  it('aborts during retry backoff with RequestAbortedError', async () => {
    const server = await startServer((_c, res) => json(res, 500, { error: 'boom' }));
    handles.push(server);

    const Api = defineApi({
      base: server.url,
      contracts: {
        flaky: contract('GET /flaky', { responds: [{ status: 200, type: 'hash' }] }),
      },
    });

    const controller = new AbortController();
    // jitter: 'none' keeps the 5s backoff exact — full jitter draws uniformly
    // from [0, 5s), so a small draw can fire the retry before the 80ms abort
    // lands and flake the attempt count below.
    const client = new Api({ retry: { jitter: 'none' } });
    const pending = client.flaky({ _retries: 1, _retryDelay: 5_000, _signal: controller.signal });
    setTimeout(() => controller.abort(), 80);

    await expect(pending).rejects.toBeInstanceOf(RequestAbortedError);
    expect(server.captured.length).toBe(1); // first attempt only — cancelled in backoff
  });
});
