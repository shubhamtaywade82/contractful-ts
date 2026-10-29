/**
 * The heart of the demo: ONE credential authority shared by REST and WS.
 *
 * A `TokenManager` owns the access token (single-flight refresh, proactive
 * refresh window). A transport-aware `AuthProvider` sits on top of it:
 *
 * - HTTP calls get `Authorization: Bearer <token>`;
 * - every WebSocket (re)connection FIRST mints a fresh one-time ticket
 *   over an authenticated REST call, then connects with `?ticket=...` —
 *   the browser-safe pattern that never puts the long-lived token in a URL.
 *
 * Recovery is shared too: a REST 401 or a WS close 4001 both run
 * `handleUnauthorized`, which drops the cached token and asks for exactly
 * one retry; and because the manager notifies `onAuthStateChanged`, a
 * healthy socket is proactively rotated onto fresh credentials before the
 * server even notices the old token died.
 */

import {
  createTokenManager,
  type AuthProvider,
  type TokenManager,
} from '../../dist/index.js';
import type { SessionTokenBody, WsTicketBody } from './server.js';

/** Everything the shared provider needs from the credential desk. */
export interface CourierAuthDeps {
  /** POST /auth/token — the client-credentials exchange. */
  issueToken(): Promise<SessionTokenBody>;
  /** POST /auth/ws-ticket — mint a one-time ticket with this bearer. */
  issueWebSocketTicket(bearer: string): Promise<WsTicketBody>;
}

export interface SharedTicketAuth {
  provider: AuthProvider;
  tokens: TokenManager;
}

/**
 * Builds the shared credential authority.
 *
 * ```ts
 * const { provider } = createSharedTicketAuth({
 *   issueToken: () => authApi.issueToken({ clientId, clientSecret }),
 *   issueWebSocketTicket: (bearer) =>
 *     authApi.issueWebSocketTicket({ _headers: { Authorization: bearer } }),
 * });
 * ```
 */
export function createSharedTicketAuth(deps: CourierAuthDeps): SharedTicketAuth {
  const tokens = createTokenManager({
    refreshWindowMs: 5_000,
    async fetchToken() {
      const session = await deps.issueToken();
      return {
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        scopes: session.scopes,
      };
    },
  });

  const provider: AuthProvider = {
    async getAuth(context) {
      const token = await tokens.getToken(context.scopes);
      if (context.transport === 'websocket') {
        // One-time ticket per (re)connection attempt. The ticket dies with
        // the URL it was minted for — never reuse it.
        const { ticket } = await deps.issueWebSocketTicket(`Bearer ${token}`);
        return { query: { ticket } };
      }
      return { headers: { Authorization: `Bearer ${token}` } };
    },

    async handleUnauthorized() {
      // REST 401 or WS close 4001: drop the cached token, allow one retry.
      // The refresh itself is single-flight in the manager, so a REST retry
      // and a socket rotation happening at the same time share one
      // /auth/token call.
      tokens.clearToken();
      return true;
    },

    onAuthStateChanged(listener) {
      // Token rotated out-of-band → the events client proactively
      // reconnects with fresh material (new ticket included).
      return tokens.onChange(listener);
    },
  };

  return { provider, tokens };
}
