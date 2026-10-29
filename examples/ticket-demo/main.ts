/**
 * End-to-end demo: REST + WebSocket sharing ONE ticket authority.
 *
 * The scenario, in one breath:
 *
 *   1. The platform facade opens the events socket. The shared
 *      AuthProvider fetches an access token over REST, mints a one-time
 *      ticket with it, and connects with `?ticket=...`.
 *   2. Subscriptions are registered (and re-sent by the runtime after
 *      every reconnect — the registry survives).
 *   3. A REST write (`POST /shipments`) fans an event out over the
 *      socket; a parameterised status channel fires next; a publish gets
 *      answered by a pong.
 *   4. The socket drops: reconnection mints a FRESH single-use ticket
 *      and re-subscribes automatically.
 *   5. Access tokens expire server-side: the next REST call takes a 401,
 *      refreshes single-flight, retries — and the healthy socket is
 *      proactively rotated onto the new credentials at the same time.
 *   6. The server kicks the socket with 4001: same shared recovery.
 *   7. A rogue client replays a consumed ticket and is refused with 4003.
 *   8. `getLastEventId()` powers a REST catch-up; dispose tears it down.
 *
 * Run it (Node with TypeScript support, e.g. `npx tsx`):
 *
 *   npm run build && npx tsx examples/ticket-demo/main.ts
 *
 * Or through the test suite (works on every Node the CI matrix runs):
 *
 *   npx vitest run tests/ticket-demo.test.ts
 */

import { pathToFileURL } from 'node:url';
import {
  ContractViolationError,
  EventsClient,
  WebSocketApiError,
  createPlatformClient,
  staticAuthProvider,
} from '../../dist/index.js';
import { createSharedTicketAuth } from './auth.js';
import { CourierApi, CourierAuthApi, CourierEvents } from './contracts.js';
import {
  MockCourierServer,
  type MockCourierServerOptions,
  type ShipmentRecord,
  type SocketAttempt,
} from './server.js';
import type {
  DriverPongEvent,
  ShipmentCreatedEvent,
  ShipmentStatusEvent,
} from './contracts.js';

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

export interface TicketDemoOptions {
  /** Called with every narration line as the demo progresses. */
  onLog?: (line: string) => void;
  /** Mock-server knobs (timings mostly — the defaults suit the test suite). */
  server?: MockCourierServerOptions;
}

export interface TicketDemoResult {
  /** Narration, one entry per step (also streamed to `onLog`). */
  log: string[];
  /** The mock server — exposed for test assertions. */
  server: MockCourierServer;
  /** Every connection attempt, in order (rejected ones included). */
  socketAttempts: SocketAttempt[];
  /** Just the URLs, in order (each shows the ticket it presented). */
  socketUrls: string[];
  admittedSocketCount: number;
  tokenCalls: number;
  ticketCalls: number;
  restCalls: number;
  unauthorizedRestCalls: number[];
  rejectedTickets: string[];
  shipments: ShipmentRecord[];
  createdEvents: ShipmentCreatedEvent[];
  statusEvents: ShipmentStatusEvent[];
  /** Topic params captured from `shipment/:shipmentId/status` frames. */
  statusParams: string[];
  pongs: DriverPongEvent[];
  /** Subscriptions re-sent by the runtime after the drop (step 4). */
  resubscribeCount: number;
  /** The reconnect presented a different (fresh) ticket than the first. */
  ticketRotatedOnReconnect: boolean;
  /** `POST /shipments` events still arrived after the reconnect. */
  eventsAfterReconnect: number;
  /** The 401'd REST call recovered via refresh + single retry. */
  recoveredFromRest401: boolean;
  /** Token-endpoint calls consumed by the 401 recovery (REST retry and
   *  socket rotation share one single-flight refresh). */
  tokenCallsFor401Recovery: number;
  reconnectedAfterDrop: boolean;
  reconnectedAfterKick: boolean;
  /** Shipments returned by the `since` catch-up query. */
  caughtUpShipments: number;
  catchUpSince: string;
  lastEventId: string | null;
  /** The closed-world publish gate rejected the typo'd message. */
  typoRejected: boolean;
  /** The rogue client replaying a consumed ticket was refused. */
  rogueTicketRejected: boolean;
  /** Events-client state after `dispose()` — `closed`. */
  eventsClientState: string;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 5,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function admittedCount(server: MockCourierServer): number {
  return server.socketAttempts.filter((attempt) => attempt.admitted).length;
}

/* -------------------------------------------------------------------------- */
/* The demo                                                                    */
/* -------------------------------------------------------------------------- */

export async function runTicketDemo(
  options: TicketDemoOptions = {},
): Promise<TicketDemoResult> {
  const log: string[] = [];
  const say = (line: string): void => {
    log.push(line);
    options.onLog?.(line);
  };

  const server = new MockCourierServer({ statusDelayMs: 200, ...options.server });

  // The credential desk: a REST client with no auth of its own. Both the
  // token manager and the ticket mint go through it.
  const authApi = new CourierAuthApi({ transport: server.httpTransport });
  const { provider } = createSharedTicketAuth({
    issueToken: () => authApi.issueToken({ clientId: 'courier-demo', clientSecret: 's3cr3t' }),
    issueWebSocketTicket: (bearer) =>
      authApi.issueWebSocketTicket({ _headers: { Authorization: bearer } }),
  });

  // One facade, two transports, one shared AuthProvider. The REST factory
  // receives a bridging `auth` resolver (401 → handleUnauthorized → one
  // retry); the events client receives the provider itself (per-attempt
  // tickets, 4001-aware reconnection, proactive rotation).
  const platform = createPlatformClient({
    authProvider: provider,
    rest: ({ auth }) => new CourierApi({ auth, transport: server.httpTransport }),
    events: ({ authProvider: eventsAuth }) =>
      new CourierEvents({
        authProvider: eventsAuth,
        socketFactory: server.socketFactory,
        // Server-side subscription protocol: the registry is re-sent after
        // every (re)connect, so patterns survive drops.
        subscribeEnvelope: (topic) => ({ type: 'subscribe', topic }),
        unsubscribeEnvelope: (topic) => ({ type: 'unsubscribe', topic }),
        reconnectBaseDelayMs: 25,
        reconnectMaxAttempts: 8,
      }),
  });

  const created: ShipmentCreatedEvent[] = [];
  const statuses: ShipmentStatusEvent[] = [];
  const statusParams: string[] = [];
  const pongs: DriverPongEvent[] = [];

  say('── contracts ──');
  say(CourierApi.describe());
  say(CourierEvents.describe());

  // 1. Connect the events socket: token fetch → one-time ticket → connect.
  await platform.events.connect();
  const first = server.socketAttempts[0]!;
  say(`1. connected:        ${first.url} (ticket ${first.ticket}, single-use)`);
  if (!first.admitted) throw new Error('demo setup failed: first socket was not admitted');

  // 2. Subscribe to the declared channels.
  platform.events.onShipmentCreated((message) => created.push(message));
  platform.events.onShipmentStatus((message, ctx) => {
    statuses.push(message);
    statusParams.push(ctx.params.shipmentId); // fully typed topic params
  });
  const offPong = platform.events.onDriverPong((message) => pongs.push(message));
  await waitFor(() => server.subscribeTopicsSeen.length >= 3);
  say(`2. subscribed:       ${server.subscribeTopicsSeen.slice(0, 3).join(', ')}`);

  // 3. REST read through the shared bearer (no extra token fetch).
  const emptyPage = await platform.rest.listShipments();
  say(`3. GET /shipments:  200, ${emptyPage.count} shipment(s) (shared bearer, cached token)`);

  // 4. REST write → event over the socket.
  const shipment1 = await platform.rest.createShipment({
    destination: '221B Baker Street',
    weightGrams: 850,
  });
  await waitFor(() => created.length >= 1);
  say(`4. POST /shipments: 201 ${shipment1.shipmentId} → WS shipment.created for ${created[0]!.shipmentId}`);

  // 5. Parameterised status channel fires shortly after.
  await waitFor(() => statuses.length >= 1);
  const catchUpSince = platform.events.raw.getLastEventId() ?? 'evt_0';
  say(`5. status channel:  shipment/${statuses[0]!.shipmentId}/status → ${statuses[0]!.status}`);

  // 6. Publish → the server answers on another channel.
  await platform.events.pingDriver({ driverId: 'drv_7' });
  await waitFor(() => pongs.length === 1);
  offPong(); // refcount drops to zero → unsubscribe frame
  say(`6. driver.ping:     answered by driver.pong for ${pongs[0]!.driverId}`);

  // 7. Closed-world gate: a typo'd publish never reaches the wire.
  let typoRejected = false;
  try {
    await platform.events.pingDriver({ driverId: 'drv_7', weigth: 4 } as never);
  } catch (err) {
    typoRejected = err instanceof ContractViolationError;
  }
  say(`7. closed world:    typo'd publish rejected client-side (${typoRejected})`);

  // 8. Drop the socket: automatic reconnect on a FRESH ticket, and the
  //    subscription registry is re-sent (minus the unsubscribed pong).
  const topicsBeforeDrop = server.subscribeTopicsSeen.length;
  server.dropSockets();
  await waitFor(() => admittedCount(server) === 2);
  await waitFor(() => platform.events.state === 'open');
  const second = server.socketAttempts[1]!;
  const resubscribeCount = server.subscribeTopicsSeen.length - topicsBeforeDrop;
  say(`8. dropped:         reconnected on fresh ticket ${second.ticket}, ${resubscribeCount} subscription(s) re-sent`);
  const ticketRotatedOnReconnect = second.ticket !== first.ticket;

  // 9. Events still flow after the reconnect.
  const shipment2 = await platform.rest.createShipment({
    destination: '742 Evergreen Terrace',
    weightGrams: 310,
  });
  await waitFor(() => created.length >= 2);
  const eventsAfterReconnect = created.length - 1;
  say(`9. after reconnect: POST /shipments → ${created[1]!.shipmentId} still delivered (${shipment2.shipmentId})`);

  // 10. Expire the access tokens server-side. The next REST call takes a
  //     401, refreshes single-flight, retries once — and because the token
  //     change is broadcast, the healthy socket rotates onto the new
  //     credentials at the same time (one /auth/token call shared by both).
  const tokenCallsBefore = server.tokenCalls;
  server.expireAccessTokens();
  const refreshedPage = await platform.rest.listShipments();
  const recoveredFromRest401 = refreshedPage.count === 2;
  await waitFor(() => admittedCount(server) === 3);
  await waitFor(() => platform.events.state === 'open');
  const tokenCallsFor401Recovery = server.tokenCalls - tokenCallsBefore;
  say(
    `10. REST 401:        refreshed + retried (${refreshedPage.count} shipment(s) readable); ` +
      `socket rotated too; ${tokenCallsFor401Recovery} token call(s) shared`,
  );
  await waitFor(() => statuses.length >= 2); // shp_1 + shp_2 transitions seen

  // 11. The server kicks the socket with 4001 (token expired): the same
  //     shared recovery — clear, refresh, reconnect on a fresh ticket.
  server.kickSockets();
  await waitFor(() => admittedCount(server) === 4);
  await waitFor(() => platform.events.state === 'open');
  say(`11. WS kick 4001:    cleared + refreshed + reconnected (ticket ${server.socketAttempts[3]!.ticket})`);

  // 12. The platform is fully recovered — prove it end to end: a new write
  //     goes through REST and comes back over the events socket.
  const shipment3 = await platform.rest.createShipment({
    destination: '4 Privet Drive',
    weightGrams: 1_200,
  });
  await waitFor(() => created.length >= 3);
  await waitFor(() => statuses.length >= 3);
  say(`12. after recovery: POST /shipments → ${shipment3.shipmentId}, created + status both delivered`);

  // 13. Catch-up over REST: everything created since the event id captured
  //     at step 5 — the idiom for filling gaps after a disconnect.
  const catchUp = await platform.rest.listShipments({ since: catchUpSince });
  const lastEventId = platform.events.raw.getLastEventId();
  say(`13. catch-up:        GET /shipments?since=${catchUpSince} → ${catchUp.count} shipment(s); lastEventId=${lastEventId}`);

  // 14. Single-use proof: a rogue client replays the ticket from step 1.
  let rogueTicketRejected = false;
  const rogue = new EventsClient({
    url: 'wss://events.courier.test/ws',
    authProvider: staticAuthProvider({ query: { ticket: first.ticket! } }),
    socketFactory: server.socketFactory,
    reconnect: false,
  });
  try {
    await rogue.connect();
  } catch (err) {
    rogueTicketRejected = err instanceof WebSocketApiError;
  }
  say(`14. ticket replay:   refused with 4003 (${server.rejectedTickets.length} rejection(s))`);

  // 15. Tear everything down.
  await platform.dispose();
  server.dispose();
  const eventsClientState = platform.events.state;
  say(`15. disposed:        events client is '${eventsClientState}'`);

  return {
    log,
    server,
    socketAttempts: [...server.socketAttempts],
    socketUrls: server.socketAttempts.map((attempt) => attempt.url),
    admittedSocketCount: admittedCount(server),
    tokenCalls: server.tokenCalls,
    ticketCalls: server.ticketCalls,
    restCalls: server.restCallCount,
    unauthorizedRestCalls: [...server.unauthorizedRestCalls],
    rejectedTickets: [...server.rejectedTickets],
    shipments: [shipment1, shipment2, shipment3],
    createdEvents: created,
    statusEvents: statuses,
    statusParams,
    pongs,
    resubscribeCount,
    ticketRotatedOnReconnect,
    eventsAfterReconnect,
    recoveredFromRest401,
    tokenCallsFor401Recovery,
    reconnectedAfterDrop: admittedCount(server) >= 2,
    reconnectedAfterKick: admittedCount(server) >= 4,
    caughtUpShipments: catchUp.count,
    catchUpSince,
    lastEventId,
    typoRejected,
    rogueTicketRejected,
    eventsClientState,
  };
}

/* -------------------------------------------------------------------------- */
/* CLI entry (npx tsx examples/ticket-demo/main.ts after `npm run build`)      */
/* -------------------------------------------------------------------------- */

function invokedDirectly(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runTicketDemo({ onLog: (line) => console.log(line) })
    .then((result) => {
      console.log('');
      console.log(
        `✔ demo finished: ${result.admittedSocketCount} admitted socket(s), ` +
          `${result.tokenCalls} token call(s), ${result.ticketCalls} ticket call(s), ` +
          `${result.rejectedTickets.length} rejected ticket replay(s)`,
      );
    })
    .catch((err: unknown) => {
      console.error('demo failed:', err);
      process.exitCode = 1;
    });
}
