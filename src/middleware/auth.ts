/**
 * Authentication resolvers.
 *
 * Like contractful, auth is declared once at the API level and applied to
 * every request (unless skipped with `_skipAuth`). Resolvers receive the
 * mutable request context and may stamp headers or query parameters.
 */

import type { AxiosInstance } from 'axios';
import { AuthError } from '../errors.js';

/**
 * Request information the pipeline attaches to the auth surface, so an
 * {@link AuthProvider} (or a custom resolver) can make transport- and
 * operation-aware decisions.
 */
export interface AuthRequestInfo {
  transport: 'http';
  method: string;
  path: string;
  url: string;
  /** Contract / operation name. */
  operationId: string;
  /** 0-based attempt counter. */
  attempt: number;
  /** Scopes declared by the contract's `security` option. */
  scopes?: string[];
}

/** Mutable auth surface over an outgoing request. */
export interface AuthSurface {
  headers: Record<string, string>;
  query: URLSearchParams;
  /** Request context, populated by the pipeline. */
  request?: AuthRequestInfo;
}

/**
 * An auth resolver. The optional `provider` field is set by
 * {@link auth.tokenProvider} so the pipeline can trigger token
 * invalidation + retry when the server answers 401; `lastToken` exposes
 * the most recently applied token for that purpose. Providers may also
 * implement `onUnauthorized` to run an async refresh and veto the retry.
 */
export type AuthResolver = {
  (ctx: AuthSurface): void | Promise<void>;
  readonly provider?: TokenProvider;
  lastToken?: () => string | undefined;
};

export interface TokenProvider {
  /** Return the current access token. Implementations are expected to cache. */
  getToken(): string | Promise<string>;
  /** Called when a request authenticated with `token` received a 401. */
  invalidate?(token?: string): void;
  /**
   * Async 401 hook: refresh credentials and decide whether the request
   * should be retried (once). Takes precedence over `invalidate` when both
   * are present — this is the bridge `AuthProvider.handleUnauthorized`
   * plugs into.
   */
  onUnauthorized?(info: {
    url: string;
    method?: string;
    path?: string;
    operationId?: string;
    attempt?: number;
    scopes?: string[];
  }): Promise<boolean>;
  /** How the token is applied. Defaults to an `Authorization: Bearer` header. */
  apply?(ctx: AuthSurface, token: string): void;
}

function makeResolver(
  fn: (ctx: AuthSurface) => void | Promise<void>,
  provider?: TokenProvider,
): AuthResolver {
  const resolver = fn as AuthResolver;
  Object.defineProperty(resolver, 'provider', {
    value: provider,
    enumerable: false,
    writable: false,
  });
  return resolver;
}

async function resolveValue<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

/** Namespace of auth resolver factories, mirroring contractful's `auth` DSL. */
export const auth = {
  /** `Authorization: Bearer <token>` from a (possibly async) token getter. */
  bearer(getToken: () => string | Promise<string>): AuthResolver {
    return makeResolver(async (ctx) => {
      const token = await resolveValue(getToken());
      if (!token) {
        throw new AuthError('bearer auth resolved to an empty token');
      }
      ctx.headers['Authorization'] = `Bearer ${token}`;
    });
  },

  /** HTTP Basic auth from a getter returning `[user, password]`. */
  basic(
    getCredentials: () => [string, string] | Promise<[string, string]>,
  ): AuthResolver {
    return makeResolver(async (ctx) => {
      const [user, password] = await resolveValue(getCredentials());
      const encoded = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
      ctx.headers['Authorization'] = `Basic ${encoded}`;
    });
  },

  /**
   * Static API key placed in a header (default) or the query string.
   *
   * ```ts
   * auth.apiKey({ name: 'X-Api-Key', value: () => process.env.API_KEY! })
   * auth.apiKey({ name: 'apikey', value: () => key, in: 'query' })
   * ```
   */
  apiKey(options: {
    name: string;
    value: () => string | Promise<string>;
    in?: 'header' | 'query';
  }): AuthResolver {
    return makeResolver(async (ctx) => {
      const value = await resolveValue(options.value());
      if (!value) {
        throw new AuthError(`api key ${JSON.stringify(options.name)} resolved to an empty value`);
      }
      if (options.in === 'query') {
        ctx.query.set(options.name, value);
      } else {
        ctx.headers[options.name] = value;
      }
    });
  },

  /**
   * CSRF protection for cookie-authenticated sessions: a header carrying a
   * CSRF token is stamped onto state-changing requests (`POST`, `PUT`,
   * `PATCH`, `DELETE` — override with `methods`). Pair with
   * `credentials: 'include'` on the underlying axios instance.
   *
   * ```ts
   * auth.csrf({
   *   headerName: 'X-CSRF-Token',
   *   tokenProvider: async () => (await cookies.get('csrf')).value,
   * })
   * ```
   */
  csrf(options: {
    headerName?: string;
    tokenProvider: () => string | Promise<string>;
    methods?: readonly string[];
  }): AuthResolver {
    const headerName = options.headerName ?? 'X-CSRF-Token';
    const methods = new Set(
      (options.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE']).map((m) => m.toUpperCase()),
    );
    return makeResolver(async (ctx) => {
      const method = (ctx.request?.method ?? '').toUpperCase();
      if (method && !methods.has(method)) return;
      const token = await resolveValue(options.tokenProvider());
      if (token) {
        ctx.headers[headerName] = token;
      }
    });
  },

  /**
   * OAuth-style token provider. The provider owns caching and refresh;
   * on a 401 the pipeline calls `invalidate(token)` and retries once.
   */
  tokenProvider(provider: TokenProvider): AuthResolver {
    let lastToken: string | undefined;
    const resolver = (async (ctx: AuthSurface) => {
      const token = await provider.getToken();
      if (!token) {
        throw new AuthError('token provider returned an empty token');
      }
      lastToken = token;
      if (provider.apply) {
        provider.apply(ctx, token);
      } else {
        ctx.headers['Authorization'] = `Bearer ${token}`;
      }
    }) as AuthResolver;
    Object.defineProperty(resolver, 'provider', {
      value: provider,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(resolver, 'lastToken', {
      value: () => lastToken,
      enumerable: false,
      writable: false,
    });
    return resolver;
  },
};

/* -------------------------------------------------------------------------- */
/* Ready-made providers                                                        */
/* -------------------------------------------------------------------------- */

export interface ClientCredentialsProviderOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  /** Extra headers for the token request (e.g. tenant selectors). */
  headers?: Record<string, string>;
  /** Clock skew allowance in ms. Default `5_000`. */
  expirySkewMs?: number;
  /** Reuse an axios instance (mainly for tests). */
  axios?: AxiosInstance;
}

interface OAuthTokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

export interface ClientCredentialsProvider extends TokenProvider {
  /** Exposed for tests. */
  readonly cache: { token?: string; expiresAt?: number };
}

/**
 * A {@link TokenProvider} implementing the OAuth2 client-credentials flow.
 * Tokens are fetched lazily, cached until shortly before expiry, and
 * invalidated (forcing a re-fetch) after a 401.
 */
export function createClientCredentialsProvider(
  options: ClientCredentialsProviderOptions,
): ClientCredentialsProvider {
  const skewMs = options.expirySkewMs ?? 5_000;
  const cache: { token?: string; expiresAt?: number } = {};

  async function fetchToken(): Promise<void> {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: options.clientId,
      client_secret: options.clientSecret,
    });
    if (options.scopes && options.scopes.length > 0) {
      params.set('scope', options.scopes.join(' '));
    }

    const client = options.axios;
    let body: unknown;
    try {
      const res = client
        ? await client.post(options.tokenUrl, params.toString(), {
            headers: { 'content-type': 'application/x-www-form-urlencoded', ...options.headers },
            validateStatus: () => true,
          })
        : await fetch(options.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', ...options.headers },
            body: params.toString(),
          }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

      const status = res.status;
      body = res.data as unknown;
      if (status < 200 || status >= 300) {
        throw new Error(`token endpoint answered HTTP ${status}`);
      }
    } catch (err) {
      throw new AuthError(
        `client-credentials token fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const parsed = body as Partial<OAuthTokenResponse> | undefined;
    if (!parsed || typeof parsed.access_token !== 'string') {
      throw new AuthError('token endpoint response did not contain access_token');
    }
    cache.token = parsed.access_token;
    cache.expiresAt = Date.now() + (parsed.expires_in ?? 3600) * 1000 - skewMs;
  }

  return {
    cache,
    async getToken(): Promise<string> {
      if (cache.token && cache.expiresAt && Date.now() < cache.expiresAt) {
        return cache.token;
      }
      await fetchToken();
      return cache.token!;
    },
    invalidate(token?: string): void {
      if (token === undefined || cache.token === token) {
        cache.token = undefined;
        cache.expiresAt = undefined;
      }
    },
  };
}
