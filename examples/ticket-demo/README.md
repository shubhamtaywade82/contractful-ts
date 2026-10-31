# End-to-end example: REST + WS shared ticket authentication

A complete, runnable demo of the pattern the library is built around: **one
credential authority serving both transports**.

```
            ┌──────────────────────────────┐
            │        TokenManager          │  single-flight refresh
            └──────────┬───────────────────┘
                       │
              shared AuthProvider
             ┌─────────┴─────────┐
             │                   │
     transport: http      transport: websocket
             │                   │
   Authorization: Bearer   POST /auth/ws-ticket  →  ?ticket=wst_…
   (REST calls)            (one-time, per connection)
```

The fictional platform is a courier service:

- `CourierAuthApi` — the credential desk (`POST /auth/token`,
  `POST /auth/ws-ticket`)
- `CourierApi` — the business REST surface (list/create/show shipments)
- `CourierEvents` — the WebSocket channels (`shipment.created`,
  parameterised `shipment/:shipmentId/status`, `driver.ping` → `driver.pong`)

Everything runs against `MockCourierServer` — an in-process double that
implements the library's `Transport` and `SocketFactory` interfaces and
acts as the strict ticket authority: tickets are single-use, tokens expire
only when the demo says so, and events only reach sockets that subscribed
to a matching pattern. No network, no ports, fully deterministic.

## What the scenario proves

| # | Step | Guarantee under test |
|---|------|----------------------|
| 1 | Connect the events socket | token fetch → one-time ticket mint → `?ticket=` connect |
| 2 | Subscribe | server-side subscribe frames, refcounted registry |
| 3 | `GET /shipments` | shared bearer, cached token (no extra fetch) |
| 4 | `POST /shipments` | REST write fans out a typed `shipment.created` event |
| 5 | Status channel | `:param` topic patterns with typed `ctx.params` |
| 6 | `driver.ping` | publish → server answers on `driver.pong` |
| 7 | Typo'd publish | closed-world validation rejects it before the wire |
| 8 | Server drops the socket | auto-reconnect on a **fresh** ticket, registry re-sent |
| 9 | Write again | events still arrive after the reconnect |
| 10 | Access tokens expire | REST 401 → refresh + one retry; healthy socket rotates onto the new credentials; **one** `/auth/token` call shared by both |
| 11 | Server kicks with 4001 | same shared recovery: clear → refresh → reconnect |
| 12 | Write again, after recovery | the recovered platform delivers created + status events |
| 13 | `since=<lastEventId>` | the REST catch-up idiom after a disconnect |
| 14 | Replay a consumed ticket | refused with `4003` (single-use enforced) |
| 15 | `dispose()` | one call tears down both transports |

## Running it

```bash
npm run build

# through the test suite (any Node the CI matrix runs):
npx vitest run tests/ticket-demo.test.ts

# or directly, with a TypeScript-capable runner:
npx tsx examples/ticket-demo/main.ts
```

The test suite also strict-`tsc`-checks this directory
(`tsconfig.check.json`), so the example can never drift from the types the
library actually ships.

## Files

- [`server.ts`](server.ts) — `MockCourierServer`: in-process REST + WS double, ticket authority
- [`contracts.ts`](contracts.ts) — the three contract declarations (pure data)
- [`auth.ts`](auth.ts) — `createSharedTicketAuth`: the reusable wiring (TokenManager + transport-aware AuthProvider)
- [`main.ts`](main.ts) — `runTicketDemo()`: the fourteen-step scenario and its result type
