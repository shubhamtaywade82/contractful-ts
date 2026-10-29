/**
 * GraphQL-ws client — the `graphql-transport-ws` subprotocol (used by
 * graphql-ws / Apollo subscriptions / Yoga / Hasura) on top of the shared
 * reconnecting socket. Handles `connection_init` / `connection_ack`,
 * ping-pong keepalives, id-correlated `subscribe` / `next` / `error` /
 * `complete` frames, and resubscribes active operations after a reconnect.
 */

import { EventsConnectionError, EventsError } from '../errors.js';
import { ReconnectingSocket } from './socket.js';
import type { EventsConnectionState, SocketFactory } from './types.js';

export interface GraphQLOperation {
  /** The GraphQL document, e.g. `subscription { orderCreated { id } }`. */
  query: string;
  /** Variables for the operation. */
  variables?: Record<string, unknown>;
  /** Operation name when the document defines several. */
  operationName?: string;
}

export interface GraphQLSubscriptionHandlers<T> {
  /** Called with every `next` payload (`{ data?, errors? }`). */
  next: (payload: T) => void;
  /** Called when the server reports operation-level errors. */
  error?: (errors: unknown) => void;
  /** Called when the server completes the operation. */
  complete?: () => void;
}

export interface GraphQLSubscription {
  /** Stops the operation server-side and drops the handlers. */
  unsubscribe(): void;
}

export interface GraphQLWsClient {
  readonly state: EventsConnectionState;
  connect(): Promise<void>;
  disconnect(code?: number, reason?: string): Promise<void>;
  subscribe<T = unknown>(
    operation: GraphQLOperation,
    handlers: GraphQLSubscriptionHandlers<T>,
  ): GraphQLSubscription;
}

export interface GraphQLWsOptions {
  url: string;
  socketFactory?: SocketFactory;
  /** Payload merged into `connection_init` (auth tokens live here). */
  connectionInitPayload?: unknown | (() => unknown | Promise<unknown>);
  reconnect?: boolean;
  reconnectMaxAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connectTimeoutMs?: number;
}

interface ActiveSub {
  operation: GraphQLOperation;
  handlers: GraphQLSubscriptionHandlers<unknown>;
}

const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

/** Creates a GraphQL subscriptions client speaking `graphql-transport-ws`. */
export function createGraphQLWsClient(options: GraphQLWsOptions): GraphQLWsClient {
  const active = new Map<string, ActiveSub>();
  let nextId = 1;
  let ackWaiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];
  let acked = false;

  const socket = new ReconnectingSocket({
    url: options.url,
    protocols: [GRAPHQL_TRANSPORT_WS],
    socketFactory: options.socketFactory,
    reconnect: options.reconnect,
    reconnectMaxAttempts: options.reconnectMaxAttempts,
    reconnectBaseDelayMs: options.reconnectBaseDelayMs,
    reconnectMaxDelayMs: options.reconnectMaxDelayMs,
    connectTimeoutMs: options.connectTimeoutMs,
    onOpen: (send) => {
      acked = false;
      const payload =
        typeof options.connectionInitPayload === 'function'
          ? (options.connectionInitPayload as () => unknown | Promise<unknown>)()
          : options.connectionInitPayload;
      return Promise.resolve(payload).then((resolved) => {
        send(
          JSON.stringify(
            resolved === undefined
              ? { type: 'connection_init' }
              : { type: 'connection_init', payload: resolved },
          ),
        );
      });
    },
    onMessage: (data) => {
      if (typeof data !== 'string' || data.length === 0) return;
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data);
        if (typeof parsed !== 'object' || parsed === null) return;
        frame = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      handleFrame(frame, (payload: unknown) => {
        socket.send(JSON.stringify(payload));
      });
    },
  });

  function handleFrame(frame: Record<string, unknown>, send: (payload: unknown) => void): void {
    const type = frame.type;
    if (type === 'connection_ack') {
      acked = true;
      for (const waiter of ackWaiters.splice(0)) waiter.resolve();
      // Re-establish subscriptions that survived a reconnect.
      for (const [id, sub] of [...active.entries()]) {
        send({ id, type: 'subscribe', payload: sub.operation });
      }
      return;
    }
    if (type === 'ping') {
      send({ type: 'pong' });
      return;
    }
    if (type === 'pong' || type === 'ka') return;

    if (type === 'next' || type === 'error' || type === 'complete') {
      const id = typeof frame.id === 'string' ? frame.id : null;
      if (id === null) return;
      const sub = active.get(id);
      if (!sub) return;
      if (type === 'next') {
        sub.handlers.next(frame.payload as unknown);
      } else if (type === 'error') {
        active.delete(id);
        sub.handlers.error?.(frame.payload);
      } else {
        active.delete(id);
        sub.handlers.complete?.();
      }
    }
  }

  function waitForAck(): Promise<void> {
    if (acked) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      ackWaiters.push({ resolve, reject });
      setTimeout(() => {
        const index = ackWaiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) {
          ackWaiters.splice(index, 1);
          reject(new EventsError('Timed out waiting for connection_ack'));
        }
      }, 10_000);
    });
  }

  return {
    get state(): EventsConnectionState {
      return socket.state;
    },
    async connect(): Promise<void> {
      await socket.open();
      await waitForAck();
    },
    disconnect(code = 1000, reason = 'client closed'): Promise<void> {
      const ids = [...active.keys()];
      active.clear();
      if (ids.length > 0 && socket.state === 'open') {
        for (const id of ids) {
          try {
            socket.send(JSON.stringify({ id, type: 'complete' }));
          } catch {
            break;
          }
        }
      }
      return socket.close(code, reason);
    },
    subscribe<T = unknown>(
      operation: GraphQLOperation,
      handlers: GraphQLSubscriptionHandlers<T>,
    ): GraphQLSubscription {
      const id = String(nextId++);
      active.set(id, {
        operation,
        handlers: handlers as GraphQLSubscriptionHandlers<unknown>,
      });
      void (async () => {
        try {
          if (socket.state !== 'open') await this.connect();
          socket.send(JSON.stringify({ id, type: 'subscribe', payload: operation }));
        } catch (err) {
          active.delete(id);
          handlers.error?.(err);
        }
      })();
      return {
        unsubscribe: () => {
          if (!active.delete(id)) return;
          if (socket.state === 'open') {
            try {
              socket.send(JSON.stringify({ id, type: 'complete' }));
            } catch {
              /* already closed */
            }
          }
        },
      };
    },
  };
}

export { EventsConnectionError };
