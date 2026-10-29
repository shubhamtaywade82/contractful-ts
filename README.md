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
npm install contractful-ts   # Node 18+, axios (peer); `ws` is an optional peer for Node < 22
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

- **Typed methods** — argument objects and return types are inferred from the declarations (`contract<User[]>('GET /users', …)` pins the result type).
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

## Retries, circuit breaker, rate limiting

```ts
defineApi({
  retry:   { retries: 3, baseDelay: 200, maxDelay: 5_000, jitter: 'full' },
  circuit: { failureThreshold: 5, cooldownMs: 10_000, halfOpenProbes: 1 },
  rateLimit: { requestsPerSecond: 8, burst: 4 },
  ...
})
```

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
- **Three browser-safe auth modes** — `query` (token in the URL, refreshed per attempt), `subprotocol`, and `first-message` — because browsers cannot set headers on the WebSocket upgrade.
- The low-level `EventsClient` and `ReconnectingSocket` are exported for direct use; `ws` is loaded lazily as an optional peer in Node.

Invalid incoming messages surface as `MessageShapeError` through `onError` (or your own `onInvalidMessage` hook) without dropping the connection.

GraphQL subscriptions work too — `createGraphQLWsClient` speaks the `graphql-transport-ws` protocol (connection_init/ack, id-correlated next/error/complete, ping/pong, resubscribe after reconnect) on the same socket machinery.

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

- [`examples/github/github.ts`](examples/github/github.ts) — public API, cursor pagination, closed-schema demos
- [`examples/binance/binance.ts`](examples/binance/binance.ts) — Binance-style spot connector: HMAC-SHA256 request signing via `beforeRequest`, `X-MBX-APIKEY`, rate limiting, idempotent order placement (run: `node examples/binance/binance.ts`)
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
tests/          vitest suite (265 tests — unit + round-trips)
examples/       GitHub + Binance-style connectors, OpenAPI + multi-format fixtures
```

## Development

```bash
npm install
npm run build    # tsc -> dist/
npm test         # build + vitest run
```

The test suite covers validation, path building, response classification, retry/backoff math, circuit state transitions, rate pacing, auth (including the 401-refresh path and the client-credentials provider), the full DSL pipeline through a mock transport, the YAML parser against realistic OpenAPI documents, the events runtime against a scripted fake socket (reconnects, heartbeats, auth modes, routing), the graphql-transport-ws protocol, every format adapter, multi-source configs, and codegen round-trips that import generated files and run them — including strict `tsc` checks of generated output.

## License

MIT
