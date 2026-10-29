/**
 * End-to-end coverage for `examples/ticket-demo` — the REST + WebSocket
 * shared-ticket demo.
 *
 * One test runs the whole fifteen-step scenario against the in-process
 * mock server and asserts on the observable effects (socket admissions,
 * token/ticket call counts, delivered events, recovery booleans). A second
 * test strict-`tsc`-checks the example directory against the built
 * package, so the demo can never drift from the shipped types.
 */

import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EventsClient, WebSocketApiError, staticAuthProvider } from '../src/index.js';
import { runTicketDemo } from '../examples/ticket-demo/main.js';
import { MockCourierServer } from '../examples/ticket-demo/server.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function tscCheckExample(): void {
  execFileSync('npx', ['tsc', '-p', join('examples', 'ticket-demo', 'tsconfig.check.json')], {
    cwd: ROOT,
    stdio: 'pipe',
  });
}

describe('examples/ticket-demo — REST + WS shared ticket authentication', () => {
  it('type-checks under strict tsc against the built package', () => {
    expect(() => tscCheckExample()).not.toThrow();
  });

  it('walks the full shared-ticket lifecycle end to end', async () => {
    const result = await runTicketDemo();

    /* ---- connection & ticket discipline ---- */
    expect(result.socketUrls[0]).toBe('wss://events.courier.test/ws?ticket=wst_1');
    // Four admitted sockets (initial, drop-reconnect, 401 rotation, kick
    // recovery), each on its own fresh single-use ticket — plus the rogue
    // replay attempt, which is refused.
    expect(result.socketAttempts).toHaveLength(5);
    expect(result.socketAttempts.map((a) => a.admitted)).toEqual([true, true, true, true, false]);
    const admittedTickets = result.socketAttempts
      .filter((a) => a.admitted)
      .map((a) => a.ticket);
    expect(admittedTickets).toEqual(['wst_1', 'wst_2', 'wst_3', 'wst_4']);
    expect(result.ticketRotatedOnReconnect).toBe(true);
    expect(result.admittedSocketCount).toBe(4);

    /* ---- credential-desk economy ---- */
    // Exactly three token fetches: initial connect, the shared 401
    // recovery (REST retry + socket rotation through one single-flight
    // refresh) and the 4001 kick recovery.
    expect(result.tokenCalls).toBe(3);
    expect(result.tokenCallsFor401Recovery).toBe(1);
    // One ticket mint per admitted socket.
    expect(result.ticketCalls).toBe(4);
    // The full REST conversation: 14 requests, one of which answered 401
    // (the GET that triggered the shared refresh in step 10).
    expect(result.restCalls).toBe(14);
    expect(result.unauthorizedRestCalls).toEqual([7]);

    /* ---- business flow ---- */
    expect(result.shipments.map((s) => s.shipmentId)).toEqual(['shp_1', 'shp_2', 'shp_3']);
    expect(result.createdEvents.map((e) => e.shipmentId)).toEqual(['shp_1', 'shp_2', 'shp_3']);
    expect(result.createdEvents[0]!.destination).toBe('221B Baker Street');
    // Parameterised status channel: typed topic params, all transitions.
    expect(result.statusEvents).toHaveLength(3);
    expect(result.statusParams).toEqual(['shp_1', 'shp_2', 'shp_3']);
    expect(result.statusEvents.every((e) => e.status === 'picked_up')).toBe(true);
    expect(result.pongs.map((p) => p.driverId)).toEqual(['drv_7']);

    /* ---- resilience ---- */
    expect(result.typoRejected).toBe(true); // closed-world publish gate
    expect(result.resubscribeCount).toBe(2); // registry survives, minus the unsubscribed pong
    expect(result.eventsAfterReconnect).toBe(1);
    expect(result.reconnectedAfterDrop).toBe(true);
    expect(result.recoveredFromRest401).toBe(true);
    expect(result.reconnectedAfterKick).toBe(true);

    /* ---- catch-up & teardown ---- */
    expect(result.catchUpSince).toBe('evt_2');
    expect(result.caughtUpShipments).toBe(2); // shp_2 + shp_3 created since evt_2
    expect(result.lastEventId).toBe('evt_7');
    expect(result.rogueTicketRejected).toBe(true);
    expect(result.rejectedTickets).toEqual(['wst_1']);
    expect(result.eventsClientState).toBe('closed');

    /* ---- wire discipline on the business calls ---- */
    const posts = result.server.restRequests.filter(
      (r) => r.method === 'POST' && r.url.endsWith('/shipments'),
    );
    expect(posts).toHaveLength(3); // create1, create2, create3-after-recovery
    for (const req of posts) {
      expect(String(req.headers['Authorization'])).toMatch(/^Bearer tok_\d+$/);
      expect(String(req.headers['Idempotency-Key'])).toMatch(/^[-0-9a-f]{36}$/);
    }
    // One idempotency key per logical create.
    expect(new Set(posts.map((r) => r.headers['Idempotency-Key'])).size).toBe(3);

    expect(result.log.length).toBeGreaterThan(14);
  });

  it('refuses a connection that presents no ticket at all', async () => {
    const server = new MockCourierServer();
    const client = new EventsClient({
      url: 'wss://events.courier.test/ws',
      authProvider: staticAuthProvider({}), // no material → no query appended
      socketFactory: server.socketFactory,
      reconnect: false,
    });

    await expect(client.connect()).rejects.toBeInstanceOf(WebSocketApiError);
    expect(server.socketAttempts).toHaveLength(1);
    expect(server.socketAttempts[0]!.admitted).toBe(false);
    expect(server.socketAttempts[0]!.ticket).toBeNull();
    expect(server.rejectedTickets).toHaveLength(0); // nothing to record

    server.dispose();
  });
});
