# Changelog

## 0.3.0 — Authentication, token management and the unified platform facade

The release implements the full platform-client design: injectable,
transport-aware authentication, deterministic token refresh, a unified
REST + events facade, and the codegen surface that ties them together.

### Authentication and token management

- **`AuthProvider` contract** (`src/auth/provider.ts`) — `getAuth(context)`
  / `handleUnauthorized(context)` / `onAuthStateChanged(listener)` over an
  `AuthMaterial` of headers, query, cookie, subprotocols or connect message.
  The context is transport-aware (`http` / `websocket` / `sse` / `graphql`)
  and carries method, path, channel, operationId, scopes and attempt.
- **`createTokenManager`** — single-flight refresh (one token-endpoint call
  per burst), proactive refresh window, scope-aware cache and change
  listeners. Memory-only by design: storage stays an application decision.
- **Deterministic 401/403 semantics** — a 401 runs `handleUnauthorized` at
  most once and retries only on an affirmative; the terminal failure is
  `AuthenticationError`. A 403 never auto-refreshes and surfaces as
  `AuthorizationError`.
- **Shared error taxonomy** — `errorKind(err)` maps every library error onto
  `authentication | authorization | validation | network | timeout | server
  | websocket | unknown`.
- **`auth.csrf()`** — anti-CSRF header for cookie sessions, stamped only on
  state-changing methods.
- **WebSocket auth modes** — `query`, `subprotocol`, `connect-message`
  (alias `first-message`), `ticket` (one-time ticket) and `header`
  (Node `ws` / custom factories), plus full `authProvider` integration.
- **Close-code policy** — `WS_CLOSE_CODES` (4000 heartbeat, 4001 token
  expired, 4002 connect timeout, 4003 unauthorized, 4004 forbidden);
  `shouldReconnectOnClose` decides, `4001` refreshes through
  `handleUnauthorized`, auth failures surface as `WebSocketApiError`.
- **`onAuthStateChanged`** — proactive reconnect with fresh credentials
  after out-of-band token refresh.

### Events runtime

- Server-side subscription protocol support (`subscribeEnvelope` /
  `unsubscribeEnvelope`) with a refcounted registry re-sent after every
  reconnect.
- Event-id tracking (`eventIdExtractor`, `getLastEventId()`,
  `ctx.eventId`) for REST catch-up after disconnects.
- `ReconnectingSocket.reconnect()` / `resetAttempts()` and an async
  `shouldReconnect` veto hook; terminal failures surface through `onError`.
- `EventEnvelope<Type, Payload>` helper type for discriminated event unions.

### Platform facade

- **`createPlatformClient`** — one typed handle over separate HTTP and
  events transports: shared auth provider, identity headers
  (`X-Client-Name` / `X-Client-Version`), `autoConnectEvents`, `dispose()`.
- **`createEventsCacheInvalidator`** — event-driven cache invalidation
  rules without baking a cache into the transports.

### Code generation

- **Typed auth surface** — `securitySchemes` are parsed into the IR and
  emitted as `auth.ts` (`SecuritySchemeName`, `AuthOptions`,
  `SecurityScope`); operation `security` requirements become contract
  `security: [...]` metadata that reaches `AuthContext.scopes` at runtime.
- **`platform.ts`** — multi-source configs with both transports emit a
  unified `createPlatformClient` facade wiring every group with shared auth
  (`--no-platform` to opt out).
- **`CLIENT_METADATA`** — generator version + `sha256` source hashes in
  every generated index, deterministic across runs.
- **Domain extensions** — `x-client-domain` (OpenAPI operations, AsyncAPI
  channels) and `x-client-event-name` (AsyncAPI channels) group generated
  clients by domain.
- **Event naming rules** — `naming.eventNameStyle` (`dot.case` /
  `kebab-case` / `keep`), `handlerPrefix`, `stripVersion`; per-namespace
  `EVENT_NAMES` alias map for string-based subscriptions.
- **Multi-message channels emit typed unions** — AsyncAPI `oneOf` messages
  on one channel collapse into a single method carrying a generated
  interface union instead of per-message shape gates that reject each
  other's messages.
- New CLI flags: `--event-name-style`, `--handler-prefix`,
  `--strip-version`, `--client-name`, `--no-platform`.

### Breaking changes

- `AuthContext` (the mutable `{ headers, query }` resolver surface) is
  renamed `AuthSurface`; `AuthContext` now names the provider context per
  the platform design.
- HTTP 401/403 now throw `AuthenticationError` / `AuthorizationError`
  (both extend `HttpStatusError`).
- The client-side connect-timeout close code moved from 4001 to 4002 so
  4001 can mean exclusively "token expired".
- AsyncAPI `oneOf` channels generate one typed-union method (see above).

## 0.2.0 — Multi-format code generation

- Canonical `contractful-api-model` with round-trip serialization.
- AsyncAPI 2.x / 3.x adapter (perspective handling, `{param}` topics).
- Postman Collection adapter with example-based type inference.
- GraphQL SDL parser and emitter (queries, mutations, graphql-transport-ws
  subscriptions).
- Multi-source `codegen.json` configs with namespaces.
- `defineEvents` DSL, `EventsClient` / `ReconnectingSocket` runtime.
- Standalone emit mode (zero runtime imports).

## 0.1.0 — Initial release

- Contract DSL (`contract`, `defineApi`, `P`), closed request validation,
  open response validation.
- Axios transport, retries with backoff, circuit breakers, GCRA rate
  limiting, OAuth2 client-credentials provider.
- OpenAPI 3.x / Swagger 2.0 → contract codegen with a hand-written
  zero-dependency YAML parser.
