import { describe, expect, it } from 'vitest';
import { auth, createClientCredentialsProvider } from '../src/middleware/auth.js';
import type { AuthSurface } from '../src/middleware/auth.js';

function ctx(): AuthSurface {
  return { headers: {}, query: new URLSearchParams() };
}

describe('auth.bearer', () => {
  it('sets the Authorization header', async () => {
    const resolver = auth.bearer(() => 'tok-123');
    const c = ctx();
    await resolver(c);
    expect(c.headers['Authorization']).toBe('Bearer tok-123');
  });

  it('supports async getters', async () => {
    const resolver = auth.bearer(async () => 'async-tok');
    const c = ctx();
    await resolver(c);
    expect(c.headers['Authorization']).toBe('Bearer async-tok');
  });

  it('rejects empty tokens', async () => {
    const resolver = auth.bearer(() => '');
    await expect(resolver(ctx())).rejects.toThrow(/empty token/i);
  });
});

describe('auth.basic', () => {
  it('sets a base64-encoded Basic header', async () => {
    const resolver = auth.basic(() => ['user', 'pass:word']);
    const c = ctx();
    await resolver(c);
    expect(c.headers['Authorization']).toBe(`Basic ${Buffer.from('user:pass:word').toString('base64')}`);
  });
});

describe('auth.apiKey', () => {
  it('places the key in a header by default', async () => {
    const resolver = auth.apiKey({ name: 'X-Api-Key', value: () => 'k3y' });
    const c = ctx();
    await resolver(c);
    expect(c.headers['X-Api-Key']).toBe('k3y');
  });

  it('can place the key in the query string', async () => {
    const resolver = auth.apiKey({ name: 'apikey', value: () => 'k3y', in: 'query' });
    const c = ctx();
    await resolver(c);
    expect(c.query.get('apikey')).toBe('k3y');
  });
});

describe('auth.tokenProvider', () => {
  it('applies the token through the custom apply hook', async () => {
    const resolver = auth.tokenProvider({
      getToken: () => 't0k',
      apply: (c, token) => {
        c.headers['X-Token'] = token;
      },
    });
    const c = ctx();
    await resolver(c);
    expect(c.headers['X-Token']).toBe('t0k');
  });

  it('defaults to a Bearer header and tracks the last token', async () => {
    const resolver = auth.tokenProvider({ getToken: () => 'abc' });
    const c = ctx();
    await resolver(c);
    expect(c.headers['Authorization']).toBe('Bearer abc');
    expect(resolver.lastToken?.()).toBe('abc');
  });

  it('exposes the provider for 401 invalidation', () => {
    const provider = { getToken: () => 'x', invalidate: () => void 0 };
    const resolver = auth.tokenProvider(provider);
    expect(resolver.provider).toBe(provider);
  });
});

describe('createClientCredentialsProvider', () => {
  it('fetches, caches and re-fetches tokens', async () => {
    let calls = 0;
    const provider = createClientCredentialsProvider({
      tokenUrl: 'https://auth.test/token',
      clientId: 'client',
      clientSecret: 'secret',
      expirySkewMs: 0,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls++;
      expect(String(url)).toBe('https://auth.test/token');
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('client_id')).toBe('client');
      return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      expect(await provider.getToken()).toBe('tok-1');
      expect(await provider.getToken()).toBe('tok-1'); // cached
      provider.invalidate('tok-1');
      expect(await provider.getToken()).toBe('tok-2');
      provider.invalidate(); // force
      expect(await provider.getToken()).toBe('tok-3');
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('wraps endpoint failures in AuthError', async () => {
    const provider = createClientCredentialsProvider({
      tokenUrl: 'https://auth.test/token',
      clientId: 'client',
      clientSecret: 'secret',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error": "invalid_client"}', { status: 401 })) as typeof fetch;
    try {
      await expect(provider.getToken()).rejects.toThrow(/HTTP 401/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
