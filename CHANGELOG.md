# Changelog

## 0.4.2 — Real-server integration, browser compatibility, AsyncAPI edges, Binance testnet harness

### Fixed: connect timeouts no longer hang against never-upgrading servers

- The standard `WebSocket` constructor's `close()` cannot abort an
  in-flight handshake (per the WHATWG spec it only closes the connection
  once established) — so when the connect timeout fired against a server
  that accepts TCP but never completes the upgrade, `onclose` never
  arrived and reconnection stalled forever on Node 22+ (whose global
  constructor conforms strictly; the `ws` package aborts immediately,
  which is why Node 18/20 were unaffected). The connect-timeout path now
  force-recovers: after a grace period the socket is terminated when
  possible (`ws`), detached, and the failure/reconnect path runs regardless
  — stale events from the zombie socket are ignored. Found by the new
  real-server suite failing on the Node 22 CI leg.

### Fixed: header auth now works on Node 22+ through the default socket factory

- The default factory prefers the global `WebSocket` (browsers, Node 22+),
  but the standard constructor cannot set upgrade-request headers — so
  `authMode: 'header'` silently dropped them on Node 22+. When auth
  material asks for headers, the factory now routes through the lazily
  imported `ws` (Node only), making header auth work on every Node version
  where the optional peer is installed. Browsers still cannot set upgrade
  headers (by design) — the browser-safe auth modes remain the defaults.

### Fixed: AsyncAPI adapter gaps

- AsyncAPI 2.x `operationId` on `publish`/`subscribe` is now used as the
  generated method name, matching the 3.x operation-key behavior.
- Server URLs with `{variable}` templates are filled from each variable's
  `default` (2.x `servers.*.url` and 3.x `servers.*.host`); variables
  without a default stay visible in the URL instead of silently producing
  a broken one.

### Added: real-server integration tests (the last audit residuals)

- The events runtime and the graphql-transport-ws client are now exercised
  against a **real `ws` WebSocketServer** on loopback — genuine TCP, frames
  and close codes: publish/subscribe round-trips, abnormal-drop
  reconnection with subscription resending, heartbeat liveness timeouts
  (close 4000 → recovery), the 4001 token-expired → refresh → reconnect
  cycle, header/query/subprotocol auth on real upgrade requests, a TCP
  server that never completes the handshake (connect-timeout budget), and
  the full graphql handshake/stream/error/reconnect-resubscribe cycle with
  ping/pong keepalives. The default socket factory is used throughout, so
  the CI matrix covers both the global-`WebSocket` path (Node 22/24) and
  the lazy `ws`-import path (Node 18).
- **Browser compatibility is pinned**: the runtime is driven through a
  class exposing only the browser-standard `WebSocket` surface
  (two-argument construction, `on*` handlers, `send`, `close(code, reason)`)
  against the real server — any accidental reliance on `ws`-only APIs
  fails CI.
- **Binance testnet harness**: `scripts/binance-testnet-check.mjs` sends a
  real signed `GET /api/v3/account` to testnet.binance.vision (read-only),
  and `tests/binance-testnet.test.ts` runs the same check — plus a
  tampered-signature rejection test — when `BINANCE_TESTNET_KEY` /
  `BINANCE_TESTNET_SECRET` are set, skipping hermetically otherwise.
- AsyncAPI edge cases: 2.x `operationId`, server-URL variable substitution,
  `$ref`'d messages and channel parameters, bidirectional channels, and
  the documented untyped-payload limitation for non-object payloads.
- `ws` + `@types/ws` joined the dev dependencies (server side of the new
  tests); the runtime dependency surface is unchanged — `ws` stays an
  optional peer. +26 tests (408 → 434), including a deterministic
  zombie-socket regression for the connect-timeout fix.

## 0.4.1 — Resilience audit: cancellation in the pipeline, real-transport coverage, malformed-spec gates

### Fixed: aborted requests no longer hang in the rate-limit queue

- `RateLimiter.acquire()` now accepts an `AbortSignal` (passed by the request
  pipeline): a caller aborted while waiting for its pacing slot rejects
  immediately with `RequestAbortedError` and cancels its scheduled-but-unfired
  slot timer, instead of holding the request open until the slot would have
  arrived. The freed slot and queue space stay reusable.
- Abort coverage previously depended on the transport noticing the signal;
  now both waits owned by the library itself (rate-limit pacing and retry
  backoff) reject on abort.

### Fixed: malformed specs are rejected loudly, never silently emitted

- `buildApiIR()` throws `OpenApiError` for documents that declare neither an
  `openapi` nor a `swagger` version (e.g. another format's document fed to
  the OpenAPI path with a forced `--format`) instead of generating an empty
  client. A valid OpenAPI document without `paths` (legal only in 3.1)
  still generates, with a visible warning in `ir.notes`.
- `buildPostmanIR()` mirrors the gate: documents without the collection
  shape (`info.name` + `item`/`schema`/`_postman_id`) throw `PostmanError`.
- `generateFromSpecText()` now parses through `parseSpecText`, so broken
  JSON/YAML and scalar/array-rooted documents surface as `OpenApiError`
  like every other entry point, instead of leaking raw `SyntaxError` /
  `YamlParseError`.

### Hardened: Release workflow supports manual re-releases

- `workflow_dispatch` with a `tag` input re-runs verification, refreshes the
  draft GitHub Release and publishes to npm for an existing tag — no tag
  deletion/re-push (the recovery path for a missing `NPM_TOKEN` or a
  registry hiccup). `skip_publish` drafts without touching npm.
- A `resolve` job cross-checks the tag against `package.json`'s version and
  fails fast on mismatch; the publish step is idempotent (a version already
  on npm is skipped, not re-published).

### Tests: +53 (355 → 408) across four new dimensions

- **Real-transport boundary** (`tests/axios-transport.test.ts`, 17): a
  genuine local HTTP server through the default AxiosTransport — wire
  formats (query/headers/JSON + form bodies), status passthrough (5xx
  resolved), non-JSON and 204 bodies, header normalization, ECONNREFUSED /
  timeout / abort / pre-aborted error mapping, plus full-pipeline behavior
  (typed round-trip, GET retry after 5xx, POST not retried on 5xx, 429 +
  Retry-After honored, idempotency key stable across attempts, auth header,
  abort during backoff).
- **Lifecycle races & cancellation** (`tests/lifecycle.test.ts`, 12):
  abort-in-queue, pre-aborted signals, queue-full through the client,
  pacing applied to retry attempts, abort during backoff, aborted half-open
  circuit probes freeing their slot, and events-runtime races (close during
  backoff with no zombie timer, concurrent `open()` sharing one attempt,
  exhausted budgets resetting, failing factories, forced reconnect during
  backoff connecting exactly once).
- **Malformed-spec rejection** (`tests/malformed-specs.test.ts`, 13):
  broken JSON/YAML text, scalar/array roots, missing files, non-OpenAPI
  and non-Postman documents (direct and through `runCodegen` with a forced
  kind), no-`paths` warning, and valid specs still passing the gates.
- **Generator round-trip determinism**
  (`tests/generator-roundtrip.test.ts`, 8): byte-identical emission for
  repeated runs and after a `serialize → parse → IR` cycle (HTTP and
  events), models as serialization fixed points, lossless operation sets,
  stable source hashing.
- Two `RateLimiter` unit tests pin the new abort semantics directly.

## 0.4.0 — Correctness audit fixes: retry safety, OpenAPI wire fidelity, inference, packaging

### Fixed: unsafe retries of non-idempotent requests (release blocker)

- **Method-aware retry safety.** A timeout, dropped connection or 5xx is an
  *ambiguous* failure — the server may already have applied the side effect.
  Replaying a `POST`/`PATCH` after one could duplicate an order or a payment;
  the retry loop no longer does it. `GET`/`HEAD`/`OPTIONS`/`PUT`/`DELETE`
  (idempotent per RFC 9110) still retry within the configured budget.
- Opt-ins for non-idempotent contracts, in order of scope: per-contract
  `idempotent` (the idempotency-key mechanism), per-contract
  `retry: 'always'`, a per-call `_idempotencyKey`, or API-level
  `retry.retryUnsafeMethods`. Per-contract `retry: 'never'` disables retries
  entirely.
- **Idempotency keys are now stable across attempts** (generated once per
  dispatch) — that stability is what lets an idempotency-aware server
  de-duplicate the replay. An explicit `_idempotencyKey` now also stamps the
  header (previously it was silently ignored without `idempotent: true`).
- A `429` remains retryable for every method: it is a server-sanctioned
  "retry later" for a request the server rejected *before* processing.
  `retry: 'never'` opts out. The single 401→refresh→retry (auth) path stays
  method-agnostic — a 401 means the request was rejected unauthenticated.
- 13 regression tests (`tests/retry-safety.test.ts`): ambiguous network
  failures / timeouts / 5xx on POST and PATCH (single attempt), idempotent
  methods retried, key reuse across attempts, every opt-in, and 429 handling.

### Fixed: OpenAPI request-generation correctness (release blocker)

- **Path-level parameters are inherited** by every operation under a path
  item; operation-level entries override path-level ones with the same
  `(name, in)` instead of discarding them entirely.
- **Swagger 2.0 `formData` parameters map to form-encoded body parameters**
  (`in: 'body'` + `form: true` — new contract option serializing body params
  as `application/x-www-form-urlencoded`), never query parameters.
  `type: file` formData entries and `multipart/form-data` bodies produce
  explicit warnings; multipart encoding is out of scope (and documented).
  OpenAPI 3 `application/x-www-form-urlencoded` request bodies map to
  `form: true` as well.
- **`requestBody.required` survives flattening.** A required body whose
  properties are all optional now emits `bodyRequired: true`, guaranteeing a
  (possibly empty) body instead of silently sending none.
- **Scalar / array / free-form request bodies serialize as themselves.**
  A new `raw: true` body-param flag makes the parameter *be* the payload —
  `POST /echo` with a string body sends `"hello"`, not `{ "body": "hello" }`.
  Fixed in both the runtime emitter and the standalone emitter.
- **Recursive `$ref` cycles** are cut with a typed free-form object
  placeholder (`P.hash()` with a description) instead of an empty `{}` that
  silently fell through to a wrong `P.string()`.
- **`allOf` schemas merge** (properties and `required` union, numeric bounds
  intersect); **`oneOf` / `anyOf` / `nullable` / multipart / file uploads
  emit explicit warnings** — as `// NOTE:` comments on the affected contract
  and in the generated file header — instead of being silently dropped.
- 16 regression tests (`tests/openapi-fixes.test.ts`), including an
  executable round-trip asserting the generated clients' *wire format*
  (scalar, array, form and empty-object bodies) against a mock transport.
- The README now carries a **supported-schema matrix** spelling out
  translated / warned / rejected constructs, and an explicit **SSE boundary**:
  `AuthContext.transport`'s `'sse'` value is reserved but unimplemented.

### Fixed: pinning a return type no longer widens argument inference

- `returns<R>(decls)` pins a contract's return type through its `responds`
  list. Because no explicit type argument is supplied to `contract(...)`,
  TypeScript keeps inferring the argument object from `params` at full
  strictness — previously `contract<User[]>(...)` disabled inference for the
  remaining generics and argument types widened to an open index signature.
  The legacy `contract<T>()` form still works for simple contracts and is
  documented as relaxed there.
- New strict type-check gate: `npm run typecheck` runs strict `tsc` over
  `src/` **and** `tests/types/` (compile-time test contracts enforced with
  `expectTypeOf`); wired into CI and `prepublishOnly`.

### Fixed: the Binance example's signing demo

- The HMAC "self-check" computed `expected` and `actual` with the same
  operation and input — it could never fail. Replaced with **known-answer
  tests**: fixed vectors against externally precomputed HMAC-SHA256 digests,
  plus tamper-evidence checks, run first in the demo and pinned in
  `tests/binance-signing.test.ts`.
- `placeOrder` previously put its parameters in a JSON body while the signing
  hook signed the (empty) query string. Parameters now travel on the query
  string — what Binance signs — and the test asserts the signature verifies
  over exactly the transmitted query bytes with nothing leaking into a body.
- The example no longer claims a Binance-unsupported idempotency header:
  order placement is `retry: 'never'` (ambiguous failures surface to the
  caller; reconcile via `newClientOrderId`), demonstrating the new retry
  safety semantics.

### Fixed: the installed `contractful-gen` binary did nothing

- Found by the new tarball smoke test: npm links `node_modules/.bin/
  contractful-gen` as a **symlink**, so the CLI's main guard compared
  `process.argv[1]` (symlink path) against `import.meta.url` (resolved real
  path), never matched, and the installed binary exited 0 in silence. The
  guard now resolves the invocation path through the filesystem
  (`realpathSync`); pinned by `tests/cli-bin.test.ts`.
- **Tarball smoke test** (`scripts/tarball-smoke-test.sh`, run before every
  release — see `RELEASING.md`): packs the tarball, installs it into a fresh
  consumer project, exercises every public export (root and `/codegen`
  subpaths), strict-compiles a consumer file against the shipped
  declarations (including `returns<T>()` inference), executes the installed
  CLI, and strict-compiles its generated output.

### Release readiness

- Version 0.4.0; `prepublishOnly` = build + typecheck + full test suite.
- **Release workflow** (`.github/workflows/release.yml`): tags `v*` build,
  test and attach the packed tarball to a GitHub Release; npm publication
  runs automatically once an `NPM_TOKEN` secret is configured (the package
  is **not yet on the registry** — see `RELEASING.md` for the one-time
  `npm publish` steps).
- Documented release procedure in `RELEASING.md`.
- CI now runs `npm run typecheck` between build and tests on the
  Node 18/20/22/24 matrix.

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
