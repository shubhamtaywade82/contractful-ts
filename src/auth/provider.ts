/**
 * The injectable authentication contract shared by HTTP and WebSocket
 * transports.
 *
 * Generated clients never embed credentials. They describe *what* auth a
 * specification requires and delegate secret handling to an
 * {@link AuthProvider} supplied at runtime. The provider is transport-aware:
 * browsers cannot set arbitrary headers on the WebSocket upgrade request, so a
 * provider can return query parameters, subprotocols or a connect message for
 * `transport: 'websocket'` while sticking to `Authorization` headers for
 * `transport: 'http'`.
 *
 * ```ts
 * const authProvider: AuthProvider = {
 *   async getAuth(context) {
 *     const token = await tokenManager.getToken(context.scopes);
 *     if (context.transport === 'websocket') {
 *       const { ticket } = await rest.auth.createWebSocketTicket();
 *       return { query: { ticket } };          // browser-safe one-time ticket
 *     }
 *     return { headers: { Authorization: `Bearer ${token}` } };
 *   },
 *   async handleUnauthorized() {
 *     tokenManager.clearToken();
 *     return true;                              // refresh happened, retry once
 *   },
 * };
 * ```
 */

import type { AuthResolver, AuthSurface, TokenProvider } from '../middleware/auth.js';
import type { TokenManager } from './token-manager.js';

/** Transports an {@link AuthContext} can be issued for. */
export type AuthTransport = 'http' | 'websocket' | 'sse' | 'graphql';

/** Everything the provider knows about the call being authenticated. */
export interface AuthContext {
  transport: AuthTransport;
  url: string;
  method?: string;
  path?: string;
  /** Channel / topic name for event transports. */
  channel?: string;
  /** Contract / operation name, e.g. `listOrders`. */
  operationId?: string;
  /** Scopes the specification attached to this operation. */
  scopes?: string[];
  /** 0-based attempt counter (present on retry attempts). */
  attempt?: number;
}

/** The credentials a provider hands back for one call or connection. */
export interface AuthMaterial {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** Value for a `Cookie` header (HTTP transports). */
  cookie?: string;
  /** Extra WebSocket subprotocols (websocket transports). */
  protocols?: string[];
  /** Frame sent immediately after connect (websocket transports). */
  connectMessage?: unknown;
}

/**
 * Runtime authentication surface. `getAuth` runs before every request and
 * before every (re)connection; `handleUnauthorized` is invoked exactly once
 * per request/connection when the server answers 401 (HTTP) or closes with an
 * auth-related code (WebSocket) — return `true` to retry, `false` to surface
 * the failure. `onAuthStateChanged` lets the client proactively reconnect
 * sockets after an out-of-band token refresh.
 */
export interface AuthProvider {
  getAuth(context: AuthContext): Promise<AuthMaterial>;

  /**
   * Called when the server returns 401/403 or closes the WebSocket with an
   * authentication-related code. Return `true` if the request/connection
   * should be retried with fresh credentials.
   */
  handleUnauthorized?(context: AuthContext): Promise<boolean>;

  /**
   * Optional notification when token state changes. Useful for reconnecting
   * WebSockets after refresh. Returns an unsubscribe function.
   */
  onAuthStateChanged?(listener: () => void): () => void;
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

/** An {@link AuthProvider} that always returns the same material. */
export function staticAuthProvider(material: AuthMaterial): AuthProvider {
  return {
    async getAuth() {
      return material;
    },
  };
}

/** `Authorization: Bearer <token>` for every transport except WebSocket. */
export function bearerAuthProvider(
  getToken: (context: AuthContext) => string | Promise<string>,
): AuthProvider {
  return {
    async getAuth(context) {
      const token = await getToken(context);
      if (!token) throw new Error('bearerAuthProvider: token getter returned an empty token');
      if (context.transport === 'websocket') {
        return { query: { access_token: token } };
      }
      return { headers: { Authorization: `Bearer ${token}` } };
    },
  };
}

/** API key in a header (default) or a query parameter. */
export function apiKeyAuthProvider(options: {
  name: string;
  value: (context: AuthContext) => string | Promise<string>;
  in?: 'header' | 'query';
}): AuthProvider {
  return {
    async getAuth(context) {
      const value = await options.value(context);
      if (!value) throw new Error(`apiKeyAuthProvider: ${options.name} resolved to an empty value`);
      return options.in === 'query'
        ? { query: { [options.name]: value } }
        : { headers: { [options.name]: value } };
    },
  };
}

/**
 * Full {@link AuthProvider} backed by a {@link TokenManager} single-flight
 * refresh. HTTP requests get a bearer header; WebSocket connections use the
 * configured browser-safe mode (`query` by default, or `subprotocol` /
 * `connect-message`).
 */
export function authProviderFromTokenManager(
  manager: TokenManager,
  options: { wsAuthMode?: 'query' | 'subprotocol' | 'connect-message'; wsQueryParameter?: string } = {},
): AuthProvider {
  const wsMode = options.wsAuthMode ?? 'query';
  const wsParam = options.wsQueryParameter ?? 'access_token';
  return {
    async getAuth(context) {
      const token = await manager.getToken(context.scopes);
      if (!token) throw new Error('token manager returned an empty access token');
      if (context.transport === 'websocket') {
        if (wsMode === 'subprotocol') return { protocols: [token] };
        if (wsMode === 'connect-message') return { connectMessage: { type: 'auth', token } };
        return { query: { [wsParam]: token } };
      }
      return { headers: { Authorization: `Bearer ${token}` } };
    },
    async handleUnauthorized() {
      manager.clearToken();
      return true;
    },
    onAuthStateChanged(listener) {
      return manager.onChange(listener);
    },
  };
}

/**
 * The one-time WebSocket ticket pattern — the browser-safe way to
 * authenticate a socket without putting a long-lived token in the URL:
 *
 * 1. `fetchTicket` calls a REST endpoint (`POST /auth/websocket-ticket`),
 * 2. the server returns a short-lived, single-use ticket,
 * 3. the socket connects with `?ticket=<value>` and the ticket is consumed.
 */
export function wsTicketAuthProvider<TTicket extends { ticket: string } = { ticket: string }>(
  fetchTicket: () => Promise<TTicket>,
  options: { queryParameter?: string } = {},
): AuthProvider {
  const param = options.queryParameter ?? 'ticket';
  return {
    async getAuth() {
      const result = await fetchTicket();
      if (!result?.ticket) throw new Error('wsTicketAuthProvider: fetchTicket returned no ticket');
      return { query: { [param]: result.ticket } };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Bridges                                                                     */
/* -------------------------------------------------------------------------- */

/** Applies query material to a URL, returning the updated URL. */
export function appendAuthQuery(url: string, query: Record<string, string> | undefined): string {
  if (!query || Object.keys(query).length === 0) return url;
  const joiner = url.includes('?') ? '&' : '?';
  const params = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${url}${joiner}${params}`;
}

/**
 * Bridges an {@link AuthProvider} into the `auth:` resolver consumed by
 * `defineApi` clients. The resolver stamps headers/query from
 * `getAuth({ transport: 'http', ... })`; a 401 answer triggers
 * `handleUnauthorized` and — only when it resolves `true` — a single retry.
 */
export function authProviderResolver(provider: AuthProvider): AuthResolver {
  const bridge: TokenProvider = {
    async getToken(): Promise<string> {
      return ''; // material is applied by the resolver body, not via token
    },
    async onUnauthorized(info: {
      url: string;
      method?: string;
      path?: string;
      operationId?: string;
      attempt?: number;
      scopes?: string[];
    }): Promise<boolean> {
      if (!provider.handleUnauthorized) return false;
      return provider.handleUnauthorized({
        transport: 'http',
        url: info.url,
        method: info.method,
        path: info.path,
        operationId: info.operationId,
        scopes: info.scopes,
        attempt: info.attempt,
      });
    },
  };

  const resolver = (async (surface: AuthSurface) => {
    const context: AuthContext = {
      transport: 'http',
      url: surface.request?.url ?? '',
      method: surface.request?.method,
      path: surface.request?.path,
      operationId: surface.request?.operationId,
      scopes: surface.request?.scopes,
      attempt: surface.request?.attempt,
    };
    const material = await provider.getAuth(context);
    if (material.headers) {
      for (const [key, value] of Object.entries(material.headers)) surface.headers[key] = value;
    }
    if (material.query) {
      for (const [key, value] of Object.entries(material.query)) surface.query.set(key, value);
    }
    if (material.cookie) {
      const existing = surface.headers['Cookie'];
      surface.headers['Cookie'] = existing ? `${existing}; ${material.cookie}` : material.cookie;
    }
  }) as AuthResolver;

  Object.defineProperty(resolver, 'provider', { value: bridge, enumerable: false, writable: false });
  return resolver;
}
