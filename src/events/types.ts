/**
 * Public types for the contractful-ts events runtime.
 *
 * The runtime wraps any WebSocket-shaped socket (browser `WebSocket`, the
 * Node `ws` package, or a user-supplied factory — Socket.IO users can pass
 * `() => io(url)`) and adds the production behaviours generated event
 * clients need: automatic reconnection with backoff, heartbeats, topic
 * routing, JSON envelopes and three browser-safe authentication modes.
 */

import type { AuthProvider } from '../auth/provider.js';

/** Lifecycle of an events connection. */
export type EventsConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'failed';

/**
 * How the auth token reaches the server. Browsers cannot set custom headers
 * on the WebSocket upgrade request, so most modes work there:
 *
 * - `none` — no token handling (default).
 * - `query` — `?access_token=<token>` appended to the URL (per attempt).
 * - `subprotocol` — the token is passed as a WebSocket subprotocol.
 * - `connect-message` — an auth frame is sent immediately after connect.
 * - `first-message` — alias of `connect-message` (kept for compatibility).
 * - `header` — auth headers on the upgrade request (Node `ws` or a custom
 *   `socketFactory` only — browsers cannot set upgrade headers).
 * - `ticket` — a one-time ticket is fetched (via `authProvider`) and sent as
 *   a query parameter; the server consumes it on first use.
 *
 * When `authProvider` is set it supersedes `tokenProvider` and decides the
 * material per (re)connection itself.
 */
export type WebSocketAuthMode =
  | 'none'
  | 'query'
  | 'subprotocol'
  | 'connect-message'
  | 'first-message'
  | 'header'
  | 'ticket';

/**
 * Minimal socket surface the runtime needs. Compatible with the browser
 * `WebSocket` and the Node `ws` package; handler parameters are `any` so
 * native implementations assign without casts.
 */
export interface SocketLike {
  send(data: string | ArrayBuffer | Blob): void;
  close(code?: number, reason?: string): void;
  readonly readyState?: number;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
}

/**
 * Creates a socket for a connection attempt. May return a promise (used for
 * the lazy `ws` import in Node). Inject this to test, or to adapt Socket.IO
 * and other transports. `init.headers` carries upgrade-request headers for
 * factories that support them (Node `ws`); browser sockets ignore it.
 */
export type SocketFactory = (
  url: string,
  protocols: string[],
  init?: { headers?: Record<string, string> },
) => SocketLike | Promise<SocketLike>;

/** Context handed to a routed message handler. */
export interface TopicContext {
  /** The topic the server frame carried (null when no topic could be extracted). */
  readonly topic: string | null;
  /** Values captured from `:param` / `*` segments of the subscribed pattern. */
  readonly params: Record<string, string>;
  /** The raw (pre-deserialization) frame data. */
  readonly raw: unknown;
  /** Envelope event id, when the server sent one (see `eventIdExtractor`). */
  readonly eventId?: string;
}

/** Low-level handler for a routed message. */
export type MessageHandler = (message: unknown, ctx: TopicContext) => void;

/**
 * Envelope for servers that fan multiple event types over one channel,
 * discriminated by `type` — the shape generated for multi-message
 * AsyncAPI channels and the recommended contract for new events APIs:
 *
 * ```ts
 * type OrderEvent =
 *   | EventEnvelope<'order.created', OrderCreated>
 *   | EventEnvelope<'order.cancelled', OrderCancelled>;
 *
 * function handle(event: OrderEvent) {
 *   switch (event.type) {
 *     case 'order.created': return notify(event.payload);
 *     case 'order.cancelled': return refund(event.payload);
 *   }
 * }
 * ```
 */
export interface EventEnvelope<Type extends string, Payload> {
  type: Type;
  eventId: string;
  occurredAt: string;
  payload: Payload;
}

/** Options for {@link EventsClient} (see `events/client.ts`). */
export interface EventsClientOptions {
  /** WebSocket URL, e.g. `wss://api.example.com/events`. */
  url: string;
  /** Subprotocols negotiated with the server. */
  protocols?: string[];
  /** Injectable socket factory (tests, Socket.IO, mocks). */
  socketFactory?: SocketFactory;
  /**
   * Injectable auth provider — supersedes `tokenProvider` when present.
   * `getAuth({ transport: 'websocket', ... })` runs before every
   * (re)connection and may return query params, protocols, upgrade headers
   * or a connect message. On close code 4001 the client calls
   * `handleUnauthorized` and reconnects only when it resolves `true`.
   */
  authProvider?: AuthProvider;
  /** How the token reaches the server. Default `none`. */
  authMode?: WebSocketAuthMode;
  /** Source of the auth token; called fresh before every (re)connect. */
  tokenProvider?: () => string | Promise<string>;
  /** Query parameter name for `authMode: 'query'` / `'ticket'`. Default `access_token` (`ticket` mode: `ticket`). */
  authQueryParameter?: string;
  /** Frame factory for `authMode: 'connect-message'`. Default `{ type: 'auth', token }`. */
  authMessage?: (token: string) => unknown;
  /** Automatically reconnect after unexpected drops. Default `true`. */
  reconnect?: boolean;
  /** Reconnect attempts before giving up. Default `10`. */
  reconnectMaxAttempts?: number;
  /** First retry delay; doubles every attempt. Default `250`. */
  reconnectBaseDelayMs?: number;
  /** Upper bound for a single retry delay. Default `30_000`. */
  reconnectMaxDelayMs?: number;
  /** Per-attempt connect timeout. Default `10_000`. */
  connectTimeoutMs?: number;
  /** Send a heartbeat frame every N ms. `0` disables. Default `0`. */
  heartbeatIntervalMs?: number;
  /** Heartbeat frame. Default `{ type: 'ping' }`. */
  heartbeatPayload?: unknown;
  /** Force-close the socket when nothing arrived for N ms. Default `0` (off). */
  heartbeatTimeoutMs?: number;
  /** Serializer for outgoing frames. Default `JSON.stringify`. */
  serialize?: (value: unknown) => string | ArrayBuffer | Blob;
  /** Deserializer for incoming frames. Default: `JSON.parse` for strings. */
  deserialize?: (data: unknown) => unknown;
  /**
   * Wraps a publish into a wire frame. Default: `{ topic, payload }`.
   * Pair with `topicExtractor` when the server uses another envelope.
   */
  publishEnvelope?: (topic: string, message: unknown) => unknown;
  /** Reads the topic off an incoming frame. Default: `.topic` / `.event`. */
  topicExtractor?: (message: unknown) => string | null | undefined;
  /** Reads the payload off an incoming frame. Default: `.payload` / `.data`. */
  payloadExtractor?: (message: unknown) => unknown;
  /** Reads an event id off an incoming frame. Default: `.id` / `.eventId`. */
  eventIdExtractor?: (message: unknown) => string | null | undefined;
  /**
   * Server-side subscription protocol: when set, a subscribe frame is sent
   * for every registered pattern after each (re)connect, and immediately
   * when a pattern is subscribed while connected. Default: subscriptions
   * are routed client-side only.
   */
  subscribeEnvelope?: (pattern: string) => unknown;
  /** Counterpart of `subscribeEnvelope`, sent when the last subscriber of a pattern leaves. */
  unsubscribeEnvelope?: (pattern: string) => unknown;
}
