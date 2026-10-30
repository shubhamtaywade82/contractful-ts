Resilience audit: cancellation in the pipeline, real-transport coverage, malformed-spec gates.

## Fixed: aborted requests no longer hang in the rate-limit queue

- `RateLimiter.acquire()` now accepts an `AbortSignal` (passed by the request pipeline): a caller aborted while waiting for its pacing slot rejects immediately with `RequestAbortedError` and cancels its scheduled-but-unfired slot timer, instead of holding the request open until the slot would have arrived. The freed slot and queue space stay reusable.
- Abort coverage previously depended on the transport noticing the signal; now both waits owned by the library itself (rate-limit pacing and retry backoff) reject on abort.

## Fixed: malformed specs are rejected loudly, never silently emitted

- `buildApiIR()` throws `OpenApiError` for documents that declare neither an `openapi` nor a `swagger` version instead of generating an empty client. A valid OpenAPI document without `paths` (legal only in 3.1) still generates, with a visible warning in `ir.notes`.
- `buildPostmanIR()` mirrors the gate: documents without the collection shape throw `PostmanError`.
- `generateFromSpecText()` now parses through `parseSpecText`, so broken JSON/YAML and scalar/array-rooted documents surface as `OpenApiError` like every other entry point, instead of leaking raw `SyntaxError` / `YamlParseError`.

## Hardened: Release workflow supports manual re-releases

- `workflow_dispatch` with a `tag` input re-runs verification, refreshes the draft GitHub Release and publishes to npm for an existing tag — no tag deletion/re-push (the recovery path for a missing `NPM_TOKEN` or a registry hiccup). `skip_publish` drafts without touching npm.
- A `resolve` job cross-checks the tag against `package.json`'s version and fails fast on mismatch; the publish step is idempotent (a version already on npm is skipped, not re-published).

## Tests: +53 (355 → 408) across four new dimensions

- **Real-transport boundary** (17): a genuine local HTTP server through the default AxiosTransport — wire formats, status passthrough, non-JSON and 204 bodies, ECONNREFUSED / timeout / abort error mapping, plus full-pipeline behavior (GET retry after 5xx, POST not retried, 429 + Retry-After, abort during backoff).
- **Lifecycle races & cancellation** (12): abort-in-queue, pre-aborted signals, queue-full through the client, pacing on retry attempts, aborted half-open circuit probes, events-runtime races (close during backoff with no zombie timer, concurrent `open()` sharing one attempt).
- **Malformed-spec rejection** (13): broken JSON/YAML, scalar/array roots, missing files, non-OpenAPI and non-Postman documents, no-`paths` warning, valid specs still passing.
- **Generator round-trip determinism** (8): byte-identical emission for repeated runs and after a `serialize → parse → IR` cycle, models as serialization fixed points, stable source hashing.

**Full Changelog**: https://github.com/shubhamtaywade82/contractful-ts/compare/v0.4.0...v0.4.1
