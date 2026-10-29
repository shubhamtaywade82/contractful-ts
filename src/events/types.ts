/**
 * Public types for the contractful-ts events runtime.
 *
 * The runtime wraps any WebSocket-shaped socket (browser `WebSocket`, the
 * Node `ws` package, or a user-supplied factory — Socket.IO users can pass
 * `() => io(url)`) and adds the production behaviours generated event
 * clients need: automatic reconnection with backoff, heartbeats, topic
 * routing, JSON envelopes and three browser-safe authentication modes.
 */

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
 * on the WebSocket upgrade request, so all modes work there:
 *
 * - `none` — no token handling (default).
 * - `query` — `?access_token=<token>` appended to the URL (per attempt).
 * - `subprotocol` — the token is passed as a WebSocket subprotocol.
 * - `first-message` — an auth frame is sent immediately after connect.
 */
export type WebSocketAuthMode = 'none' | 'query' | 'subprotocol' | 'first-message';

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
 * and other transports.
 */
export type SocketFactory = (
  url: string,
  protocols: string[],
) => SocketLike | Promise<SocketLike>;

/** Context handed to a routed message handler. */
export interface TopicContext {
  /** The topic the server frame carried (null when no topic could be extracted). */
  readonly topic: string | null;
  /** Values captured from `:param` / `*` segments of the subscribed pattern. */
  readonly params: Record<string, string>;
  /** The raw (pre-deserialization) frame data. */
  readonly raw: unknown;
}

/** Low-level handler for a routed message. */
export type MessageHandler = (message: unknown, ctx: TopicContext) => void;

/** Options for {@link EventsClient} (see `events/client.ts`). */
export interface EventsClientOptions {
  /** WebSocket URL, e.g. `wss://api.example.com/events`. */
  url: string;
  /** Subprotocols negotiated with the server. */
  protocols?: string[];
  /** Injectable socket factory (tests, Socket.IO, mocks). */
  socketFactory?: SocketFactory;
  /** How the token reaches the server. Default `none`. */
  authMode?: WebSocketAuthMode;
  /** Source of the auth token; called fresh before every (re)connect. */
  tokenProvider?: () => string | Promise<string>;
  /** Query parameter name for `authMode: 'query'`. Default `access_token`. */
  authQueryParameter?: string;
  /** Frame factory for `authMode: 'first-message'`. Default `{ type: 'auth', token }`. */
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
}
