/**
 * Deterministic token lifecycle management with single-flight refresh.
 *
 * Parallel callers share one in-flight refresh promise, so a burst of requests
 * after expiry produces exactly one token-endpoint call. Tokens are refreshed
 * proactively inside a configurable window before they expire, and consumers
 * can subscribe to state changes (used to reconnect WebSockets after a
 * refresh). Storage stays outside this module — the manager is deliberately
 * memory-only and safe to recreate.
 */

/** A token as returned by a token endpoint or provider. */
export interface Token {
  accessToken: string;
  /** Epoch milliseconds; absent when the token does not expire. */
  expiresAt?: number;
  /** Kept for refresh-token flows (persistence is the app's concern). */
  refreshToken?: string;
  /** Scopes the token was issued for, when known. */
  scopes?: string[];
}

export interface TokenManagerOptions {
  /** Fetch (or refresh) a token for the requested scopes. */
  fetchToken: (scopes: string[]) => Promise<Token>;
  /** Refresh this long before expiry. Default `30_000` ms. */
  refreshWindowMs?: number;
  /** Clock override for tests. Default `Date.now`. */
  now?: () => number;
}

/** The handle returned by {@link createTokenManager}. */
export interface TokenManager {
  /** Returns a valid access token, refreshing single-flight when needed. */
  getToken(scopes?: string[]): Promise<string>;
  /** Drops the cached token; the next `getToken` call refetches. */
  clearToken(): void;
  /** The cached token, if any (exposed for diagnostics). */
  readonly current: Token | null;
  /**
   * Subscribes to token state changes (set / refreshed / cleared). Feeds
   * `AuthProvider.onAuthStateChanged`. Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void;
}

/**
 * Creates a single-flight token manager.
 *
 * ```ts
 * const tokens = createTokenManager({
 *   async fetchToken(scopes) {
 *     const res = await fetch('https://auth.example.com/oauth/token', {
 *       method: 'POST',
 *       body: new URLSearchParams({
 *         grant_type: 'client_credentials',
 *         client_id: process.env.CLIENT_ID!,
 *         scope: scopes.join(' '),
 *       }),
 *     });
 *     const body = await res.json();
 *     return {
 *       accessToken: body.access_token,
 *       expiresAt: Date.now() + body.expires_in * 1000,
 *     };
 *   },
 * });
 * ```
 */
export function createTokenManager(options: TokenManagerOptions): TokenManager {
  const refreshWindowMs = options.refreshWindowMs ?? 30_000;
  const now = options.now ?? Date.now;

  let token: Token | null = null;
  let refreshPromise: Promise<Token> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function isExpiringSoon(current: Token): boolean {
    if (!current.expiresAt) return false;
    return current.expiresAt - now() <= refreshWindowMs;
  }

  async function getToken(scopes: string[] = []): Promise<string> {
    if (token && !isExpiringSoon(token) && scopesSatisfied(token.scopes, scopes)) {
      return token.accessToken;
    }

    if (!refreshPromise) {
      refreshPromise = options
        .fetchToken(scopes)
        .then((next) => {
          token = next;
          return next;
        })
        .finally(() => {
          refreshPromise = null;
        });
      void refreshPromise.then(notify, () => undefined);
    }

    const refreshed = await refreshPromise;
    return refreshed.accessToken;
  }

  function clearToken(): void {
    const had = token !== null;
    token = null;
    if (had) notify();
  }

  return {
    getToken,
    clearToken,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get current() {
      return token;
    },
  };
}

/** A cached token satisfies a request when it covers the requested scopes. */
function scopesSatisfied(have: string[] | undefined, want: string[]): boolean {
  if (!want || want.length === 0) return true;
  if (!have || have.length === 0) return false; // unknown scopes: be safe, refetch
  return want.every((scope) => have.includes(scope));
}
