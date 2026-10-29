/**
 * contractful-ts — contract-first HTTP client for TypeScript.
 *
 * Declare the HTTP shape of an API (verb, path, typed parameters, expected
 * responses); the library derives typed client methods with closed request
 * schemas, open response schemas, auth, retries, circuit breaking and
 * rate-limit pacing.
 */

/* Errors ------------------------------------------------------------------ */
export {
  ContractfulError,
  ContractViolationError,
  ContractDefinitionError,
  PathBuildError,
  AuthError,
  AuthenticationError,
  AuthorizationError,
  RequestAbortedError,
  TransportError,
  TimeoutError,
  HttpStatusError,
  RateLimitError,
  ResponseShapeError,
  CircuitOpenError,
  QueueFullError,
  EventsError,
  EventsConnectionError,
  WebSocketApiError,
  MessageShapeError,
  GraphQLError,
  WS_CLOSE_CODES,
  shouldReconnectOnClose,
  errorKind,
  asContractfulError,
  type Violation,
  type ContractfulErrorOptions,
  type HttpStatusErrorOptions,
  type ResponseShapeErrorOptions,
  type MessageShapeErrorOptions,
  type WebSocketApiErrorOptions,
  type ApiClientErrorKind,
} from './errors.js';

/* Param DSL --------------------------------------------------------------- */
export {
  params,
  P,
  string as paramString,
  integer as paramInteger,
  float as paramFloat,
  boolean as paramBoolean,
  array as paramArray,
  hash as paramHash,
  custom as paramCustom,
  type ParamSpec,
  type AnyParamSpec,
  type ParamsShape,
  type ParamKind,
  type ParamLocation,
  type InferArgs,
} from './dsl/params.js';

/* Contract + API DSL ------------------------------------------------------- */
export {
  contract,
  type ContractOptions,
  type ContractDefinition,
  type ContractArgs,
  type ContractReturn,
} from './dsl/contract.js';
export {
  defineApi,
  type ApiOptions,
  type ApiContracts,
  type ClientOptions,
  type ContractMethod,
  type ApiClientBase,
  type ApiClientInstance,
  type ApiClientConstructor,
} from './dsl/api.js';

/* Shared types ------------------------------------------------------------- */
export type {
  HttpMethod,
  MetaOptions,
  RequestContext,
  ResponseContext,
  RequestHook,
  ResponseHook,
  ResponseType,
  ResponseDecl,
  RetryOptions,
  CircuitOptions,
  CircuitState,
  RateLimitOptions,
} from './types.js';

/* Auth --------------------------------------------------------------------- */
export {
  auth,
  createClientCredentialsProvider,
  type AuthResolver,
  type AuthSurface,
  type AuthRequestInfo,
  type TokenProvider,
  type ClientCredentialsProvider,
  type ClientCredentialsProviderOptions,
} from './middleware/auth.js';
export type { AuthTransport, AuthContext, AuthMaterial, AuthProvider } from './auth/provider.js';
export {
  staticAuthProvider,
  bearerAuthProvider,
  apiKeyAuthProvider,
  authProviderFromTokenManager,
  wsTicketAuthProvider,
  appendAuthQuery,
  authProviderResolver,
} from './auth/provider.js';
export { createTokenManager, type Token, type TokenManager, type TokenManagerOptions } from './auth/token-manager.js';

/* HTTP surface ------------------------------------------------------------- */
export { Contractful, type QuickOptions } from './http/quick.js';
export type { Transport, TransportRequest, TransportResponse } from './http/transport.js';
export { AxiosTransport } from './http/axios-transport.js';
export { joinUrl, buildUrl } from './http/transport.js';

/* Pagination --------------------------------------------------------------- */
export { paginate, pages, cursor, collect, type PageOptions, type CursorOptions, type CursorPage } from './pagination.js';

/* Events (WebSocket) -------------------------------------------------------- */
export {
  EventsClient,
  matchTopic,
  defineEvents,
  subscribe,
  publish,
  createGraphQLWsClient,
  ReconnectingSocket,
  defaultSocketFactory,
  resolveWebSocketCtor,
  backoffDelayMs,
  type EventsClientOptions,
  type ChannelOptions,
  type ChannelDefinition,
  type ChannelMethod,
  type ChannelMessage,
  type ChannelParams,
  type EventsChannels,
  type EventsOptions,
  type EventsClientInstance,
  type EventsClientConstructor,
  type EventsClientBase,
  type EventsChannelClientOptions,
  type EventsConnectionState,
  type EventEnvelope,
  type MessageHandler,
  type SocketFactory,
  type SocketLike,
  type TopicContext,
  type SubscribeContext,
  type WebSocketAuthMode,
  type GraphQLWsClient,
  type GraphQLWsOptions,
  type GraphQLOperation,
  type GraphQLSubscription,
  type GraphQLSubscriptionHandlers,
} from './events/index.js';

/* Validation (advanced use) ------------------------------------------------ */
export {
  validateParams,
  splitArgs,
  type ValidationResult,
} from './validation/validate.js';
export { validateResponse, parseRetryAfter, type IncomingResponse, type ResponseOutcome } from './validation/response.js';

/* Resilience primitives ----------------------------------------------------- */
export { CircuitBreakerRegistry } from './middleware/circuit.js';
export { RateLimiter, RateLimiterRegistry } from './middleware/rate-limit.js';
export {
  isRetryableError,
  backoffDelay,
  retryDelayFor,
  DEFAULT_RETRY_OPTIONS,
} from './middleware/retry.js';

/* Platform facade ------------------------------------------------------------ */
export {
  createPlatformClient,
  createEventsCacheInvalidator,
  type PlatformClientOptions,
  type PlatformClient,
  type ClientIdentity,
  type EventInvalidationRule,
} from './platform/index.js';
