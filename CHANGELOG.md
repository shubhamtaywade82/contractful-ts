# Changelog

## 0.3.1 — End-to-end ticket demo, and two inference/lifecycle fixes it exposed

### End-to-end example: REST + WS shared ticket authentication

- **`examples/ticket-demo/`** — a complete, deterministic demo of one
  credential authority serving both transports: a `TokenManager` (single-flight
  refresh) feeding a transport-aware `AuthProvider` that stamps
  `Authorization: Bearer` for REST and mints a **one-time ticket** over an
  authenticated REST call for every WebSocket (re)connection. Fifteen steps,
  each asserted in `tests/ticket-demo.test.ts`:
  - token fetch → ticket mint → `?ticket=` connect, subscribe frames,
    REST reads/writes fanning events over the socket, parameterised
    `shipment/:shipmentId/status` channels, publish/pong round trip,
    closed-world rejection of a typo'd publish;
  - drop + automatic reconnect on a **fresh single-use** ticket with the
    subscription registry re-sent;
  - REST 401 → refresh + single retry **and** proactive rotation of the
    healthy socket onto the new credentials, sharing exactly one
    `/auth/token` call (single-flight);
  - WS close 4001 → the same shared recovery;
  - `getLastEventId()` powering a REST catch-up, a rogue client's replayed
    ticket refused with 4003, and one `dispose()` for both transports.
- The demo ships `MockCourierServer` — an in-process double implementing
  the library's `Transport` and `SocketFactory` interfaces as a strict
  ticket authority — plus `tsconfig.check.json`, so the whole example is
  strict-`tsc`-checked against the built package in CI.

### Fixed: required-parameter inference survived no context (type-level)

- Declared-required params were silently inferred as **optional keys**
  (and, worse, inverted in some contexts): `RequiredParamKeys` matched
  `P[K] extends { __required: true }`, but the phantom is declared
  `__required?: R` (type `R | undefined`), so the match never held. It now
  checks `NonNullable<P[K]['__required']> extends true`.
- The param factories (`P.string` etc.) used a single generic signature
  whose `R` was inferred from the **contextual return type** inside
  `contract(...)` / `defineApi(...)`, widening it to `boolean` (when
  `required: true` was passed) or `any` (when it was not) — flipping which
  keys `InferArgs` marked required. Every factory is now declared with
  overloads whose return types spell the phantom out concretely
  (`ParamSpec<string, true>` / `ParamSpec<string, false>`), which contextual
  typing cannot remap.
- Net effect: `api.show()` now fails to compile when a required param is
  missing (as documented), all-optional contracts stay callable with no
  arguments, and `defineEvents` topic params (`ctx.params`) are fully typed.
- Known limitation (pre-existing, now documented in the example): pinning a
  contract's return type with `contract<SomeType>(...)` makes TypeScript
  skip inference for the params generic — such contracts fall back to the
  open index-signature args type, with closed-world validation remaining
  the runtime guard.

### Fixed: double reconnect when the close policy itself rotates credentials

- When a provider cleared its token inside `handleUnauthorized` **and**
  wired `onAuthStateChanged` (e.g. `authProviderFromTokenManager`), a 4001
  close started two competing reconnections — the forced rotation from the
  state-change listener plus the policy-approved retry timer — leaving an
  orphaned open socket. `ReconnectingSocket` now skips the scheduled retry
  when a forced attempt already wired a socket, serialises concurrent
  attempt starts, and only sets the forced-reconnect flag when there is a
  live socket whose `onclose` can consume it.

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
