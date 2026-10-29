/**
 * {@link EventsClient} — a topic-routed events connection.
 *
 * Wire format conventions are configurable but default to a JSON envelope
 * `{ topic, payload }`. Incoming frames are deserialized, their topic is
 * extracted, and the payload is routed to subscribers — exact topics,
 * `:param` patterns (`order/:id/created`), and the `*` wildcard. Outgoing
 * publishes are wrapped through `publishEnvelope`. Authentication supports
 * the three strategies that work in browsers (query, subprotocol,
 * first-message) since the WebSocket upgrade cannot carry custom headers.
 */

import { EventsError } from '../errors.js';
import { ReconnectingSocket } from './socket.js';
import type {
  EventsClientOptions,
  EventsConnectionState,
  MessageHandler,
  SocketFactory,
  TopicContext,
} from './types.js';

export type { EventsClientOptions };

interface Subscription {
  pattern: string;
  segments: string[];
  handler: MessageHandler;
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
  #nextSubscriptionId = 1;
  readonly #stateHandlers = new Set<(state: EventsConnectionState) => void>();
  readonly #errorHandlers = new Set<(error: unknown) => void>();
  readonly #connectedHandlers = new Set<() => void>();
  readonly #disconnectedHandlers = new Set<() => void>();

  constructor(options: EventsClientOptions) {
    this.#options = options;
    const serialize = options.serialize ?? defaultSerialize;

    const urlProvider = async (): Promise<string> => {
      if (options.authMode === 'query' && options.tokenProvider) {
        const token = await options.tokenProvider();
        const param = options.authQueryParameter ?? 'access_token';
        const joiner = options.url.includes('?') ? '&' : '?';
        return `${options.url}${joiner}${encodeURIComponent(param)}=${encodeURIComponent(token)}`;
      }
      return options.url;
    };

    const protocolsProvider = async (): Promise<string[]> => {
      const base = options.protocols ?? [];
      if (options.authMode === 'subprotocol' && options.tokenProvider) {
        const token = await options.tokenProvider();
        return [...base, token];
      }
      return base;
    };

    this.#socket = new ReconnectingSocket({
      url: urlProvider,
      protocols: protocolsProvider,
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
      onOpen:
        options.authMode === 'first-message' && options.tokenProvider
          ? async (send) => {
              const token = await options.tokenProvider!();
              const frame = options.authMessage?.(token) ?? { type: 'auth', token };
              send(serialize(frame));
            }
          : undefined,
      onMessage: (data) => this.#routeFrame(data),
      onClose: (info) => {
        if (info.userInitiated) {
          for (const handler of this.#disconnectedHandlers) handler();
        }
      },
      onError: (error) => {
        for (const handler of this.#errorHandlers) handler(error);
      },
      onStateChange: (state) => {
        for (const handler of this.#stateHandlers) handler(state);
        if (state === 'open') for (const handler of this.#connectedHandlers) handler();
      },
    });
  }

  get url(): string {
    return this.#options.url;
  }

  get state(): EventsConnectionState {
    return this.#socket.state;
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
    this.#subscriptions.set(id, { pattern, segments: pattern.split('/'), handler });
    return () => {
      this.#subscriptions.delete(id);
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

    for (const sub of [...this.#subscriptions.values()]) {
      const params = matchTopic(sub.pattern, topic ?? null);
      if (params === null) continue;
      const ctx: TopicContext = { topic: topic ?? null, params, raw: data };
      try {
        sub.handler(payload, ctx);
      } catch (err) {
        for (const handler of this.#errorHandlers) handler(err);
      }
    }
  }
}
