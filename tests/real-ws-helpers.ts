/**
 * A genuine `ws` WebSocketServer bound to 127.0.0.1:<ephemeral> — the
 * "independent implementation" side of the events-runtime integration tests.
 *
 * The client under test connects through the DEFAULT socket factory (global
 * `WebSocket` on Node 22+, lazily imported `ws` on Node 18), so these tests
 * exercise real sockets, real frames and real close codes end to end.
 */

import type { IncomingMessage } from 'node:http';
import * as net from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { waitFor } from './events-helpers.js';

export interface ServerConnection {
  /** 0-based connection ordinal (0 = first connection the server saw). */
  readonly index: number;
  /** The raw HTTP upgrade request (headers carry auth/protocols). */
  readonly upgrade: IncomingMessage;
  /** The server-side socket — terminate()/close() to kill the connection. */
  readonly socket: WebSocket;
  /** Raw text frames received from the client, in order. */
  readonly frames: string[];
  /** How the client closed (null while still open). */
  closedWith: { code: number; reason: string } | null;
  jsonFrames(): unknown[];
  lastJson(): Record<string, unknown>;
  sendJson(value: unknown): void;
}

export class RealWsServer {
  readonly #wss: WebSocketServer;
  readonly #connections: ServerConnection[] = [];
  readonly #handlers: Array<(conn: ServerConnection) => void> = [];

  private constructor(wss: WebSocketServer) {
    this.#wss = wss;
  }

  static async start(onConnection?: (conn: ServerConnection) => void): Promise<RealWsServer> {
    const server = await new Promise<RealWsServer>((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
        resolve(new RealWsServer(wss));
      });
      wss.on('error', reject);
    });
    if (onConnection) server.#handlers.push(onConnection);
    server.#wss.on('connection', (socket, request) => server.#register(socket, request));
    return server;
  }

  get url(): string {
    const address = this.#wss.address();
    if (typeof address === 'string') throw new Error('unexpected unix-socket server');
    return `ws://127.0.0.1:${address.port}`;
  }

  get connections(): readonly ServerConnection[] {
    return this.#connections;
  }

  onConnection(handler: (conn: ServerConnection) => void): void {
    this.#handlers.push(handler);
  }

  #register(socket: WebSocket, request: IncomingMessage): void {
    const conn: ServerConnection = {
      index: this.#connections.length,
      upgrade: request,
      socket,
      frames: [],
      closedWith: null,
      jsonFrames(): unknown[] {
        return this.frames.map((frame) => JSON.parse(frame) as unknown);
      },
      lastJson(): Record<string, unknown> {
        return JSON.parse(this.frames[this.frames.length - 1] ?? '{}') as Record<string, unknown>;
      },
      sendJson(value: unknown): void {
        socket.send(typeof value === 'string' ? value : JSON.stringify(value));
      },
    };
    this.#connections.push(conn);
    socket.on('message', (data: RawData) => {
      conn.frames.push(data.toString());
    });
    socket.on('close', (code: number, reason: Buffer) => {
      conn.closedWith = { code, reason: reason.toString() };
    });
    for (const handler of this.#handlers) handler(conn);
  }

  async dispose(): Promise<void> {
    for (const conn of this.#connections) {
      try {
        conn.socket.terminate();
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.#wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

/**
 * A TCP server that accepts connections but never completes the WebSocket
 * upgrade — the real-world "server is up, handshake hangs" failure mode.
 */
export async function startNeverUpgradingServer(): Promise<{
  url: string;
  dispose(): Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    // Accept and hold the socket open forever.
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address === 'string') throw new Error('unexpected unix-socket server');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    dispose: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Replaces `globalThis.WebSocket` for the duration of `run`, restoring after. */
export async function withGlobalWebSocket<T>(
  replacement: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', {
    value: replacement,
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'WebSocket', descriptor);
    } else {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
    }
  }
}

/** Waits until the server has seen `count` connections. */
export async function waitForConnections(
  server: RealWsServer,
  count: number,
  timeoutMs = 3_000,
): Promise<void> {
  await waitFor(() => server.connections.length >= count, timeoutMs, 5);
}

/**
 * True when the running Node provides a global `WebSocket` (22+). On Node 18
 * the default factory takes the lazily-imported `ws` path instead — the CI
 * matrix covers both.
 */
export const NODE_HAS_GLOBAL_WEBSOCKET = typeof globalThis.WebSocket === 'function';
