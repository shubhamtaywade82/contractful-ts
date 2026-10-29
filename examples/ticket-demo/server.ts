/**
 * MockCourierServer — an in-process double of the fictional "Courier"
 * delivery platform, used by the end-to-end shared-ticket demo.
 *
 * It plays both halves of the conversation with zero network:
 *
 * - `httpTransport` implements the library's `Transport` interface and
 *   serves the REST surface: client-credential tokens, one-time WebSocket
 *   tickets, and shipment reads/writes (Bearer-protected).
 * - `socketFactory` implements `SocketFactory` and plays the WebSocket
 *   server: every connection attempt must present a live, unconsumed
 *   ticket in the URL query; anything else is closed with `4003`.
 *
 * The server is deliberately strict — it is the *authority* on tickets:
 *
 * - access tokens expire only when `expireAccessTokens()` says so,
 * - a ticket is single-use (consumed at admission),
 * - events are only delivered to sockets that subscribed to a matching
 *   topic pattern (`shipment/:shipmentId/status` style params included),
 * - every close/kick/drop is observable so the demo (and its test) can
 *   assert on what actually happened rather than on console output.
 */

import type {
  SocketFactory,
  SocketLike,
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../dist/index.js';

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export interface SessionTokenBody {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  scopes: string[];
  [field: string]: unknown;
}

export interface WsTicketBody {
  ticket: string;
  expiresAt: number;
  [field: string]: unknown;
}

export interface ShipmentRecord {
  shipmentId: string;
  destination: string;
  weightGrams: number;
  status: 'created' | 'picked_up' | 'in_transit';
  createdAt: number;
  /** Sequence number of the `shipment.created` event for this record. */
  eventSeq: number;
}

export interface SocketAttempt {
  url: string;
  ticket: string | null;
  admitted: boolean;
}

export interface ServerFrame {
  socket: MockServerSocket;
  frame: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* The server                                                                  */
/* -------------------------------------------------------------------------- */

export interface MockCourierServerOptions {
  /** Access-token lifetime. Default 5 minutes. */
  tokenTtlMs?: number;
  /** One-time ticket lifetime. Default 60 seconds. */
  ticketTtlMs?: number;
  /** Delay before a created shipment becomes `picked_up`. Default 120ms. */
  statusDelayMs?: number;
}

export class MockCourierServer {
  readonly httpTransport: Transport;
  readonly socketFactory: SocketFactory;

  /* ---- observables (the demo asserts against these) ---- */
  readonly restRequests: TransportRequest[] = [];
  readonly socketAttempts: SocketAttempt[] = [];
  readonly frames: ServerFrame[] = [];
  readonly pushedEvents: { topic: string; eventId: string; payload: unknown }[] = [];
  readonly rejectedTickets: string[] = [];
  tokenCalls = 0;
  ticketCalls = 0;
  restCallCount = 0;
  readonly unauthorizedRestCalls: number[] = [];

  #tokenSeq = 0;
  #ticketSeq = 0;
  #shipmentSeq = 0;
  #eventSeq = 0;
  readonly #liveTickets = new Map<string, { expiresAt: number }>();
  readonly #validAccessTokens = new Set<string>();
  readonly #shipments = new Map<string, ShipmentRecord>();
  readonly #sockets: MockServerSocket[] = [];
  readonly #timers: ReturnType<typeof setTimeout>[] = [];
  readonly #options: Required<MockCourierServerOptions>;

  constructor(options: MockCourierServerOptions = {}) {
    this.#options = {
      tokenTtlMs: options.tokenTtlMs ?? 300_000,
      ticketTtlMs: options.ticketTtlMs ?? 60_000,
      statusDelayMs: options.statusDelayMs ?? 120,
    };

    this.httpTransport = { send: (req) => this.#handleHttp(req) };
    this.socketFactory = (url, protocols) => {
      const socket = new MockServerSocket(
        {
          noteFrame: (s, frame) => this.#noteFrame(s, frame),
          handleClientPublish: (frame) => this.#handleClientPublish(frame),
        },
        url,
        protocols,
      );
      this.#sockets.push(socket);
      // Admission decision runs after the runtime has wired its handlers
      // (a macrotask), so a rejection close is never missed.
      this.#trackTimer(setTimeout(() => this.#admit(socket), 0));
      return socket;
    };
  }

  /* ---- server-side controls used by the demo script ---- */

  /** Invalidates every issued access token — the next REST call gets 401. */
  expireAccessTokens(): void {
    this.#validAccessTokens.clear();
  }

  /** Abruptly drops every admitted socket (e.g. a deploy / network blip). */
  dropSockets(): void {
    for (const socket of [...this.#sockets]) socket.serverClose(1006, 'connection dropped');
  }

  /** Closes every admitted socket with 4001 (token expired). */
  kickSockets(): void {
    for (const socket of [...this.#sockets]) socket.serverClose(4001, 'token expired');
  }

  get admittedSockets(): MockServerSocket[] {
    return this.#sockets.filter((s) => s.admitted && s.readyState === 1);
  }

  /** All subscribe topics seen across every socket, in order. */
  get subscribeTopicsSeen(): string[] {
    return this.frames
      .filter((entry) => entry.frame['type'] === 'subscribe')
      .map((entry) => String(entry.frame['topic']));
  }

  /** Shuts timers and remaining sockets down. */
  dispose(): void {
    for (const timer of this.#timers.splice(0)) clearTimeout(timer);
    for (const socket of [...this.#sockets]) socket.serverClose(1001, 'server disposed');
  }

  /* ---- internals: HTTP half ---- */

  #trackTimer(timer: ReturnType<typeof setTimeout>): void {
    this.#timers.push(timer);
  }

  async #handleHttp(req: TransportRequest): Promise<TransportResponse> {
    this.restRequests.push(req);
    this.restCallCount++;
    const path = new URL(req.url).pathname;
    const method = req.method;

    if (method === 'POST' && path === '/v1/auth/token') return this.#issueToken(req);
    if (method === 'POST' && path === '/v1/auth/ws-ticket') return this.#issueTicket(req);

    const shipmentMatch = /^\/v1\/shipments\/([^/]+)$/.exec(path);
    if (method === 'GET' && path === '/v1/shipments') return this.#listShipments(req);
    if (method === 'POST' && path === '/v1/shipments') return this.#createShipment(req);
    if (method === 'GET' && shipmentMatch) return this.#showShipment(shipmentMatch[1]!);

    return json(404, { error: 'no such route', path });
  }

  #issueToken(req: TransportRequest): TransportResponse {
    this.tokenCalls++;
    const body = req.body as Record<string, unknown>;
    if (body['client_id'] !== 'courier-demo' || body['client_secret'] !== 's3cr3t') {
      return json(401, { error: 'invalid client credentials' });
    }
    const accessToken = `tok_${++this.#tokenSeq}`;
    this.#validAccessTokens.add(accessToken);
    const session: SessionTokenBody = {
      accessToken,
      tokenType: 'Bearer',
      expiresAt: Date.now() + this.#options.tokenTtlMs,
      scopes: ['shipments'],
    };
    return json(200, session);
  }

  #issueTicket(req: TransportRequest): TransportResponse {
    const token = bearerOf(req);
    if (!token || !this.#validAccessTokens.has(token)) {
      return json(401, { error: 'invalid or expired token' }, { 'WWW-Authenticate': 'Bearer' });
    }
    this.ticketCalls++;
    const ticket = `wst_${++this.#ticketSeq}`;
    this.#liveTickets.set(ticket, { expiresAt: Date.now() + this.#options.ticketTtlMs });
    const body: WsTicketBody = { ticket, expiresAt: Date.now() + this.#options.ticketTtlMs };
    return json(201, body);
  }

  #listShipments(req: TransportRequest): TransportResponse {
    const denied = this.#requireAuth(req);
    if (denied) return denied;
    const since = req.query.get('since');
    const sinceSeq = since ? parseEventSeq(since) : 0;
    const shipments = [...this.#shipments.values()]
      .filter((s) => s.eventSeq > sinceSeq)
      .sort((a, b) => a.eventSeq - b.eventSeq);
    return json(200, { shipments, count: shipments.length });
  }

  #createShipment(req: TransportRequest): TransportResponse {
    const denied = this.#requireAuth(req);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const destination = String(body['destination'] ?? '');
    const weightGrams = Number(body['weight_grams'] ?? 0);
    if (destination.length < 3 || !Number.isInteger(weightGrams) || weightGrams < 1) {
      return json(422, { error: 'destination and weight_grams are required' });
    }
    const shipment: ShipmentRecord = {
      shipmentId: `shp_${++this.#shipmentSeq}`,
      destination,
      weightGrams,
      status: 'created',
      createdAt: Date.now(),
      eventSeq: 0,
    };
    this.#shipments.set(shipment.shipmentId, shipment);

    // The write side effect fans out over the events socket...
    const createdEventId = this.broadcast('shipment.created', {
      shipmentId: shipment.shipmentId,
      destination: shipment.destination,
    });
    shipment.eventSeq = parseEventSeq(createdEventId);
    // ...and a status transition follows shortly after.
    this.#trackTimer(
      setTimeout(() => {
        shipment.status = 'picked_up';
        this.broadcast(`shipment/${shipment.shipmentId}/status`, {
          shipmentId: shipment.shipmentId,
          status: 'picked_up',
          updatedAt: new Date().toISOString(),
        });
      }, this.#options.statusDelayMs),
    );
    return json(201, { ...shipment });
  }

  #showShipment(shipmentId: string): TransportResponse {
    const shipment = this.#shipments.get(shipmentId);
    if (!shipment) return json(404, { error: 'no such shipment' });
    return json(200, { ...shipment });
  }

  #requireAuth(req: TransportRequest): TransportResponse | null {
    const token = bearerOf(req);
    if (!token || !this.#validAccessTokens.has(token)) {
      this.unauthorizedRestCalls.push(this.restCallCount);
      return json(401, { error: 'missing, invalid or expired token' }, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    return null;
  }

  /* ---- internals: WebSocket half ---- */

  #admit(socket: MockServerSocket): void {
    const url = new URL(socket.url);
    const ticket = url.searchParams.get('ticket');
    const entry = ticket ? this.#liveTickets.get(ticket) : undefined;
    const ok = !!entry && entry.expiresAt > Date.now();
    this.socketAttempts.push({ url: socket.url, ticket, admitted: ok });
    if (!ok) {
      if (ticket) this.rejectedTickets.push(ticket);
      socket.serverClose(4003, 'invalid, expired or already-used ticket');
      return;
    }
    this.#liveTickets.delete(ticket!); // single-use: consumed at admission
    socket.admitted = true;
    socket.serverOpen();
  }

  /** Pushes an event to every admitted socket subscribed to a matching pattern.
   *
   *  @returns the event id stamped on the frame (e.g. `evt_7`).
   */
  broadcast(topic: string, payload: Record<string, unknown>): string {
    const eventId = `evt_${++this.#eventSeq}`;
    this.pushedEvents.push({ topic, eventId, payload });
    const frame = JSON.stringify({ topic, payload, eventId });
    for (const socket of this.admittedSockets) {
      if (socket.matchesTopic(topic)) socket.serverMessage(frame);
    }
    return eventId;
  }

  /** Handles a publish frame coming from a connected client. */
  #handleClientPublish(frame: Record<string, unknown>): void {
    const topic = String(frame['topic'] ?? '');
    const payload = (frame['payload'] ?? {}) as Record<string, unknown>;
    if (topic === 'driver.ping') {
      this.broadcast('driver.pong', {
        driverId: String(payload['driverId'] ?? ''),
        at: new Date().toISOString(),
      });
    }
  }

  #noteFrame(socket: MockServerSocket, frame: Record<string, unknown>): void {
    this.frames.push({ socket, frame });
  }
}

/* -------------------------------------------------------------------------- */
/* Server-side socket                                                          */
/* -------------------------------------------------------------------------- */

/** What the socket needs from its server (kept structural for testability). */
export interface ServerSocketHooks {
  noteFrame(socket: MockServerSocket, frame: Record<string, unknown>): void;
  handleClientPublish(frame: Record<string, unknown>): void;
}

/** The server end of one connection attempt. */
export class MockServerSocket implements SocketLike {
  readonly url: string;
  readonly protocols: string[];
  readonly subscribedPatterns = new Set<string>();
  admitted = false;
  readyState = 0; // 0 connecting, 1 open, 3 closed
  closeInfo: { code?: number; reason?: string } | null = null;

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly #hooks: ServerSocketHooks;

  constructor(hooks: ServerSocketHooks, url: string, protocols: string[]) {
    this.#hooks = hooks;
    this.url = url;
    this.protocols = protocols;
  }

  /** Client → server frames: subscribe/unsubscribe control + publishes. */
  send(data: string | ArrayBuffer | Blob): void {
    if (this.readyState !== 1) throw new Error('MockServerSocket: send while not open');
    const frame = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>;
    this.#hooks.noteFrame(this, frame);
    if (frame['type'] === 'subscribe' && typeof frame['topic'] === 'string') {
      this.subscribedPatterns.add(frame['topic']);
    } else if (frame['type'] === 'unsubscribe' && typeof frame['topic'] === 'string') {
      this.subscribedPatterns.delete(frame['topic']);
    } else if (typeof frame['topic'] === 'string') {
      this.#hooks.handleClientPublish(frame);
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeInfo = { code, reason };
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  /* ---- server-side simulation ---- */

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverMessage(data: unknown): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  serverClose(code = 1006, reason = 'server closed'): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeInfo = { code, reason };
    this.onclose?.({ code, reason });
  }

  /** Server-side pattern matching, mirroring the client's `matchTopic`. */
  matchesTopic(topic: string): boolean {
    for (const pattern of this.subscribedPatterns) {
      if (patternMatches(pattern, topic)) return true;
    }
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): TransportResponse {
  return { status, headers, body };
}

function bearerOf(req: TransportRequest): string | null {
  const header = req.headers['Authorization'] ?? req.headers['authorization'];
  if (typeof header !== 'string') return null;
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

function parseEventSeq(eventId: string): number {
  const match = /^evt_(\d+)$/.exec(eventId);
  return match ? Number(match[1]) : 0;
}

/** `shipment/:shipmentId/status` matches `shipment/shp_1/status`. */
export function patternMatches(pattern: string, topic: string): boolean {
  if (pattern === '*') return true;
  const patternSegments = pattern.split('/');
  const topicSegments = topic.split('/');
  if (patternSegments.length !== topicSegments.length) return false;
  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i]!;
    if (p.startsWith(':') || p === '*') continue;
    if (p !== topicSegments[i]) return false;
  }
  return true;
}
