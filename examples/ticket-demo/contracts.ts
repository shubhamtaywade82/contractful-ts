/**
 * The Courier platform's contracts — pure data, no behavior.
 *
 * Three declarations describe the whole demo platform:
 *
 * - `CourierAuthApi` — the credential desk: one unauthenticated REST client
 *   for issuing session tokens and minting one-time WebSocket tickets.
 * - `CourierApi` — the business REST surface (Bearer-protected).
 * - `CourierEvents` — the WebSocket channels: two inbound notification
 *   channels, one parameterised status channel and one outbound publish
 *   channel, all routed over a single connection.
 *
 * The demo wires one shared `AuthProvider` across `CourierApi` and
 * `CourierEvents`, so both transports draw on the same token authority —
 * see `auth.ts` and `main.ts`.
 */

import { contract, defineApi, defineEvents, P, publish, subscribe } from '../../dist/index.js';
import type { ParamSpec } from '../../dist/index.js';
import type { ShipmentRecord, SessionTokenBody, WsTicketBody } from './server.js';

/* -------------------------------------------------------------------------- */
/* Message types (open world: extra server fields pass through)                */
/* -------------------------------------------------------------------------- */

export interface ShipmentCreatedEvent {
  shipmentId: string;
  destination: string;
  [field: string]: unknown;
}

export interface ShipmentStatusEvent {
  shipmentId: string;
  status: 'picked_up' | 'in_transit' | 'delivered';
  updatedAt: string;
  [field: string]: unknown;
}

export interface DriverPongEvent {
  driverId: string;
  at: string;
  [field: string]: unknown;
}

export interface DriverPingMessage {
  driverId: string;
}

export interface ShipmentPage {
  shipments: ShipmentRecord[];
  count: number;
  [field: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* REST: the credential desk                                                   */
/* -------------------------------------------------------------------------- */

export const CourierAuthApi = defineApi({
  name: 'CourierAuthApi',
  base: 'https://api.courier.test/v1',
  contracts: {
    /** POST /auth/token — client-credentials exchange (no auth needed). */
    issueToken: contract<SessionTokenBody>('POST /auth/token', {
      description: 'Exchange client credentials for a session access token.',
      params: {
        clientId: P.string({ required: true, as: 'client_id', describe: 'OAuth client id.' }),
        clientSecret: P.string({
          required: true,
          as: 'client_secret',
          describe: 'OAuth client secret.',
        }),
      },
      responds: [{ status: 200, type: 'hash' }],
    }),
    /**
     * POST /auth/ws-ticket — mint a single-use ticket for the events
     * WebSocket. Called with the current bearer token via `_headers`.
     */
    issueWebSocketTicket: contract<WsTicketBody>('POST /auth/ws-ticket', {
      description: 'Mint a single-use ticket for the events WebSocket.',
      responds: [{ status: 201, type: 'hash' }],
    }),
  },
});

/* -------------------------------------------------------------------------- */
/* REST: the business surface                                                  */
/* -------------------------------------------------------------------------- */

export const CourierApi = defineApi({
  name: 'CourierApi',
  base: 'https://api.courier.test/v1',
  contracts: {
    /** GET /shipments — paginated list with an event-id catch-up cursor. */
    listShipments: contract<ShipmentPage>('GET /shipments', {
      description: 'List shipments created after an event id (catch-up cursor).',
      security: ['shipments'],
      params: {
        since: P.string({
          describe: 'Last event id seen (from EventsClient.getLastEventId()).',
        }),
      },
      responds: [{ status: 200, type: 'hash' }],
    }),
    /** POST /shipments — create a shipment; the server fans an event out. */
    createShipment: contract<ShipmentRecord>('POST /shipments', {
      description: 'Create a shipment (idempotent; broadcasts shipment.created).',
      security: ['shipments'],
      idempotent: true,
      params: {
        destination: P.string({
          required: true,
          length: { min: 3 },
          describe: 'Delivery address.',
        }),
        weightGrams: P.integer({
          required: true,
          as: 'weight_grams',
          min: 1,
          max: 20_000,
          describe: 'Package weight in grams (1..20000).',
        }),
      },
      responds: [{ status: 201, type: 'hash' }, { status: 422 }],
    }),
    /** GET /shipments/:shipmentId — fetch one shipment. */
    showShipment: contract<ShipmentRecord>('GET /shipments/:shipmentId', {
      description: 'Fetch a single shipment.',
      security: ['shipments'],
      params: { shipmentId: P.string({ required: true }) },
      responds: [{ status: 200, type: 'hash' }, { status: 404 }],
    }),
  },
});

/* -------------------------------------------------------------------------- */
/* WebSocket: the events channels                                              */
/* -------------------------------------------------------------------------- */

export const CourierEvents = defineEvents({
  name: 'CourierEvents',
  url: 'wss://events.courier.test/ws',
  channels: {
    /** shipment.created — every new shipment, matched exactly. */
    onShipmentCreated: subscribe<ShipmentCreatedEvent>('shipment.created', {
      description: 'Fires for every shipment created over REST.',
      fields: {
        shipmentId: P.string({ required: true }),
        destination: P.string(),
      },
    }),
    /** shipment/:shipmentId/status — parameterised per-shipment channel. */
    onShipmentStatus: subscribe<ShipmentStatusEvent, { shipmentId: ParamSpec<string, true> }>(
      'shipment/:shipmentId/status',
      {
        description: 'Status transitions for a single shipment.',
        params: { shipmentId: P.string({ required: true }) },
        fields: {
          shipmentId: P.string({ required: true }),
          status: P.string({
            required: true,
            inclusion: ['picked_up', 'in_transit', 'delivered'],
          }),
          updatedAt: P.string(),
        },
      },
    ),
    /** driver.pong — the server answering our ping. */
    onDriverPong: subscribe<DriverPongEvent>('driver.pong', {
      description: 'Acknowledgement for a driver ping.',
      fields: { driverId: P.string({ required: true }), at: P.string() },
    }),
    /** driver.ping — outbound publish, validated closed-world. */
    pingDriver: publish<DriverPingMessage>('driver.ping', {
      description: 'Ping a driver (closed-world: unknown fields are rejected).',
      fields: {
        driverId: P.string({ required: true, pattern: /^drv_[a-z0-9]+$/ }),
      },
    }),
  },
});
