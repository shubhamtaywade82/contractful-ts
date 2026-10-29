import { describe, expect, it } from 'vitest';
import {
  auth,
  CircuitOpenError,
  ContractViolationError,
  ContractDefinitionError,
  contract,
  defineApi,
  HttpStatusError,
  P,
  RequestAbortedError,
  TransportError,
  type ApiClientConstructor,
  type TransportRequest,
} from '../src/index.js';
import { jsonResponse, MockTransport } from './helpers.js';

function makeApi(transport: MockTransport, extra: Parameters<typeof defineApi>[0] = {}) {
  return new (defineApi({
    name: 'TestApi',
    base: 'https://api.test',
    contracts: {
      listThings: contract('GET /things', {
        params: {
          page: P.integer({ default: 1, min: 1 }),
          perPage: P.integer({ as: 'per_page', default: 30, inclusion: [10, 30, 50] }),
          filter: P.string(),
        },
        responds: [{ status: 200, type: 'array' }],
      }),
      getThing: contract('GET /things/:id', {
        params: { id: P.integer({ required: true, min: 1 }) },
        responds: [{ status: 200, type: 'hash' }, { status: 404 }],
      }),
      createThing: contract('POST /things', {
        idempotent: true,
        params: {
          name: P.string({ required: true, length: { min: 1 } }),
          tags: P.array({ of: P.string(), default: [] }),
          meta: P.hash(),
        },
        responds: [{ status: 201, type: 'hash' }, { status: 422 }],
      }),
      touchHeader: contract('GET /header-things', {
        params: { traceId: P.string({ in: 'header' }) },
        responds: [{ status: 200 }],
      }),
    },
    ...extra,
  }))({ transport });
}

describe('defineApi — method derivation and typing', () => {
  it('creates one callable method per contract', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport);
    expect(typeof api.listThings).toBe('function');
    expect(typeof api.getThing).toBe('function');
    await api.listThings();
    expect(transport.callCount).toBe(1);
  });

  it('attaches the contract definition to each method', () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport);
    expect(api.getThing.contract.route.template).toBe('/things/:id');
    expect(api.listThings.contract.route.method).toBe('GET');
  });

  it('exposes contracts and describe() on the class', () => {
    const Api = defineApi({
      base: 'https://api.test',
      contracts: {
        ping: contract('GET /ping', { responds: [{ status: 200 }] }),
      },
    });
    expect(Api.contracts.ping.route.template).toBe('/ping');
    const described = Api.describe();
    expect(described).toContain('GET');
    expect(described).toContain('/ping');
  });

  it('describes a single contract in detail', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport);
    const described = api.describe('createThing');
    expect(described).toContain('POST /things');
    expect(described).toContain('name');
    expect(described).toContain('required');
    expect(described).toContain('responds: 201 (hash), 422');
  });
});

describe('defineApi — request shaping', () => {
  it('applies defaults and snake_case wire names in the query', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport);
    await api.listThings();
    const req = transport.lastRequest;
    expect(req.query.get('page')).toBe('1');
    expect(req.query.get('per_page')).toBe('30');
    expect(req.query.get('filter')).toBeNull();
    expect(req.url).toBe('https://api.test/things');
    expect(req.method).toBe('GET');
  });

  it('substitutes path params and omits consumed ones', async () => {
    const transport = new MockTransport(() => jsonResponse(200, { id: 7 }));
    const api = makeApi(transport);
    await api.getThing({ id: 7 });
    const req = transport.lastRequest;
    expect(req.url).toBe('https://api.test/things/7');
    expect(req.query.toString()).toBe('');
  });

  it('sends POST params as a JSON body', async () => {
    const transport = new MockTransport(() => jsonResponse(201, { id: 1 }));
    const api = makeApi(transport);
    await api.createThing({ name: 'Widget', meta: { deep: true } });
    const req = transport.lastRequest;
    expect(req.body).toEqual({ name: 'Widget', tags: [], meta: { deep: true } });
    expect(req.headers['content-type']).toBeUndefined(); // axios adds this at send time
  });

  it('places header params in headers', async () => {
    const transport = new MockTransport(() => jsonResponse(200, {}));
    const api = makeApi(transport);
    await api.touchHeader({ traceId: 'abc-123' });
    expect(transport.lastRequest.headers['traceId']).toBe('abc-123');
  });

  it('rejects unknown args before any HTTP traffic (closed schema)', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport);
    // @ts-expect-error typo on purpose
    await expect(api.listThings({ pagee: 1 })).rejects.toThrow(ContractViolationError);
    expect(transport.callCount).toBe(0);
  });

  it('rejects constraint violations with structured details', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport);
    try {
      await api.listThings({ perPage: 20 });
      expect.unreachable();
    } catch (err) {
      const violation = err as ContractViolationError;
      expect(violation.violations[0]).toMatchObject({ param: 'perPage', rule: 'inclusion' });
    }
  });
});

describe('defineApi — meta options', () => {
  it('merges _headers and _query', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport);
    await api.listThings({
      page: 2,
      _headers: { 'X-Trace': 't1' },
      _query: { extra: 'yes' },
    });
    const req = transport.lastRequest;
    expect(req.headers['X-Trace']).toBe('t1');
    expect(req.query.get('extra')).toBe('yes');
    expect(req.query.get('page')).toBe('2');
  });

  it('overrides the base URL per call', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport);
    await api.listThings({ _baseUrl: 'https://other.test/v2' });
    expect(transport.lastRequest.url).toBe('https://other.test/v2/things');
  });

  it('sends an idempotency key that can be pinned per call', async () => {
    const transport = new MockTransport(() => jsonResponse(201, {}));
    const api = makeApi(transport);
    await api.createThing({ name: 'x', _idempotencyKey: 'stable-key' });
    expect(transport.lastRequest.headers['Idempotency-Key']).toBe('stable-key');
    await api.createThing({ name: 'y' });
    const generated = transport.lastRequest.headers['Idempotency-Key'];
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('skips auth with _skipAuth', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = makeApi(transport, {
      auth: auth.bearer(() => 'secret-token'),
    });
    await api.listThings({ _skipAuth: true });
    expect(transport.lastRequest.headers['Authorization']).toBeUndefined();
    await api.listThings();
    expect(transport.lastRequest.headers['Authorization']).toBe('Bearer secret-token');
  });
});

describe('defineApi — hooks', () => {
  it('beforeRequest can mutate query and headers (signing style)', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const api = new (defineApi({
      base: 'https://api.test',
      beforeRequest: (ctx) => {
        ctx.query.set('timestamp', '123');
        ctx.query.set('signature', `sig(${ctx.query.get('page')})`);
      },
      contracts: {
        list: contract('GET /items', { params: { page: P.integer({ default: 9 }) } }),
      },
    }))({ transport });
    await api.list();
    const req = transport.lastRequest;
    expect(req.query.get('timestamp')).toBe('123');
    expect(req.query.get('signature')).toBe('sig(9)');
  });

  it('afterResponse observes the response context', async () => {
    const seen: number[] = [];
    const transport = new MockTransport(() => jsonResponse(200, { ok: true }));
    const api = new (defineApi({
      base: 'https://api.test',
      afterResponse: (ctx) => {
        seen.push(ctx.status);
      },
      contracts: { ping: contract('GET /ping') },
    }))({ transport });
    await api.ping();
    expect(seen).toEqual([200]);
  });

  it('abort signals surface as RequestAbortedError', async () => {
    const transport = new MockTransport(
      (_req, _i) =>
        new Promise((_resolve, reject) => {
          const err = new Error('canceled');
          err.name = 'CanceledError';
          (err as Error & { isAxiosError?: boolean }).isAxiosError = true;
          (err as Error & { code?: string }).code = 'ERR_CANCELED';
          reject(err);
        }),
    );
    const api = makeApi(transport);
    const controller = new AbortController();
    await expect(
      api.listThings({ _signal: controller.signal }),
    ).rejects.toThrow(RequestAbortedError);
  });
});

describe('defineApi — response handling', () => {
  it('returns the parsed body for declared successes', async () => {
    const transport = new MockTransport(() => jsonResponse(200, [{ id: 1 }]));
    const api = makeApi(transport);
    await expect(api.listThings()).resolves.toEqual([{ id: 1 }]);
  });

  it('throws HttpStatusError with the body attached for declared errors', async () => {
    const transport = new MockTransport(() => jsonResponse(422, { errors: ['name'] }));
    const api = makeApi(transport);
    try {
      await api.createThing({ name: 'Widget' });
      expect.unreachable();
    } catch (err) {
      const httpErr = err as HttpStatusError;
      expect(httpErr.status).toBe(422);
      expect(httpErr.declared).toBe(true);
      expect(httpErr.body).toEqual({ errors: ['name'] });
    }
  });

  it('throws for undeclared statuses', async () => {
    const transport = new MockTransport(() => jsonResponse(403, { message: 'no' }));
    const api = makeApi(transport);
    await expect(api.listThings()).rejects.toThrow(/not declared/);
  });
});

describe('defineApi — retries', () => {
  it('retries transport failures with backoff and eventually succeeds', async () => {
    let calls = 0;
    const transport = new MockTransport((_req, i) => {
      calls++;
      if (i < 2) return new TransportError('connection reset');
      return jsonResponse(200, [{ id: 1 }]);
    });
    const api = new (defineApi({
      base: 'https://api.test',
      retry: { retries: 2, baseDelay: 10, jitter: 'none' },
      contracts: { list: contract('GET /items') },
    }))({ transport });
    const body = await api.list();
    expect(body).toEqual([{ id: 1 }]);
    expect(calls).toBe(3);
  });

  it('does not retry 4xx client errors', async () => {
    let calls = 0;
    const transport = new MockTransport(() => {
      calls++;
      return jsonResponse(400, { bad: true });
    });
    const api = new (defineApi({
      base: 'https://api.test',
      retry: { retries: 5, baseDelay: 1 },
      contracts: { list: contract('GET /items') },
    }))({ transport });
    await expect(api.list()).rejects.toThrow(HttpStatusError);
    expect(calls).toBe(1);
  });

  it('honors Retry-After on 429 then succeeds', async () => {
    const transport = new MockTransport((_req, i) =>
      i === 0
        ? jsonResponse(429, null, { 'retry-after': '0.05' })
        : jsonResponse(200, []),
    );
    const api = new (defineApi({
      base: 'https://api.test',
      retry: { retries: 1, baseDelay: 5_000, jitter: 'none' },
      contracts: { list: contract('GET /items') },
    }))({ transport });
    await expect(api.list()).resolves.toEqual([]);
    expect(transport.callCount).toBe(2);
  });

  it('stops after the configured budget', async () => {
    const transport = new MockTransport(() => new TransportError('down'));
    const api = new (defineApi({
      base: 'https://api.test',
      retry: { retries: 2, baseDelay: 1 },
      contracts: { list: contract('GET /items') },
    }))({ transport });
    await expect(api.list()).rejects.toThrow(TransportError);
    expect(transport.callCount).toBe(3);
  });

  it('per-call _retries override the API default', async () => {
    const transport = new MockTransport(() => new TransportError('down'));
    const api = new (defineApi({
      base: 'https://api.test',
      contracts: { list: contract('GET /items') },
    }))({ transport, retries: 0 });
    await expect(api.list({ _retries: 1, _retryDelay: 1 })).rejects.toThrow(TransportError);
    expect(transport.callCount).toBe(2);
  });
});

describe('defineApi — token refresh on 401', () => {
  it('invalidates once and retries with the fresh token', async () => {
    let generation = 0;
    const invalidated: (string | undefined)[] = [];
    const transport = new MockTransport((req) => {
      generation++;
      const token = req.headers['Authorization'];
      const isFresh = token === 'Bearer fresh';
      if (isFresh) return jsonResponse(200, { ok: true });
      return jsonResponse(401, { error: 'expired' });
    });
    const api = new (defineApi({
      base: 'https://api.test',
      auth: auth.tokenProvider({
        getToken: () => (generation === 0 ? 'stale' : 'fresh'),
        invalidate: (t) => invalidated.push(t),
      }),
      contracts: { me: contract('GET /me') },
    }))({ transport });

    await expect(api.me()).resolves.toEqual({ ok: true });
    expect(invalidated).toEqual(['stale']);
    expect(transport.callCount).toBe(2);
  });

  it('does not loop: a second 401 fails', async () => {
    const transport = new MockTransport(() => jsonResponse(401, { error: 'no' }));
    const api = new (defineApi({
      base: 'https://api.test',
      auth: auth.tokenProvider({ getToken: () => 'always-bad' }),
      contracts: { me: contract('GET /me') },
    }))({ transport });
    await expect(api.me()).rejects.toThrow(HttpStatusError);
    expect(transport.callCount).toBe(2); // original + one refresh retry
  });
});

describe('defineApi — circuit breaker integration', () => {
  it('opens the circuit and fails fast on subsequent calls', async () => {
    const transport = new MockTransport(() => new TransportError('host down'));
    const api = new (defineApi({
      base: 'https://api.test',
      retry: { retries: 0 },
      circuit: { failureThreshold: 2, cooldownMs: 10_000 },
      contracts: { list: contract('GET /items') },
    }))({ transport });

    await expect(api.list()).rejects.toThrow(TransportError);
    await expect(api.list()).rejects.toThrow(TransportError);
    await expect(api.list()).rejects.toThrow(CircuitOpenError);
    expect(transport.callCount).toBe(2); // third call never reached the wire
  });
});

describe('defineApi — rate limiter integration', () => {
  it('paces dispatches', async () => {
    const transport = new MockTransport((_req, i) => jsonResponse(200, { i }));
    const api = new (defineApi({
      base: 'https://api.test',
      rateLimit: { requestsPerSecond: 100, burst: 1 },
      contracts: { list: contract('GET /items') },
    }))({ transport });

    const t0 = Date.now();
    await Promise.all([api.list(), api.list(), api.list(), api.list()]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(transport.callCount).toBe(4);
  });
});

describe('defineApi — definition-time errors', () => {
  it('rejects required + default together', () => {
    expect(() =>
      defineApi({
        base: 'https://api.test',
        contracts: {
          bad: contract('GET /x', { params: { a: P.string({ required: true, default: 'x' }) } }),
        },
      }),
    ).toThrow(ContractDefinitionError);
  });

  it('rejects path params missing from the route template', () => {
    expect(() =>
      defineApi({
        base: 'https://api.test',
        contracts: {
          bad: contract('GET /x', { params: { ghost: P.string({ in: 'path' }) } }),
        },
      }),
    ).toThrow(ContractDefinitionError);
  });

  it('rejects undeclared route placeholders', () => {
    expect(() =>
      defineApi({
        base: 'https://api.test',
        contracts: { bad: contract('GET /x/:missing') },
      }),
    ).toThrow(ContractDefinitionError);
  });

  it('rejects malformed routes', () => {
    expect(() => contract('GET no-slash')).toThrow(ContractDefinitionError);
    expect(() => contract('TELEPORT /x')).toThrow(ContractDefinitionError);
  });
});

describe('defineApi — client option overrides', () => {
  const Api: ApiClientConstructor<any> = defineApi({
    base: 'https://api.test',
    defaultHeaders: { Accept: 'application/json' },
    contracts: { list: contract('GET /items') },
  });

  it('lets each instance override base URL and headers', async () => {
    const transport = new MockTransport(() => jsonResponse(200, []));
    const client = new Api({ transport, base: 'https://override.test', headers: { 'X-Client': 'a' } });
    await client.list();
    const req = transport.lastRequest;
    expect(req.url).toBe('https://override.test/items');
    expect(req.headers['Accept']).toBe('application/json');
    expect(req.headers['X-Client']).toBe('a');
  });

  it('shares nothing mutable between instances', async () => {
    const t1 = new MockTransport(() => jsonResponse(200, []));
    const t2 = new MockTransport(() => jsonResponse(200, []));
    const c1 = new Api({ transport: t1, headers: { 'X-Only': 'one' } });
    const c2 = new Api({ transport: t2 });
    await c1.list();
    await c2.list();
    expect(t2.lastRequest.headers['X-Only']).toBeUndefined();
  });
});
