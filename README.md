# contractful-ts

[![CI](https://github.com/shubhamtaywade82/contractful-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/shubhamtaywade82/contractful-ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](./package.json)

**Contract-first HTTP and WebSocket client for TypeScript.** Declare the shape of an API — verbs and paths, event channels, typed parameters, expected responses — and get fully typed client methods with validation, auth, retries, circuit breakers and rate limiting. Ships with `contractful-gen`, a universal generator that turns OpenAPI, AsyncAPI, Postman Collections and GraphQL SDL into typed clients, in the spirit of [binance-connector-js](https://github.com/binance/binance-connector-js).

This is the TypeScript sibling of the Ruby gem [contractful](https://github.com/shubhamtaywade82/contractful):

| contractful (Ruby)                                | contractful-ts                                    |
| ------------------------------------------------- | ------------------------------------------------- |
| `class GitHubAPI; include Contractful::Contract`  | `defineApi({ ... })`                              |
| `base 'https://api.github.com'`                   | `base: 'https://api.github.com'`                  |
| `contract :list_users, 'GET /users'`              | `listUsers: contract('GET /users', { ... })`      |
| `param :per_page, Integer, inclusion: (1..100)`   | `perPage: P.integer({ as: 'per_page', max: 100 })`|
| `responds 200, type: :array`                      | `responds: [{ status: 200, type: 'array' }]`      |
| `auth bearer: -> { token }`                       | `auth: auth.bearer(() => token)`                  |
| `_headers`, `_timeout` per-call meta              | `_headers`, `_timeout` per-call meta              |

The core idea survives the port unchanged: **closed request schemas** reject bad input before any network traffic, while **open response schemas** treat unknown response fields as data, never as errors.

## Install

```bash
npm install contractful-ts   # Node 18+; axios ships as a dependency, `ws` is an optional peer for Node < 22
```

## Quick start

```ts
import { contract, defineApi, P } from 'contractful-ts';

export const GitHubApi = defineApi({
  name: 'GitHubApi',
  base: 'https://api.github.com',
  defaultHeaders: { Accept: 'application/vnd.github+json' },
  retry: { retries: 2, baseDelay: 250 },
  contracts: {
    listUsers: contract('GET /users', {
      params: {
        since: P.integer({ describe: 'Only return users with an ID greater than this.' }),
        perPage: P.integer({ as: 'per_page', min: 1, max: 100, default: 30 }),
      },
      responds: [{ status: 200, type: 'array' }],
    }),

    createIssue: contract('POST /repos/:owner/:repo/issues', {
      idempotent: true,
      params: {
        owner: P.string({ required: true }),
        repo: P.string({ required: true }),
        title: P.string({ required: true, length: { min: 1, max: 256 } }),
        labels: P.array({ of: P.string(), default: [] }),
      },
      responds: [{ status: 201, type: 'hash' }, { status: 422 }],
    }),
  },
});

const github = new GitHubApi();

// Fully typed: perPage is number | undefined, result is GitHubUser[].
const users = await github.listUsers({ perPage: 50 });
```

That's the whole client. There is no imperative request code to write or maintain — the contract *is* the implementation.

### What you get for free

- **Typed methods** — argument objects and return types are inferred from the declarations (`returns<User[]>(...)` pins the result type without loosening argument inference).
- **Closed request schemas** — undeclared parameters (typos!), constraint violations (`per_page: 999` against `max: 100`) and malformed routes are rejected **before any HTTP traffic** with a `ContractViolationError` listing every problem.
- **Parameter placement** — path params are substituted and URI-escaped, query params serialize (including repeated keys for arrays), POST/PUT/PATCH params become a JSON body, `in: 'header'` params become headers. `as: 'wire_name'` handles snake_case APIs.
- **Response contracts** — declared statuses are checked (undeclared statuses throw `HttpStatusError` with the parsed body attached), optional top-level `type` checks catch shape drift, and unknown response fields pass through untouched.
- **Auth, retries, circuit breaking, rate-limit pacing, pagination** — see below.

## The request lifecycle

Every generated method runs the same pipeline:

```
validate args ─▶ build path ─▶ place params ─▶ beforeRequest hook ─▶ auth
      ─▶ rate-limit acquire ─▶ circuit check ─▶ dispatch (axios)
      ─▶ classify ─▶ retry w/ backoff ─▶ validate response ─▶ afterResponse hook ─▶ body
```

Hooks see a mutable context (`headers`, `query`, `body`), which is how request signing and telemetry are done.

## Parameters

```ts
params: {
  // kinds
  a: P.string(),
  b: P.integer(),          // "42" is coerced to 42
  c: P.float(),            // "0.5" is coerced to 0.5
  d: P.boolean(),          // "true"/"false" are coerced
  e: P.array({ of: P.string(), min: 1 }),
  f: P.hash(),              // contractful's Hash
  g: P.custom<Date>((v) => v instanceof Date || 'expected a Date'),

  // constraints
  h: P.string({ required: true, length: { min: 2, max: 64 }, pattern: /^[a-z]+$/ }),
  i: P.integer({ inclusion: [10, 30, 50], min: 1, max: 100, default: 30 }),

  // placement + wire names
  j: P.string({ as: 'user_name', in: 'query' | 'body' | 'header' | 'path' }),
}
```

- `required: true` and `default: …` are mutually exclusive (enforced at definition time).
- `null`/`undefined` mean "not provided" (Ruby nil semantics).
- Undeclared keys — including unknown `_meta` keys — are violations. Known meta keys: `_headers`, `_query`, `_timeout`, `_retries`, `_retryDelay`, `_idempotencyKey`, `_skipAuth`, `_signal`, `_baseUrl`.

**Raw and form-encoded bodies.** By default, body params become keys of a JSON object. Two contract options cover the rest:

```ts
// `raw: true` — the param IS the payload (scalar / array / free-form bodies):
echo: contract('POST /echo', {
  params: { body: P.string({ required: true, in: 'body', raw: true }) },
}),            // sends "hello" — not { "body": "hello" }

// `form: true` — body params serialize as application/x-www-form-urlencoded
// (Swagger 2.0 formData, HTML form APIs). Multipart uploads are not supported.
login: contract('POST /session', { form: true, params: { email: P.string({ required: true }) } }),

// `bodyRequired: true` — send a (possibly empty) body even when every
// body param is optional; generated for specs with `requestBody.required`.
```

Both are emitted automatically by `contractful-gen` when the source spec calls for them.

## Responses (open world)

```ts
responds: [
  { status: 200, type: 'array' },  // top-level shape is checked
  { status: 201 },                 // status-only check
  { status: 404 },                 // declared error → throws HttpStatusError (declared: true, body attached)
  { status: '5xx' },               // class patterns
  { status: 418, ok: true },       // force success for envelope-style APIs
]
```

Unknown response *fields* are never rejected — they are data. Omit `responds` entirely and any 2xx passes.

**Pinning the return type.** `contract<User[]>(...)` still works, but an explicit leading type argument makes TypeScript skip inference for the remaining generics, so argument types widen. Pin through `responds` instead and both stay strict:

```ts
import { returns } from 'contractful-ts';

listUsers: contract('GET /users', {
  params: { perPage: P.integer({ required: true }) },   // stays strictly inferred
  responds: returns<User[]>([{ status: 200, type: 'array' }]),   // pins the result type
}),
```

## Authentication

```ts
import { auth, createClientCredentialsProvider } from 'contractful-ts';

auth: auth.bearer(() => getToken())
auth: auth.basic(() => [user, pass])
auth: auth.apiKey({ name: 'X-Api-Key', value: () => process.env.API_KEY! })
auth: auth.apiKey({ name: 'apikey', value: () => key, in: 'query' })

// OAuth-style: the provider owns caching; a 401 triggers invalidate() + one retry
auth: auth.tokenProvider(createClientCredentialsProvider({
  tokenUrl: 'https://auth.example.test/oauth/token',
  clientId: '...',
  clientSecret: '...',
}))
```

Per-call escape hatch: `github.listUsers({ _skipAuth: true })`.

### The injectable `AuthProvider`

For platform-style clients that mix HTTP and WebSocket transports, auth is delegated to a single transport-aware provider. Nothing is ever embedded in generated code — the spec describes *what* is required, the provider decides *how*:

```ts
import {
  createTokenManager, authProviderFromTokenManager, authProviderResolver,
  type AuthProvider,
} from 'contractful-ts';

// Single-flight refresh: a burst of requests after expiry = one token call.
const tokens = createTokenManager({
  async fetchToken(scopes) {
    const res = await fetch('https://auth.example.test/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CLIENT_ID!,
        scope: scopes.join(' '),
      }),
    });
    const body = await res.json();
    return { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  },
});

// Bearer for HTTP, browser-safe query token for WebSocket, refresh on 401/4001.
const authProvider: AuthProvider = authProviderFromTokenManager(tokens);

// HTTP side — a resolver the defineApi pipeline understands:
const api = new ShopApi({ auth: authProviderResolver(authProvider) });
// (generated platform.ts clients wire this for you)

// WebSocket side — pass the provider itself:
const events = new ShopEvents({ authProvider });
```

The contract:

```ts
interface AuthProvider {
  getAuth(context: AuthContext): Promise<AuthMaterial>;
  handleUnauthorized?(context: AuthContext): Promise<boolean>;
  onAuthStateChanged?(listener: () => void): () => void;
}
```

- `AuthContext` carries `transport` (`http` / `websocket` / `sse` / `graphql`), `url`, `method`, `path`, `channel`, `operationId`, `scopes` and `attempt` — so the same provider can stamp an `Authorization` header for REST and a one-time ticket for the socket.
- `AuthMaterial` is whatever the server accepts: `headers`, `query`, `cookie`, `protocols` (WebSocket subprotocols) or `connectMessage` (an auth frame sent right after connect).
- `wsTicketAuthProvider(fetchTicket)` implements the recommended browser pattern: fetch a short-lived one-time ticket over REST, connect with `?ticket=...`.

> A complete, tested walkthrough of this pattern — one credential authority feeding both transports, single-flight refresh shared by a REST retry and a socket rotation, 4001/401 recovery, single-use ticket enforcement — lives in [`examples/ticket-demo/`](examples/ticket-demo/).

**Deterministic refresh semantics.** A `401` triggers `handleUnauthorized` at most *once* per request; the request is retried only when the hook resolves `true`, and the final failure is an `AuthenticationError` (kind: `authentication`). A `403` is *never* auto-refreshed — it surfaces as `AuthorizationError` (kind: `authorization`) because fresh tokens of the same principal cannot fix a permission. `errorKind(err)` maps every library error onto that shared taxonomy (`authentication | authorization | validation | network | timeout | server | websocket | unknown`).

**Cookie sessions + CSRF.** Use `credentials: 'include'` on the underlying axios instance and stamp the anti-CSRF header on state-changing requests:

```ts
auth: auth.csrf({
  headerName: 'X-CSRF-Token',
  tokenProvider: async () => getCsrfToken(),
})
```

**Token storage** stays your choice — the token manager is deliberately memory-only:

| Environment | Recommendation |
|---|---|
| Browser SPA | In-memory token + secure backend session |
| Browser SPA with refresh tokens | Backend-for-frontend or httpOnly cookie |
| Browser SPA using OAuth | Authorization Code + PKCE |
| Node service | Environment variables / secret manager |
| Mobile / desktop | OS secure storage (Keychain, Keystore, ...) |

## Retries, circuit breaker, rate limiting

```ts
defineApi({
  retry:   { retries: 3, baseDelay: 200, maxDelay: 5_000, jitter: 'full' },
  circuit: { failureThreshold: 5, cooldownMs: 10_000, halfOpenProbes: 1 },
  rateLimit: { requestsPerSecond: 8, burst: 4 },
  ...
})
```

### Retry safety (method-aware by default)

A timeout, a dropped connection or a 5xx is an **ambiguous failure**: the server may or may not have applied the side effect. Replaying a non-idempotent request after one can duplicate an order, a payment or a write — so retry eligibility is explicit:

| Retry after ambiguous failure? | |
| --- | --- |
| `GET` `HEAD` `OPTIONS` `PUT` `DELETE` | ✅ retried — idempotent by definition (RFC 9110) |
| `POST` / `PATCH` | ❌ surfaced to the caller after a single attempt, unless… |
| …the contract declares `idempotent` | ✅ retried, with the **same** `Idempotency-Key` on every attempt |
| …the call passes `_idempotencyKey` | ✅ retried, stamped as the key |
| …the contract sets `retry: 'always'` | ✅ explicit per-contract opt-in |
| …the API sets `retry.retryUnsafeMethods: true` | ✅ API-wide opt-in |
| `HTTP 429` (server-sanctioned) | ✅ retried for every method — the request was rejected before processing; `retry: 'never'` opts out |
| any contract with `retry: 'never'` | ❌ no retries at all |

The idempotency key is generated once per dispatch and kept stable across attempts — that stability is precisely what lets an idempotency-aware server de-duplicate the replay. The single 401→refresh→retry (auth) path is method-agnostic by design: a 401 means the request was rejected unauthenticated, not processed.

- Retries cover network errors, timeouts, 408/425/429/5xx — never 4xx validation errors. Backoff is exponential with jitter, and `Retry-After` (seconds or HTTP-date) is honored, capped at `retryAfterCapMs`.
- The circuit breaker is per-host: consecutive transport failures open it (fail fast with `CircuitOpenError`), a half-open probe after the cooldown decides recovery. Answered 4xx never trip it.
- The rate limiter paces dispatches GCRA-style with a burst allowance — protect your API budget before the server does. `maxQueue` bounds how many callers may wait.

## Pagination

```ts
import { paginate } from 'contractful-ts';

// page numbers
for await (const page of paginate.pages((page) => api.listThings({ page }))) { ... }

// cursors — yields individual items
for await (const item of paginate.cursor(
  (cursor) => api.listThings({ starting_after: cursor }),
)) { ... }

const all = await paginate.collect(paginate.cursor(...));
```

Both generators carry a `maxPages` safety cap (default 1000).

## Error handling

| Error                    | Meaning                                | Retried? |
| ------------------------ | -------------------------------------- | -------- |
| `ContractViolationError` | args violated the closed request schema | ✗        |
| `ContractDefinitionError`| the contract itself is invalid (thrown at definition time) | ✗ |
| `PathBuildError`         | a path parameter was missing           | ✗        |
| `AuthError`              | auth could not be resolved             | ✗        |
| `TransportError`         | network-level failure                  | ✓        |
| `TimeoutError`           | request exceeded its timeout           | ✓        |
| `RequestAbortedError`    | aborted through `_signal`              | ✗        |
| `HttpStatusError`        | unexpected/declared-error status — carries `.status`, `.body`, `.declared` | 5xx/408/429 only |
| `RateLimitError`         | HTTP 429, carries `.retryAfterMs`      | ✓        |
| `ResponseShapeError`     | top-level response type mismatch       | ✗        |
| `CircuitOpenError`       | fail-fast while the breaker is open    | ✗        |
| `QueueFullError`         | rate-limiter queue exceeded `maxQueue` | ✗        |

```ts
try {
  await github.createIssue({ owner: 'octocat', repo: 'hello-world', title: 'Hi' });
} catch (err) {
  if (err instanceof HttpStatusError && err.status === 422) {
    console.log(err.body); // parsed API error payload
  }
}
```

## Introspection

```ts
GitHubApi.contracts.listUsers.route.template;   // '/users'
GitHubApi.describe();                           // rendered contract table
github.describe('createIssue');                 // single-contract detail
github.listUsers.contract;                      // the definition behind the method
```

## One-shot helpers

```ts
import { Contractful } from 'contractful-ts';

const { body } = await Contractful.get('https://api.github.com/users/octocat');
```

## Events (WebSocket)

The events DSL is the sibling of `defineApi`: declare channels instead of endpoints, and the library derives a typed client with contractful's signature split — **outgoing messages are validated closed-world** (typos and missing required fields never reach the wire), **incoming messages are gated open-world** (unknown fields are data, declared fields must be well-formed).

```ts
import { defineEvents, subscribe, publish, P } from 'contractful-ts';

export const OrderEvents = defineEvents({
  name: 'OrderEvents',
  url: 'wss://api.example.com/events',
  channels: {
    onOrderCreated: subscribe<{ orderId: string; total?: number }>('order.created', {
      fields: {
        orderId: P.string({ required: true }),
        total: P.float({ min: 0 }),
      },
    }),
    onItemAdded: subscribe<{ sku: string }>('order/:orderId/item.added', {
      params: { orderId: P.string({ required: true }) },   // topic params, typed
      fields: { sku: P.string({ required: true }) },
    }),
    createOrder: publish<{ productId: string; quantity: number }>('order.create', {
      fields: {
        productId: P.string({ required: true }),
        quantity: P.integer({ required: true, min: 1 }),
      },
    }),
  },
});

const events = new OrderEvents({ authMode: 'query', tokenProvider: () => token });
await events.connect();

const off = events.onOrderCreated((message, { topic }) => console.log(topic, message.orderId));
await events.createOrder({ productId: 'p1', quantity: 2 }); // validated, then { topic, payload } envelope
```

The runtime underneath is production-shaped, not a thin wrapper:

- **Reconnection** with exponential backoff + full jitter, attempt budgets, per-attempt connect timeouts — subscriptions survive reconnects.
- **Heartbeats** with a liveness timeout that force-closes dead connections.
- **Topic routing** — exact topics, `:param` patterns (`order/:id/created`), single-segment `*` and the global `*` wildcard.
- **Envelopes are configurable** — the default is JSON `{ topic, payload }`; swap `publishEnvelope` / `topicExtractor` / `payloadExtractor` for Socket.IO-style `{ event, data }` or anything else, and inject a `socketFactory` to adapt any transport.
- **Every auth mode that matters** — `query`, `subprotocol`, `connect-message`, `ticket` (one-time ticket via `tokenProvider`) and `header` (works through the default factory on Node whenever the optional `ws` peer is installed — including Node 22+, where the built-in `WebSocket` cannot set upgrade headers), plus a full `authProvider` integration where `getAuth({ transport: 'websocket', ... })` decides the material per (re)connection. Browsers cannot set headers on the WebSocket upgrade — the browser-safe modes are the defaults.
- **Close-code policy** — private-use codes are convention: `4001` (token expired) triggers `authProvider.handleUnauthorized` and reconnects only on a successful refresh; `4003` / `4004` surface as a terminal `WebSocketApiError` without retrying. `onAuthStateChanged` proactively reconnects with fresh credentials before the server notices an expiry.
- **Server-side subscriptions** — set `subscribeEnvelope` / `unsubscribeEnvelope` and every registered pattern is (re)sent after each reconnect from the refcounted registry.
- **Event ids** — envelopes carrying `.id` / `.eventId` are tracked in `getLastEventId()` and handed to handlers via `ctx.eventId`, so you can catch up over REST after a disconnect (`GET /events?since=<lastId>`). Don't assume exactly-once delivery; make consumers idempotent.
- The low-level `EventsClient` and `ReconnectingSocket` are exported for direct use; `ws` is loaded lazily as an optional peer in Node. Socket.IO users inject `socketFactory: () => io(url)` and map envelopes through `topicExtractor` / `publishEnvelope`.
- **Browser compatibility is pinned by tests.** The runtime is driven through a class exposing only the browser-standard `WebSocket` surface — `new WebSocket(url, protocols)`, the four `on*` handlers, `send` and `close(code, reason)` — against a real server, so any accidental reliance on `ws`-only APIs (`.terminate()`, upgrade options, socket events) fails CI. In the browser the default factory uses the global constructor; upgrade-header auth falls back to query/subprotocol/connect-message modes there.

Invalid incoming messages surface as `MessageShapeError` through `onError` (or your own `onInvalidMessage` hook) without dropping the connection.

GraphQL subscriptions work too — `createGraphQLWsClient` speaks the `graphql-transport-ws` protocol (connection_init/ack, id-correlated next/error/complete, ping/pong, resubscribe after reconnect) on the same socket machinery.

Both runtimes are additionally tested against a **real `ws` server** on the loopback interface — genuine TCP, frames and close codes, abnormal-drop reconnection, heartbeat liveness timeouts, the 4001 token-expiry refresh cycle, a TCP server that never completes the upgrade, and the full graphql-transport-ws handshake/stream/reconnect cycle — not only against scripted fakes.

## The unified platform facade

REST and WebSocket have different lifecycles — stateless request/response vs. stateful connection — so the transports stay separate internally and are merged only at the API surface. `createPlatformClient` gives your app one typed handle with shared auth and a single `dispose()`:

```ts
import { createPlatformClient, createEventsCacheInvalidator } from 'contractful-ts';

const platform = createPlatformClient({
  authProvider,                                     // shared, transport-aware
  rest: ({ auth }) => new ShopApi({ auth }),        // HTTP: bridged resolver (401 → single refresh + retry)
  events: ({ authProvider }) => new ShopEvents({ authProvider }),
  identity: { clientName: 'shop-web', clientVersion: '1.2.3' }, // X-Client-Name / X-Client-Version
});

await platform.events.connect();                    // lifecycle stays explicit
const product = await platform.rest.getProduct({ id: 'p1' });
const off = platform.events.onOrderCreated((msg) => invalidateCache(msg));

await platform.dispose();                           // disconnects events; REST is stateless
```

Commands go through REST, events arrive through the socket. For UI work, `createEventsCacheInvalidator` wires events to cache invalidation without baking any cache into the transports:

```ts
const stop = createEventsCacheInvalidator(platform.events.raw, [
  { event: 'order.created', invalidate: () => queryClient.invalidateQueries({ queryKey: ['orders'] }) },
]);
```

## Generating clients from any spec (`contractful-gen`)

The CLI turns API descriptions into typed contract modules — one per group, in the same auto-generated-connector style as Binance's connectors, but emitting the runtime DSL so the output stays readable, typed and editable. Formats are auto-detected:

| Format                   | Input                              | Output                                        |
| ------------------------ | ---------------------------------- | --------------------------------------------- |
| OpenAPI 3.x / Swagger 2.0 | `openapi: 3.x` / `swagger: 2.0`  | typed HTTP contracts (`defineApi`)            |
| AsyncAPI 2.x / 3.x      | `asyncapi: 2.x` / `3.x`           | typed event channels (`defineEvents`)         |
| Postman Collection v2.x | `info.schema: ...getpostman.com`  | HTTP contracts, types inferred from examples  |
| GraphQL SDL             | `type Query { ... }`              | typed query/mutation client + subscriptions   |
| api-model               | `kind: contractful-api-model`      | round-trip regeneration from a dumped model   |

```bash
npx contractful-gen --spec ./openapi/petstore.yaml --out ./src/petstore
npx contractful-gen --spec ./asyncapi/events.yaml --out ./src/events
npx contractful-gen --spec ./schema.graphql --out ./src/graphql
npx contractful-gen --spec ./collection.postman_collection.json --out ./src/api
```

Or mix formats in one run with a config:

```jsonc
// codegen.json
{
  "output": "src/generated/clients",
  "sources": [
    { "path": "specs/rest.yaml", "namespace": "rest" },
    { "path": "specs/events.yaml", "namespace": "events" },
    { "path": "specs/support.postman_collection.json", "namespace": "support" },
    { "path": "specs/catalog.graphql", "namespace": "catalog" }
  ]
}
```

```bash
npx contractful-gen --config codegen.json
```

```
contractful-gen: running config codegen.json (4 source(s)) ...
contractful-gen: generated 12 file(s) across 4 namespace(s) → src/generated/clients
```

Each namespace gets its own directory with an index; a root `index.ts` re-exports everything. A complete runnable example lives in [`examples/multi-format/`](examples/multi-format/) — four formats, one command, strict-tsc-clean output.

### What multi-source runs emit

When a config mixes HTTP and event sources, the generator additionally emits:

- **`platform.ts`** — a `createPlatformClient(options)` facade unifying every HTTP group (`platform.rest.orders.*`, `platform.rest.products.*`, ...) and every events group (`platform.events.*`) behind one call, with the shared `authProvider` bridged into the HTTP pipeline, `X-Client-Name` / `X-Client-Version` identity headers and a single `dispose()`. Disable with `"platform": false` or `--no-platform`.
- **`CLIENT_METADATA`** — deterministic provenance in every index: generator version plus a `sha256:` hash of each source document, so you can verify which spec revision a bundle was built from.
- **A typed auth surface** — specs with `securitySchemes` produce `auth.ts` (`SecuritySchemeName`, a discriminated `AuthOptions` union, `SecurityScope`) and per-operation `security: ["OAuth2", "orders:read"]` metadata that flows into `AuthContext.scopes` at runtime. Secrets are never generated — only their shape.

Domain grouping works across formats: tag an operation with `x-client-domain: admin` (OpenAPI/Postman) or a channel with `x-client-domain: orders` / `x-client-event-name: orderCreated` (AsyncAPI) and it lands in its own generated client group — `platform.rest.admin`, `platform.events.orders` — instead of the default bucket.

Deterministic event naming is configurable:

```jsonc
{
  "naming": { "eventNameStyle": "dot.case", "handlerPrefix": "on", "stripVersion": true }
}
```

`order.v1.created` becomes the method `onOrderCreated`, and a per-namespace `EVENT_NAMES` map (`"order.created": "order.v1.created"`) keys string-based subscriptions for the low-level `raw.subscribe()` escape hatch.

**Multi-message channels become typed unions.** An AsyncAPI channel whose operation carries `message.oneOf: [ProductCreated, ProductPriceChanged]` no longer fans into per-message methods that false-positive each other's shape gate — it emits one method with a generated union:

```ts
export interface ShopEventsProductCreated { productId: string; title?: string; }
export interface ShopEventsProductPriceChanged { productId: string; price: number; }
export type ShopEventsOnProductEventsMessage = ShopEventsProductCreated | ShopEventsProductPriceChanged;

// in the channel map:
onProductEvents: subscribe<ShopEventsOnProductEventsMessage>("product.events"),
```

For envelope-style servers (one discriminator field fanning many event types), bind the exported `EventEnvelope<Type, Payload>` helper to your payload types and narrow with a `switch`.

Generated file (excerpt — real output for the Swagger petstore):

```ts
// Auto-generated by contractful-gen from openapi/petstore.yaml — DO NOT EDIT.
import { defineApi, contract, P } from "contractful-ts";

export const petApi = defineApi({
  name: "Swagger Petstore - OpenAPI 3.0 · pet",
  base: "https://petstore3.swagger.io/api/v3",
  contracts: {
    /** Find pet by ID — Returns a single pet */
    getPetById: contract("GET /pet/:petId", {
      params: {
        petId: P.integer({ required: true, describe: "ID of pet to return" }),
      },
      responds: [{ status: 200, type: "hash" }, { status: 400 }, { status: 404 }],
    }),
    ...
  },
});
```

What the generator maps automatically:

| OpenAPI                          | Emitted contract                              |
| -------------------------------- | --------------------------------------------- |
| `operationId`                    | camelCase method name (derived from path when absent) |
| `{petId}` path params            | `:petId` + `P.integer({ required: true })`    |
| `query`/`header`/`cookie` params | `in: 'query'` / `in: 'header'` / query        |
| request body object properties   | `in: 'body'` params, `required` from schema   |
| `enum`                           | `inclusion: [...]`                            |
| `minimum`/`maximum`              | `min`/`max`                                   |
| `minLength`/`maxLength`          | `length: { min, max }`                        |
| `pattern`                        | `new RegExp(...)`                             |
| `default`                        | `default`                                     |
| response schema type             | `responds: [{ status, type }]`                |
| first tag                        | output file / `defineApi` const               |

### OpenAPI schema support matrix

What the generator translates, what it translates with a warning, and what it rejects:

| Construct                            | Behavior                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| path-level `parameters`              | inherited by every operation; operation-level entries override on `(name, in)`                              |
| `requestBody.required`               | preserved — `bodyRequired: true` guarantees a body when every property is optional                          |
| scalar / array / free-form bodies    | `raw: true` body param — the payload serializes as itself, never `{ body: value }`                          |
| `application/x-www-form-urlencoded`  | `form: true` (also Swagger 2.0 `formData`)                                                                  |
| `allOf`                              | merged — properties and `required` union, numeric bounds intersect (tightest wins)                          |
| recursive `$ref` cycles              | cycle cut at the first repeat; the affected param emits as a free-form `P.hash()` with a `// NOTE:` warning   |
| `oneOf` / `anyOf`                    | accepted as any value (`P.custom(() => true)`) with a warning — no discriminated-union inference             |
| `nullable: true`                     | warning — the runtime treats `null` as "not provided"                                                       |
| `multipart/form-data` bodies         | warning — body properties are emitted but multipart encoding is not performed                               |
| Swagger 2.0 `type: file`             | warning — emitted as a string placeholder; multipart upload is out of scope                                  |
| external `$ref` / YAML anchors       | rejected with a clear error — inline them or convert the spec to JSON first                                  |

Every warning is surfaced twice: as a `// NOTE:` comment on the affected contract and in the generated file header, so unsupported constructs are never silently dropped.

**SSE is not implemented.** `AuthContext.transport` reserves an `'sse'` value for future use, but there is no SSE client runtime in this package — streaming HTTP today means the WebSocket events runtime or GraphQL subscriptions over `graphql-transport-ws`. Do not rely on the `sse` transport hint.

CLI options:

```
--spec, -s <path|url>       Spec (JSON/YAML file or URL; .graphql for SDL)
--out, -o <dir>             Output directory
--config, -c <file>         Multi-source config (JSON or YAML)
--format, -f <kind>         Force format: auto|openapi|asyncapi|postman|graphql|api-model
--namespace, -n <name>      Subdirectory for single-spec runs
--emit <mode>               runtime (default) | standalone (zero runtime imports)
--base, -b <url>            Override the spec's server / WebSocket URL
--import-from, -i <pkg>     Import specifier (default: contractful-ts)
--group-by, -g <mode>       Group HTTP contracts by tag (default) or path
--perspective <p>           AsyncAPI direction: server (default) | client
--max-per-file <n>          Split large groups into files of at most n ops
--dump-model <file>         Write the canonical model as JSON instead of code
```

Format-specific notes:

- **AsyncAPI** — `publish`/`subscribe` flip meaning depending on whose perspective the document is written from. The default `--perspective server` treats the doc as the API provider's (server `publish` → client subscribes); pass `client` for Streetlights-style documents that describe the client app. `{param}` channel addresses become typed topic params.
- **Postman** — collections are examples, not contracts: types inferred from request/response examples are marked `(inferred from example)`, numeric strings stay strings, and detected collection auth is surfaced as a note on the generated client.
- **GraphQL** — queries and mutations get one typed method each, executing a generated full-selection document (depth-capped, cycle-safe) through the HTTP transport; subscriptions speak `graphql-transport-ws` over the events runtime. `--dump-model` is not available for GraphQL sources.
- **api-model** — `--dump-model` serializes any spec into the canonical model JSON, which is itself a valid input — handy for diffing, caching or pre-processing specs.

### Standalone emit (zero runtime dependency)

`--emit standalone` generates self-contained clients that import **nothing** from contractful-ts — a tiny fetch-based `_http.ts` and a dependency-free `_ws.ts` mini-runtime are emitted alongside the typed wrappers. Trade-off: types only, no validation/retries/circuit breaking. GraphQL subscriptions require the runtime mode.

```bash
npx contractful-gen --spec ./openapi/petstore.yaml --out ./src/petstore --emit standalone
```

```ts
import { createPetsApi } from './src/petstore';

const api = createPetsApi({ baseUrl: 'https://petstore3.swagger.io/api/v3' });
const pets = await api.listPets({ limit: 20 });   // typed, fetch-based, no dependencies
```

Notes on YAML support: the bundled parser is a dependency-free subset covering everything typical specs use (block/flow collections, quoted and block scalars, comments). Anchors/aliases (`&a`, `*a`) and external `$ref`s are rejected with clear errors — convert to JSON or inline them first.

### Programmatic generation

```ts
import { generateFromOpenAPI, runCodegen } from 'contractful-ts/codegen';

// Single spec:
const { ir, files } = await generateFromOpenAPI('./openapi.json', { groupBy: 'tag' });

// Multi-format config — every format the CLI supports:
const bundle = await runCodegen({
  output: 'src/generated/clients',
  sources: [
    { path: 'specs/rest.yaml', namespace: 'rest' },
    { path: 'specs/events.yaml', namespace: 'events' },
  ],
});
for (const file of bundle.files) console.log(file.path, file.content.length);
```

## Examples

- [`examples/ticket-demo/`](examples/ticket-demo/) — **end-to-end**: REST + WebSocket sharing one ticket authority (token manager → one-time WS tickets → 401/4001 recovery → REST catch-up), fully deterministic against an in-process mock server; covered by `tests/ticket-demo.test.ts`
- [`examples/github/github.ts`](examples/github/github.ts) — public API, cursor pagination, closed-schema demos
- [`examples/binance/binance.ts`](examples/binance/binance.ts) — Binance-style spot connector: HMAC-SHA256 request signing via `beforeRequest` with known-answer test vectors, `X-MBX-APIKEY`, rate limiting, query-string signed POST orders and no auto-retry on ambiguous order failures (run: `node examples/binance/binance.ts`). To verify the signing path against a **real** server, create free testnet keys at [testnet.binance.vision](https://testnet.binance.vision) and run `BINANCE_TESTNET_KEY=... BINANCE_TESTNET_SECRET=... node scripts/binance-testnet-check.mjs` — or `npx vitest run tests/binance-testnet.test.ts` with the same env (the suite skips itself when the env is absent, keeping CI hermetic).
- [`examples/openapi/petstore.yaml`](examples/openapi/petstore.yaml) + `examples/openapi/generated/` — spec and generated connector
- [`examples/multi-format/`](examples/multi-format/) — OpenAPI + AsyncAPI + Postman + GraphQL in one `codegen.json` run, with strict-tsc-checked generated output

## Project layout

```
src/
  dsl/          contract(), defineApi(), defineEvents(), param factories (P.*)
  validation/   closed-request validation, open-response validation
  http/         axios transport, route/path builder, quick helpers
  events/       WebSocket runtime: reconnecting socket, events client,
                topic routing, graphql-transport-ws, events DSL
  middleware/   auth resolvers, retry policy, circuit breaker, rate limiter
  codegen/      format detection, canonical model, OpenAPI/AsyncAPI/Postman/
                GraphQL adapters, TS emitters (runtime + standalone), CLI
tests/          vitest suite (434 tests — unit + round-trips + retry-safety, OpenAPI
                wire-format and signing regressions + the e2e ticket demo +
                real-server transport boundary, lifecycle/cancellation races,
                malformed-spec rejection and generator round-trip determinism);
                tests/types/ additionally strict-tsc-checked (compile-time contracts)
examples/       end-to-end ticket demo, GitHub + Binance-style connectors,
                OpenAPI + multi-format fixtures
```

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # strict tsc over src + the compile-time test contracts
npm test            # build + vitest run
```

The test suite covers validation, path building, response classification, retry/backoff math, method-aware retry safety (non-idempotent requests are never auto-replayed; idempotency keys stay stable across attempts), circuit state transitions, rate pacing, auth (including the 401-refresh path and the client-credentials provider), the full DSL pipeline through a mock transport, the YAML parser against realistic OpenAPI documents, the events runtime against a scripted fake socket (reconnects, heartbeats, auth modes, routing), the graphql-transport-ws protocol, every format adapter, multi-source configs, codegen round-trips that import generated files and run them — including strict `tsc` checks of generated output — OpenAPI wire-format regressions (parameter inheritance, formData, required bodies, raw scalar/array bodies, recursive refs, combinators), the Binance signing example against known-answer vectors, and an end-to-end ticket-authentication demo (`examples/ticket-demo/`) that runs the full REST + WS lifecycle against an in-process mock server.

Beyond the fakes: the events and graphql-transport-ws runtimes are exercised against a **real `ws` server** over loopback TCP (frames, close codes, abnormal-drop reconnection with resubscription, heartbeat liveness timeouts, the 4001 refresh cycle, header/query/subprotocol auth on real upgrade requests, a never-upgrading TCP server, and the graphql handshake/stream/reconnect cycle); a browser-shaped `WebSocket` adapter (standard surface only) pins browser compatibility; AsyncAPI edge cases cover 2.x `operationId`, server-URL variables, `$ref`'d messages/parameters and bidirectional channels; and an opt-in live suite verifies Binance request signing against the public testnet (`tests/binance-testnet.test.ts`, skipped without `BINANCE_TESTNET_KEY`/`BINANCE_TESTNET_SECRET`).

## License

MIT
