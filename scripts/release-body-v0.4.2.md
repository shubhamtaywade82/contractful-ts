Real-server integration, browser compatibility, AsyncAPI edges, Binance testnet harness.

## Fixed: header auth now works on Node 22+ through the default socket factory

- The default factory prefers the global `WebSocket` (browsers, Node 22+), but the standard constructor cannot set upgrade-request headers — so `authMode: 'header'` silently dropped them on Node 22+. When auth material asks for headers, the factory now routes through the lazily imported `ws` (Node only), making header auth work on every Node version where the optional peer is installed. Browsers still cannot set upgrade headers (by design) — the browser-safe auth modes remain the defaults.

## Fixed: AsyncAPI adapter gaps

- AsyncAPI 2.x `operationId` on `publish`/`subscribe` is now used as the generated method name, matching the 3.x operation-key behavior.
- Server URLs with `{variable}` templates are filled from each variable's `default` (2.x `servers.*.url` and 3.x `servers.*.host`); variables without a default stay visible in the URL instead of silently producing a broken one.

## Added: real-server integration tests (the last audit residuals)

- The events runtime and the graphql-transport-ws client are now exercised against a **real `ws` WebSocketServer** on loopback — genuine TCP, frames and close codes: publish/subscribe round-trips, abnormal-drop reconnection with subscription resending, heartbeat liveness timeouts (close 4000 → recovery), the 4001 token-expired → refresh → reconnect cycle, header/query/subprotocol auth on real upgrade requests, a TCP server that never completes the handshake (connect-timeout budget), and the full graphql handshake/stream/error/reconnect-resubscribe cycle with ping/pong keepalives. The default socket factory is used throughout, so the CI matrix covers both the global-`WebSocket` path (Node 22/24) and the lazy `ws`-import path (Node 18).
- **Browser compatibility is pinned**: the runtime is driven through a class exposing only the browser-standard `WebSocket` surface (two-argument construction, `on*` handlers, `send`, `close(code, reason)`) against the real server — any accidental reliance on `ws`-only APIs fails CI.
- **Binance testnet harness**: `scripts/binance-testnet-check.mjs` sends a real signed `GET /api/v3/account` to testnet.binance.vision (read-only), and `tests/binance-testnet.test.ts` runs the same check — plus a tampered-signature rejection test — when `BINANCE_TESTNET_KEY` / `BINANCE_TESTNET_SECRET` are set, skipping hermetically otherwise.
- AsyncAPI edge cases: 2.x `operationId`, server-URL variable substitution, `$ref`'d messages and channel parameters, bidirectional channels, and the documented untyped-payload limitation for non-object payloads.
- `ws` + `@types/ws` joined the dev dependencies (server side of the new tests); the runtime dependency surface is unchanged — `ws` stays an optional peer. +25 tests (408 → 433).

**Full Changelog**: https://github.com/shubhamtaywade82/contractful-ts/compare/v0.4.1...v0.4.2
