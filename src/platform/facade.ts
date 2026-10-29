/**
 * The unified platform facade: separate HTTP and event transports under one
 * typed, domain-oriented client with shared authentication and one
 * `dispose()` to tear everything down.
 *
 * Transports keep their own lifecycles internally (REST is stateless and
 * retry-safe; the events connection is stateful with reconnection) — the
 * facade merges them at the API surface, not at the protocol level.
 *
 * ```ts
 * const platform = createPlatformClient({
 *   rest: () => new PetstoreApi({ baseUrl: 'https://api.example.com' }),
 *   events: () => new ShopEvents({ authProvider }),
 *   authProvider,
 * });
 *
 * await platform.events.connect();
 * const product = await platform.rest.getProduct({ params: { id: 'p1' } });
 * const off = platform.events.onProductCreated((msg) => invalidate(msg));
 * await platform.dispose();
 * ```
 */

import type { AuthProvider } from '../auth/provider.js';
import { authProviderResolver } from '../auth/provider.js';
import type { EventsClient } from '../events/client.js';
import type { AuthResolver } from '../middleware/auth.js';

/** Identifying headers sent on every request for compatibility tracking. */
export interface ClientIdentity {
  /** Header value for `X-Client-Name`. */
  clientName: string;
  /** Header value for `X-Client-Version`. */
  clientVersion: string;
}

export interface PlatformClientOptions<
  TRest,
  TEvents extends { connect(): Promise<void>; disconnect(code?: number, reason?: string): Promise<void> },
> {
  /**
   * The REST client, or a factory receiving the shared auth context. When an
   * {@link AuthProvider} is set, a bridging resolver is passed as
   * `options.auth` (401 answers flow through `handleUnauthorized`).
   */
  rest: TRest | ((ctx: { authProvider?: AuthProvider; auth?: AuthResolver }) => TRest);
  /**
   * The events client (a `defineEvents` class or {@link EventsClient}), or a
   * factory receiving the shared auth context. Connection lifecycle stays
   * explicit: call `connect()` yourself (or set `autoConnectEvents`).
   */
  events: TEvents | ((ctx: { authProvider?: AuthProvider }) => TEvents);
  /** Shared, transport-aware authentication for both clients. */
  authProvider?: AuthProvider;
  /** Opens the events connection eagerly instead of waiting for `connect()`. */
  autoConnectEvents?: boolean;
  /**
   * Sent as `X-Client-Name` / `X-Client-Version` when the REST transport is
   * created through this facade (pass the same values to the events hello
   * frame yourself when the server needs them there).
   */
  identity?: ClientIdentity;
}

export interface PlatformClient<TRest, TEvents> {
  /** The HTTP client. */
  rest: TRest;
  /** The events (WebSocket) client. */
  events: TEvents;
  /** The shared auth provider, when one was configured. */
  authProvider?: AuthProvider;
  /** Default request headers derived from `identity`. */
  readonly identityHeaders: Record<string, string>;
  /** Disconnects the events client and releases shared resources. */
  dispose(): Promise<void>;
}

function isFactory<T>(value: T | ((ctx: never) => T)): value is (ctx: never) => T {
  return typeof value === 'function';
}

/**
 * Builds the unified facade. Both transports are wired to the same
 * {@link AuthProvider}: HTTP requests get a bridging resolver (single 401
 * refresh + retry), the events client should be constructed with
 * `authProvider` to share close-code-aware reconnection.
 */
export function createPlatformClient<
  TRest,
  TEvents extends { connect(): Promise<void>; disconnect(code?: number, reason?: string): Promise<void> },
>(
  options: PlatformClientOptions<TRest, TEvents>,
): PlatformClient<TRest, TEvents> {
  const { authProvider } = options;

  const identityHeaders: Record<string, string> = options.identity
    ? { 'X-Client-Name': options.identity.clientName, 'X-Client-Version': options.identity.clientVersion }
    : {};

  const rest: TRest = isFactory(options.rest)
    ? options.rest({
        authProvider,
        auth: authProvider ? authProviderResolver(authProvider) : undefined,
      } as never)
    : options.rest;

  const events: TEvents = isFactory(options.events)
    ? options.events({ authProvider } as never)
    : options.events;

  if (options.autoConnectEvents) {
    void events.connect();
  }

  return {
    rest,
    events,
    authProvider,
    identityHeaders,
    async dispose(): Promise<void> {
      await events.disconnect();
    },
  };
}
