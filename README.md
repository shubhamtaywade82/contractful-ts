# contractful-ts

[![CI](https://github.com/shubhamtaywade82/contractful-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/shubhamtaywade82/contractful-ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](./package.json)

**Contract-first HTTP client for TypeScript.** Declare the HTTP shape of an API — verb, path, typed parameters, expected responses — and get fully typed client methods with validation, auth, retries, circuit breakers and rate limiting. Ships with an OpenAPI → contract generator (`contractful-gen`) in the spirit of [binance-connector-js](https://github.com/binance/binance-connector-js).

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
npm install contractful-ts   # peer: Node 18+, axios
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

## Generating connectors from OpenAPI (`contractful-gen`)

The CLI turns any OpenAPI 3.x / Swagger 2.0 spec (JSON or YAML, file or URL) into typed contract modules — one per tag, in the same auto-generated-connector style as Binance's connectors, but emitting the runtime DSL so the output stays readable, typed and editable.

```bash
npx contractful-gen \
  --spec ./openapi/petstore.yaml \
  --out ./src/petstore \
  --import-from contractful-ts
```

```
contractful-gen: generated 4 file(s) for 12 operation(s) in 3 group(s)
  · pet.ts (7 ops)
  · store.ts (3 ops)
  · user.ts (2 ops)
```

Generated file (excerpt — this is real output for the Swagger petstore):

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
--spec, -s <path|url>     OpenAPI/Swagger spec (JSON or YAML, file or URL)
--out, -o <dir>           Output directory
--base, -b <url>          Override the spec's server URL
--import-from, -i <pkg>   Import specifier (default: contractful-ts)
--group-by, -g <mode>     Group by tag (default) or path
--max-per-file <n>        Split large groups into files of at most n ops
```

Notes on YAML support: the bundled parser is a dependency-free subset covering everything typical specs use (block/flow collections, quoted and block scalars, comments). Anchors/aliases (`&a`, `*a`) and external `$ref`s are rejected with clear errors — convert to JSON or inline them first.

### Programmatic generation

```ts
import { generateFromOpenAPI } from 'contractful-ts/codegen';

const { ir, files } = await generateFromOpenAPI('./openapi.json', { groupBy: 'tag' });
for (const file of files) console.log(file.path, file.content.length);
```

## Examples

- [`examples/github/github.ts`](examples/github/github.ts) — public API, cursor pagination, closed-schema demos
- [`examples/binance/binance.ts`](examples/binance/binance.ts) — Binance-style spot connector: HMAC-SHA256 request signing via `beforeRequest`, `X-MBX-APIKEY`, rate limiting, idempotent order placement (run: `node examples/binance/binance.ts`)
- [`examples/openapi/petstore.yaml`](examples/openapi/petstore.yaml) + `examples/openapi/generated/` — spec and generated connector

## Project layout

```
src/
  dsl/          contract(), defineApi(), param factories (P.*)
  validation/   closed-request validation, open-response validation
  http/         axios transport, route/path builder, quick helpers
  middleware/   auth resolvers, retry policy, circuit breaker, rate limiter
  codegen/      OpenAPI loader, YAML subset parser, TS emitter, CLI
tests/          vitest suite (166 tests — unit + round-trip)
examples/       GitHub + Binance-style connectors, OpenAPI fixtures
```

## Development

```bash
npm install
npm run build    # tsc -> dist/
npm test         # build + vitest run
```

The test suite covers validation, path building, response classification, retry/backoff math, circuit state transitions, rate pacing, auth (including the 401-refresh path and the client-credentials provider), the full DSL pipeline through a mock transport, the YAML parser against realistic OpenAPI documents, and a codegen round-trip that imports generated files and runs them.

## License

MIT
