/**
 * Auth provider contract, token manager, provider adapters, the
 * `authProviderResolver` HTTP bridge (401 → handleUnauthorized → single
 * retry), CSRF stamping and the error taxonomy.
 */

import { describe, expect, it } from 'vitest';
import {
  apiKeyAuthProvider,
  appendAuthQuery,
  authProviderFromTokenManager,
  authProviderResolver,
  bearerAuthProvider,
  createTokenManager,
  staticAuthProvider,
  wsTicketAuthProvider,
  auth,
  AuthenticationError,
  AuthorizationError,
  contract,
  defineApi,
  errorKind,
  P,
  staticAuthProvider as staticProvider,
} from '../src/index.js';
import { jsonResponse, MockTransport } from './helpers.js';
import {
  HttpStatusError,
  TimeoutError,
  TransportError,
  WebSocketApiError,
} from '../src/errors.js';

/* -------------------------------------------------------------------------- */
/* Token manager                                                               */
/* -------------------------------------------------------------------------- */

describe('createTokenManager', () => {
  it('fetches lazily and caches until the refresh window', async () => {
    let fetches = 0;
    let clock = 1_000_000;
    const manager = createTokenManager({
      fetchToken: async () => {
        fetches++;
        return { accessToken: `t${fetches}`, expiresAt: clock + 60_000 };
      },
      refreshWindowMs: 30_000,
      now: () => clock,
    });

    expect(await manager.getToken()).toBe('t1');
    expect(await manager.getToken()).toBe('t1');
    expect(fetches).toBe(1);

    // Still valid 10s before the window.
    clock += 20_000;
    expect(await manager.getToken()).toBe('t1');
    expect(fetches).toBe(1);

    // Inside the refresh window → proactive refresh.
    clock += 15_000;
    expect(await manager.getToken()).toBe('t2');
    expect(fetches).toBe(2);
  });

  it('single-flights parallel refreshes', async () => {
    let fetches = 0;
    let inFlight = 0;
    let peakParallel = 0;
    const manager = createTokenManager({
      fetchToken: async () => {
        fetches++;
        inFlight++;
        peakParallel = Math.max(peakParallel, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight--;
        return { accessToken: `t${fetches}` };
      },
    });

    const [a, b, c] = await Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);
    expect(fetches).toBe(1);
    expect(peakParallel).toBe(1);
    expect(new Set([a, b, c])).toEqual(new Set(['t1']));
  });

  it('clearToken forces a refetch and notifies listeners', async () => {
    let fetches = 0;
    const events: string[] = [];
    const manager = createTokenManager({
      fetchToken: async () => ({ accessToken: `t${++fetches}`, scopes: ['orders:read'] }),
    });
    const off = manager.onChange(() => events.push('changed'));

    expect(await manager.getToken()).toBe('t1');
    manager.clearToken();
    expect(await manager.getToken()).toBe('t2');
    expect(manager.current?.accessToken).toBe('t2');
    expect(events).toEqual(['changed', 'changed', 'changed']); // set t1, clear, set t2
    off();
    manager.clearToken();
    expect(events).toHaveLength(3);
  });

  it('refetches when requested scopes are not covered by the cached token', async () => {
    let fetches = 0;
    const manager = createTokenManager({
      fetchToken: async (scopes) => ({ accessToken: `t${++fetches}`, scopes }),
    });
    await manager.getToken(['orders:read']);
    await manager.getToken(['orders:read']);
    expect(fetches).toBe(1);
    await manager.getToken(['orders:write']);
    expect(fetches).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

describe('auth providers', () => {
  it('staticAuthProvider returns constant material', async () => {
    const provider = staticAuthProvider({ headers: { 'X-Api-Key': 'k' } });
    expect(await provider.getAuth({ transport: 'http', url: 'https://x' })).toEqual({
      headers: { 'X-Api-Key': 'k' },
    });
  });

  it('bearerAuthProvider uses headers for http and query for websocket', async () => {
    const provider = bearerAuthProvider(() => 'tok');
    expect(await provider.getAuth({ transport: 'http', url: 'https://x' })).toEqual({
      headers: { Authorization: 'Bearer tok' },
    });
    expect(await provider.getAuth({ transport: 'websocket', url: 'wss://x' })).toEqual({
      query: { access_token: 'tok' },
    });
  });

  it('apiKeyAuthProvider places the key in a header or the query', async () => {
    const header = apiKeyAuthProvider({ name: 'X-Key', value: () => 'k' });
    const query = apiKeyAuthProvider({ name: 'api_key', value: () => 'k', in: 'query' });
    expect(await header.getAuth({ transport: 'http', url: 'https://x' })).toEqual({
      headers: { 'X-Key': 'k' },
    });
    expect(await query.getAuth({ transport: 'http', url: 'https://x' })).toEqual({
      query: { api_key: 'k' },
    });
  });

  it('wsTicketAuthProvider fetches a one-time ticket per call', async () => {
    let issued = 0;
    const provider = wsTicketAuthProvider(async () => ({ ticket: `tk${++issued}`, expiresIn: 30 }));
    const first = await provider.getAuth({ transport: 'websocket', url: 'wss://x' });
    const second = await provider.getAuth({ transport: 'websocket', url: 'wss://x' });
    expect(first).toEqual({ query: { ticket: 'tk1' } });
    expect(second).toEqual({ query: { ticket: 'tk2' } });
  });

  it('authProviderFromTokenManager maps ws auth mode and refresh handling', async () => {
    const manager = createTokenManager({
      fetchToken: async () => ({ accessToken: 'tok', expiresAt: Date.now() + 600_000 }),
    });
    const provider = authProviderFromTokenManager(manager, { wsAuthMode: 'subprotocol' });

    expect(await provider.getAuth({ transport: 'http', url: 'https://x' })).toEqual({
      headers: { Authorization: 'Bearer tok' },
    });
    expect(await provider.getAuth({ transport: 'websocket', url: 'wss://x' })).toEqual({
      protocols: ['tok'],
    });

    const stateChanges: number[] = [];
    provider.onAuthStateChanged?.(() => stateChanges.push(1));
    manager.clearToken();
    expect(stateChanges).toHaveLength(1);

    expect(await provider.handleUnauthorized?.({ transport: 'http', url: 'https://x' })).toBe(true);
    expect(manager.current).toBeNull();
  });

  it('appendAuthQuery appends with ? or & and encodes values', () => {
    expect(appendAuthQuery('wss://x/events', { ticket: 'a b' })).toBe(
      'wss://x/events?ticket=a%20b',
    );
    expect(appendAuthQuery('wss://x/events?a=1', { ticket: 't' })).toBe('wss://x/events?a=1&ticket=t');
    expect(appendAuthQuery('wss://x/events', undefined)).toBe('wss://x/events');
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP bridge                                                                 */
/* -------------------------------------------------------------------------- */

const api = defineApi({
  name: 'OrdersApi',
  contracts: {
    listOrders: contract('GET /orders', {
      security: ['orders:read'],
      responds: [{ status: 200, type: 'array' }],
    }),
  },
});

describe('authProviderResolver (HTTP bridge)', () => {
  it('stamps headers and query material from getAuth', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const seen: unknown[] = [];
    const provider: import('../src/index.js').AuthProvider = {
      async getAuth(context) {
        seen.push(context);
        return { headers: { Authorization: 'Bearer tok' }, query: { tenant: 'acme' } };
      },
    };
    const client = new api({ transport, auth: authProviderResolver(provider) });

    await client.listOrders();
    expect(transport.lastRequest.headers['Authorization']).toBe('Bearer tok');
    expect(transport.lastRequest.query.get('tenant')).toBe('acme');
    expect(seen[0]).toMatchObject({
      transport: 'http',
      method: 'GET',
      path: '/orders',
      operationId: 'listOrders',
      scopes: ['orders:read'],
    });
  });

  it('retries exactly once after handleUnauthorized resolves true', async () => {
    let status = 401;
    const transport = new MockTransport(() =>
      jsonResponse(status, status === 200 ? [] : { error: 'expired' }),
    );
    let unauthorizedCalls = 0;
    const provider: import('../src/index.js').AuthProvider = {
      async getAuth() {
        return { headers: { Authorization: 'Bearer stale' } };
      },
      async handleUnauthorized() {
        unauthorizedCalls++;
        status = 200;
        return true;
      },
    };

    const client = new api({ transport, auth: authProviderResolver(provider) });
    const result = await client.listOrders();

    expect(result).toEqual([]);
    expect(unauthorizedCalls).toBe(1);
    expect(transport.callCount).toBe(2);
    expect(transport.requests[1]!.headers['Authorization']).toBe('Bearer stale');
  });

  it('surfaces AuthenticationError when the refresh is vetoed', async () => {
    const transport = new MockTransport(() => jsonResponse(401, { error: 'expired' }));
    const provider: import('../src/index.js').AuthProvider = {
      async getAuth() {
        return { headers: { Authorization: 'Bearer bad' } };
      },
      async handleUnauthorized() {
        return false;
      },
    };

    const client = new api({ transport, auth: authProviderResolver(provider) });
    const err = await client.listOrders().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).status).toBe(401);
    expect(errorKind(err)).toBe('authentication');
    expect(transport.callCount).toBe(1);
  });

  it('maps 403 to AuthorizationError without any refresh attempt', async () => {
    const transport = new MockTransport(() => jsonResponse(403, { error: 'forbidden' }));
    let refreshes = 0;
    const provider: import('../src/index.js').AuthProvider = {
      async getAuth() {
        return { headers: { Authorization: 'Bearer tok' } };
      },
      async handleUnauthorized() {
        refreshes++;
        return true;
      },
    };

    const client = new api({ transport, auth: authProviderResolver(provider) });
    const err = await client.listOrders().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(refreshes).toBe(0); // 403 never triggers the refresh path
    expect(errorKind(err)).toBe('authorization');
  });

  it('applies cookie material onto the Cookie header', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const client = new api({
      transport,
      auth: authProviderResolver(staticProvider({ cookie: 'session=abc' })),
    });
    await client.listOrders();
    expect(transport.lastRequest.headers['Cookie']).toBe('session=abc');
  });
});

/* -------------------------------------------------------------------------- */
/* CSRF                                                                        */
/* -------------------------------------------------------------------------- */

describe('auth.csrf', () => {
  const csrfApi = defineApi({
    name: 'CsrfApi',
    contracts: {
      create: contract('POST /things', { responds: [{ status: 201, type: 'hash' }] }),
      read: contract('GET /things', { responds: [{ status: 200, type: 'array' }] }),
    },
  });

  it('stamps the CSRF header only on state-changing methods', async () => {
    const transport = new MockTransport((req) =>
      jsonResponse(req.method === 'POST' ? 201 : 200, req.method === 'POST' ? {} : []),
    );
    const client = new csrfApi({
      transport,
      auth: auth.csrf({ headerName: 'X-CSRF-Token', tokenProvider: () => 'csrf-1' }),
    });

    await client.read();
    expect(transport.lastRequest.headers['X-CSRF-Token']).toBeUndefined();

    await client.create();
    expect(transport.lastRequest.headers['X-CSRF-Token']).toBe('csrf-1');
  });
});

/* -------------------------------------------------------------------------- */
/* Taxonomy                                                                    */
/* -------------------------------------------------------------------------- */

describe('errorKind taxonomy', () => {
  it('classifies validation, network, timeout, server and unknown errors', async () => {
    const badParams = defineApi({
      name: 'P',
      contracts: {
        read: contract('GET /p', { params: { n: P.integer({ required: true }) } }),
      },
    });
    const client = new badParams({ transport: new MockTransport(() => jsonResponse(200, {})) });
    const violation = await client.read({ params: { n: 'nope' } as never }).catch((e) => e);
    expect(errorKind(violation)).toBe('validation');

    expect(errorKind(new Error('plain'))).toBe('unknown');
    expect(errorKind(new TimeoutError(500))).toBe('timeout');
    expect(errorKind(new TransportError('boom'))).toBe('network');
    expect(errorKind(new HttpStatusError('HTTP 500', { status: 500 }))).toBe('server');
    expect(errorKind(new WebSocketApiError('closed', { code: 4003 }))).toBe('websocket');
  });
});
