/**
 * contractful-ts/events — WebSocket & event-driven client runtime.
 *
 * - {@link EventsClient}: topic-routed, reconnecting, heartbeated events
 *   connection with three browser-safe auth modes.
 * - `defineEvents` / `subscribe` / `publish`: the typed channel DSL.
 * - `createGraphQLWsClient`: GraphQL subscriptions over graphql-transport-ws.
 * - `ReconnectingSocket` / socket factories: the primitives underneath.
 */

export {
  EventsClient,
  matchTopic,
  type EventsClientOptions,
} from './client.js';

export {
  defineEvents,
  subscribe,
  publish,
  type ChannelOptions,
  type ChannelDefinition,
  type ChannelMessage,
  type ChannelParams,
  type ChannelMethod,
  type EventsChannels,
  type EventsOptions,
  type EventsClientBase,
  type EventsClientInstance,
  type EventsClientConstructor,
  type EventsChannelClientOptions,
  type SubscribeContext,
  type TopicContext,
} from './dsl.js';

export {
  createGraphQLWsClient,
  type GraphQLWsClient,
  type GraphQLWsOptions,
  type GraphQLOperation,
  type GraphQLSubscription,
  type GraphQLSubscriptionHandlers,
} from './graphql-ws.js';

export {
  ReconnectingSocket,
  defaultSocketFactory,
  resolveWebSocketCtor,
  backoffDelayMs,
  type ReconnectingSocketOptions,
} from './socket.js';

export type {
  EventsConnectionState,
  EventEnvelope,
  MessageHandler,
  SocketFactory,
  SocketLike,
  TopicContext as TopicContextType,
  WebSocketAuthMode,
} from './types.js';
