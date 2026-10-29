/**
 * {@link EventsClient} — a topic-routed events connection.
 *
 * Wire format conventions are configurable but default to a JSON envelope
 * `{ topic, payload }`. Incoming frames are deserialized, their topic is
 * extracted, and the payload is routed to subscribers — exact topics,
 * `:param` patterns (`order/:id/created`), and the `*` wildcard. Outgoing
 * publishes are wrapped through `publishEnvelope`.
 *
 * Authentication supports every strategy that matters in practice: an
 * injectable {@link AuthProvider} (query params, subprotocols, upgrade
 * headers, connect messages — decided per (re)connection), or the simpler
 * `tokenProvider` + `authMode` combination (`query`, `subprotocol`,
 * `connect-message`, `header`, `ticket`). Server closes are policy-checked:
 * code `4001` (token expired) triggers `handleUnauthorized` and a single
 * refreshed reconnect; `4003`/`4004` surface as a terminal
 * {@link WebSocketApiError}.
 *
 * The subscription registry survives reconnections: when a
 * `subscribeEnvelope` is configured, every registered pattern is re-sent
 * after each (re)connect, and event ids (`.id` / `.eventId` by default) are
 * tracked so callers can catch up over REST after a disconnect.
 */

import { shouldReconnectOnClose, WS_CLOSE_CODES } from '../errors.js';
import { appendAuthQuery } from '../auth/provider.js';
import type { AuthMaterial, AuthProvider } from '../auth/provider.js';
import { ReconnectingSocket } from './socket.js';
import type {
  EventsClientOptions,
  EventsConnectionState,
  MessageHandler,
  TopicContext,
} from './types.js';

export type { EventsClientOptions };

interface Subscription {
  pattern: string;
  handler: MessageHandler;
}

function defaultSerialize(value: unknown): string | ArrayBuffer | Blob {
  return JSON.stringify(value);
}

function defaultDeserialize(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function defaultTopicExtractor(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  if (typeof record.topic === 'string') return record.topic;
  if (typeof record.event === 'string') return record.event;
  return null;
}

function defaultPayloadExtractor(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return message;
  const record = message as Record<string, unknown>;
  if ('payload' in record) return record.payload;
  if ('data' in record) return record.data;
  return message;
}

function defaultEventIdExtractor(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  if (typeof record.eventId === 'string') return record.eventId;
  if (typeof record.id === 'string') return record.id;
  return null;
}

/**
 * The low-level events client. Generated `defineEvents` classes (and the
 * OpenAPI/AsyncAPI/Postman/GraphQL generators) build on this; it is equally
 * usable directly:
 *
 * ```ts
 * const events = new EventsClient({ url: 'wss://api.example.com/events' });
 * await events.connect();
 * const off = events.subscribe('order.created', (message) => console.log(message));
 * await events.publish('order.create', { productId: 'p1', quantity: 2 });
 * ```
 */
export class EventsClient {
  readonly #options: EventsClientOptions;
  readonly #socket: ReconnectingSocket;
  readonly #subscriptions = new Map<number, Subscription>();
  /** pattern -> live subscriber count (drives server-side (re)subscribing). */
  readonly #patternCounts = new Map<string, number>();
  #nextSubscriptionId = 1;
  #lastEventId: string | null = null;
  readonly #stateHandlers = new Set<(state: EventsConnectionState) => void>();
  readonly #errorHandlers = new Set<(error: unknown) => void>();
  readonly #connectedHandlers = new Set<() => void>();
  readonly #disconnectedHandlers = new Set<() => void>();
  /** Per-attempt cache so one getAuth call feeds URL, protocols and headers. */
  #authMaterial: AuthMaterial | undefined;

  constructor(options: EventsClientOptions) {
    this.#options = options;
    const serialize = options.serialize ?? defaultSerialize;
    const authProvider = options.authProvider;

    const urlProvider = async (): Promise<string> => {
      let url = options.url;
      if (authProvider) {
        const material = await this.#getAuthMaterial();
        url = appendAuthQuery(url, material.query);
      } else if (options.authMode === 'query' && options.tokenProvider) {
        const token = await options.tokenProvider();
        const param = options.authQueryParameter ?? 'access_token';
        url = appendAuthQuery(url, { [param]: token });
      } else if (options.authMode === 'ticket' && options.tokenProvider) {
        const ticket = await options.tokenProvider();
        const param = options.authQueryParameter ?? 'ticket';
        url = appendAuthQuery(url, { [param]: ticket });
      }
      return url;
    };

    const protocolsProvider = async (): Promise<string[]> => {
      const base = options.protocols ?? [];
      if (authProvider) {
        const material = await this.#getAuthMaterial();
        return [...base, ...(material.protocols ?? [])];
      }
      if (options.authMode === 'subprotocol' && options.tokenProvider) {
        const token = await options.tokenProvider();
        return [...base, token];
      }
      return base;
    };

    const headersProvider = async (): Promise<Record<string, string> | undefined> => {
      if (authProvider) {
        const material = await this.#getAuthMaterial();
        return material.headers && Object.keys(material.headers).length > 0 ? material.headers : undefined;
      }
      if (options.authMode === 'header' && options.tokenProvider) {
        const token = await options.tokenProvider();
        return { Authorization: `Bearer ${token}` };
      }
      return undefined;
    };

    this.#socket = new ReconnectingSocket({
      url: urlProvider,
      protocols: protocolsProvider,
      headers: headersProvider,
      socketFactory: options.socketFactory,
      reconnect: options.reconnect,
      reconnectMaxAttempts: options.reconnectMaxAttempts,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      connectTimeoutMs: options.connectTimeoutMs,
      heartbeat:
        options.heartbeatIntervalMs && options.heartbeatIntervalMs > 0
          ? {
              intervalMs: options.heartbeatIntervalMs,
              payload: options.heartbeatPayload,
              timeoutMs: options.heartbeatTimeoutMs,
            }
          : undefined,
      onOpen: async (send) => {
        try {
          // Handshake: connect-message auth first (provider or legacy),
          // then restore server-side subscriptions.
          if (authProvider) {
            const material = await this.#getAuthMaterial();
            if (material.connectMessage !== undefined) {
              send(serialize(material.connectMessage));
            }
          } else if (
            (options.authMode === 'first-message' || options.authMode === 'connect-message') &&
            options.tokenProvider
          ) {
            const token = await options.tokenProvider();
            const frame = options.authMessage?.(token) ?? { type: 'auth', token };
            send(serialize(frame));
          }
          this.#resendSubscriptions(send);
        } finally {
          this.#authMaterial = undefined; // next connection re-authenticates
        }
      },
      onMessage: (data) => this.#routeFrame(data),
      onClose: (info) => {
        this.#authMaterial = undefined;
        if (info.userInitiated) {
          for (const handler of this.#disconnectedHandlers) handler();
        }
      },
      onError: (error) => {
        for (const handler of this.#errorHandlers) handler(error);
      },
      onStateChange: (state, info) => {
        for (const handler of this.#stateHandlers) handler(state);
        if (state === 'open') for (const handler of this.#connectedHandlers) handler();
        // Terminal connection failures (vetoed close codes, exhausted
        // budgets) surface through onError once the waiters are settled.
        if (state === 'failed' && info?.error) {
          for (const handler of this.#errorHandlers) handler(info.error);
        }
      },
      shouldReconnect: async (info) => {
        if (!authProvider?.handleUnauthorized) return shouldReconnectOnClose(info.code);
        if (info.code === WS_CLOSE_CODES.TOKEN_EXPIRED) {
          // Refresh (single-flight in well-behaved providers) and reconnect
          // only when the provider reports success.
          try {
            return await authProvider.handleUnauthorized({
              transport: 'websocket',
              url: options.url,
            });
          } catch (err) {
            for (const handler of this.#errorHandlers) handler(err);
            return false;
          }
        }
        return shouldReconnectOnClose(info.code);
      },
    });

    // Token state changed out-of-band (e.g. proactive refresh): reconnect
    // with fresh credentials before the server notices the expiry.
    authProvider?.onAuthStateChanged?.(() => {
      void this.#socket.reconnect();
    });
  }

  get url(): string {
    return this.#options.url;
  }

  get state(): EventsConnectionState {
    return this.#socket.state;
  }

  /**
   * The event id of the most recently received frame (`null` before the
   * first event, or when the server sends no ids). Use it to catch up over
   * REST after a disconnect:
   *
   * ```ts
   * const missed = await api.events.list({ query: { since: client.getLastEventId() } });
   * ```
   */
  getLastEventId(): string | null {
    return this.#lastEventId;
  }

  /** Opens the connection (resolves on first open; see {@link ReconnectingSocket.open}). */
  connect(): Promise<void> {
    return this.#socket.open();
  }

  /** Closes the connection and stops reconnection. */
  disconnect(code = 1000, reason = 'client closed'): Promise<void> {
    return this.#socket.close(code, reason);
  }

  /**
   * Forces a reconnect with fresh auth material — used automatically on
   * `onAuthStateChanged`, available for manual rotation flows.
   */
  reconnect(): Promise<void> {
    this.#authMaterial = undefined;
    return this.#socket.reconnect();
  }

  /**
   * Publishes a message on a topic. The frame goes through `serialize`
   * and `publishEnvelope` (`{ topic, payload }` by default).
   */
  async publish(topic: string, message?: unknown): Promise<void> {
    const envelope = this.#options.publishEnvelope?.(topic, message) ?? {
      topic,
      payload: message,
    };
    this.#socket.send(this.#serialize(envelope));
  }

  /**
   * Subscribes to a topic pattern. Works before, during and after
   * connections — the registry survives reconnections. Returns an
   * unsubscribe function.
   */
  subscribe(pattern: string, handler: MessageHandler): () => void {
    const id = this.#nextSubscriptionId++;
    this.#subscriptions.set(id, { pattern, handler });
    const previous = this.#patternCounts.get(pattern) ?? 0;
    this.#patternCounts.set(pattern, previous + 1);
    if (previous === 0) this.#sendSubscribe(pattern);
    return () => {
      this.#subscriptions.delete(id);
      const remaining = (this.#patternCounts.get(pattern) ?? 1) - 1;
      if (remaining <= 0) {
        this.#patternCounts.delete(pattern);
        this.#sendUnsubscribe(pattern);
      } else {
        this.#patternCounts.set(pattern, remaining);
      }
    };
  }

  onConnected(handler: () => void): () => void {
    this.#connectedHandlers.add(handler);
    return () => this.#connectedHandlers.delete(handler);
  }

  onDisconnected(handler: () => void): () => void {
    this.#disconnectedHandlers.add(handler);
    return () => this.#disconnectedHandlers.delete(handler);
  }

  onError(handler: (error: unknown) => void): () => void {
    this.#errorHandlers.add(handler);
    return () => this.#errorHandlers.delete(handler);
  }

  onState(handler: (state: EventsConnectionState) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  /* ---------------------------------------------------------------------- */

  async #getAuthMaterial(): Promise<AuthMaterial> {
    let material = this.#authMaterial;
    if (material === undefined) {
      const provider: AuthProvider = this.#options.authProvider!;
      material = await provider.getAuth({
        transport: 'websocket',
        url: this.#options.url,
      });
      this.#authMaterial = material;
    }
    return material;
  }

  #sendSubscribe(pattern: string): void {
    if (!this.#options.subscribeEnvelope || this.#socket.state !== 'open') return;
    try {
      this.#socket.send(this.#serialize(this.#options.subscribeEnvelope(pattern)));
    } catch (err) {
      for (const handler of this.#errorHandlers) handler(err);
    }
  }

  #sendUnsubscribe(pattern: string): void {
    if (!this.#options.unsubscribeEnvelope || this.#socket.state !== 'open') return;
    try {
      this.#socket.send(this.#serialize(this.#options.unsubscribeEnvelope(pattern)));
    } catch (err) {
      for (const handler of this.#errorHandlers) handler(err);
    }
  }

  #resendSubscriptions(send: (data: string | ArrayBuffer | Blob) => void): void {
    const envelope = this.#options.subscribeEnvelope;
    if (!envelope) return;
    for (const pattern of this.#patternCounts.keys()) {
      send(this.#serialize(envelope(pattern)));
    }
  }

  get #serialize(): (value: unknown) => string | ArrayBuffer | Blob {
    return this.#options.serialize ?? defaultSerialize;
  }

  #routeFrame(data: unknown): void {
    if (data === null || data === undefined) return;
    let message: unknown;
    try {
      message = this.#options.deserialize
        ? this.#options.deserialize(data)
        : defaultDeserialize(data);
    } catch (err) {
      for (const handler of this.#errorHandlers) handler(err);
      return;
    }

    const topic = this.#options.topicExtractor
      ? this.#options.topicExtractor(message)
      : defaultTopicExtractor(message);
    const payload =
      topic !== null && topic !== undefined
        ? this.#options.payloadExtractor
          ? this.#options.payloadExtractor(message)
          : defaultPayloadExtractor(message)
        : message;

    const eventId =
      (this.#options.eventIdExtractor
        ? this.#options.eventIdExtractor(message)
        : defaultEventIdExtractor(message)) ?? null;
    if (eventId) this.#lastEventId = eventId;

    for (const sub of [...this.#subscriptions.values()]) {
      const params = matchTopic(sub.pattern, topic ?? null);
      if (params === null) continue;
      const ctx: TopicContext = {
        topic: topic ?? null,
        params,
        raw: data,
        eventId: eventId ?? undefined,
      };
      try {
        sub.handler(payload, ctx);
      } catch (err) {
        for (const handler of this.#errorHandlers) handler(err);
      }
    }
  }
}

/** Matches `order/:id/created` (params), `a/<star>/b` (single-segment wildcard) and `*` (everything). */
export function matchTopic(pattern: string, topic: string | null): Record<string, string> | null {
  if (pattern === '*') return {};
  if (topic === null) return null;
  if (pattern === topic) return {};
  const patternSegments = pattern.split('/');
  const topicSegments = topic.split('/');
  if (patternSegments.length !== topicSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i]!;
    const t = topicSegments[i]!;
    if (p.startsWith(':') && p.length > 1) {
      params[p.slice(1)] = t;
      continue;
    }
    if (p === '*') continue;
    if (p !== t) return null;
  }
  return params;
}
