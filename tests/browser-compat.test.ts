/**
 * Browser-compatibility proof: the events runtime driven through a class
 * that exposes ONLY the browser-standard `WebSocket` surface — constructed
 * as `new WebSocket(url, protocols)`, property handlers
 * (`onopen`/`onmessage`/`onclose`/`onerror`), `send(string)` and
 * `close(code, reason)` — backed by a real `ws` connection.
 *
 * If the runtime ever reached for a `ws`-only API (`.terminate()`,
 * `.on('pong')`, upgrade options, …) these tests would fail with a
 * TypeError, which is exactly the guarantee browsers need.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { EventsClient } from '../src/events/client.js';
import { waitFor } from './events-helpers.js';
import { RealWsServer, waitForConnections, withGlobalWebSocket } from './real-ws-helpers.js';

let server: RealWsServer;

beforeEach(async () => {
  server = await RealWsServer.start();
});

afterEach(async () => {
  await server.dispose();
});

/**
 * A browser-shaped WebSocket: no `ws`-specific members, throws if the
 * runtime relies on a third constructor argument (upgrade options are not
 * a browser capability). Emits browser-shaped events: `MessageEvent`
 * `{ data }` and `CloseEvent` `{ code, reason, wasClean }`.
 */
class BrowserLikeWebSocket {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;

  static instances = 0;

  readonly url: string;
  readonly protocols: string[];
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';

  onopen: ((event: { type: 'open' }) => void) | null = null;
  onmessage: ((event: { type: 'message'; data: unknown }) => void) | null = null;
  onclose: ((event: { type: 'close'; code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: { type: 'error' }) => void) | null = null;

  readonly #inner: WsClient;

  constructor(...args: unknown[]) {
    const defined = args.filter((arg) => arg !== undefined);
    if (defined.length > 2) {
      throw new TypeError('browser WebSocket was constructed with extra arguments (ws-only options)');
    }
    const [url, protocols] = defined as [string, string[] | undefined];
    this.url = url;
    this.protocols = protocols ?? [];
    BrowserLikeWebSocket.instances++;
    this.#inner = new WsClient(url, protocols);
    this.#inner.on('open', () => {
      this.readyState = 1;
      this.onopen?.({ type: 'open' });
    });
    this.#inner.on('message', (data) => {
      this.onmessage?.({ type: 'message', data: data.toString() });
    });
    this.#inner.on('close', (code, reason) => {
      this.readyState = 3;
      this.onclose?.({
        type: 'close',
        code,
        reason: reason.toString(),
        wasClean: code === 1000,
      });
    });
    this.#inner.on('error', () => {
      this.onerror?.({ type: 'error' });
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('InvalidStateError: WebSocket is not open');
    }
    this.#inner.send(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 2;
    this.#inner.close(code, reason);
  }
}

describe('browser-shaped WebSocket surface', () => {
  it('connects, publishes and receives through the browser-standard API only', async () => {
    server.onConnection((conn) => {
      conn.socket.on('message', () => {
        const last = conn.lastJson();
        if (last.topic === 'hello') {
          conn.sendJson({ topic: 'hello.back', payload: { seen: true } });
        }
      });
    });

    await withGlobalWebSocket(BrowserLikeWebSocket, async () => {
      const before = BrowserLikeWebSocket.instances;
      const received: unknown[] = [];
      const client = new EventsClient({ url: server.url });
      client.subscribe('hello.back', (message) => received.push(message));
      await client.connect();
      await client.publish('hello', {});

      await waitFor(() => received.length > 0);
      expect(received[0]).toEqual({ seen: true });
      expect(BrowserLikeWebSocket.instances).toBe(before + 1); // the stub was actually used

      await client.disconnect();
      await waitFor(() => server.connections[0]!.closedWith?.code === 1000);
    });
  });

  it('survives an abnormal server drop and reconnects through the browser-shaped close event', async () => {
    server.onConnection((conn) => {
      if (conn.index === 1) {
        conn.sendJson({ topic: 'resumed', payload: { n: 2 } });
      }
    });

    await withGlobalWebSocket(BrowserLikeWebSocket, async () => {
      const received: unknown[] = [];
      const client = new EventsClient({ url: server.url, reconnectBaseDelayMs: 15 });
      client.subscribe('resumed', (message) => received.push(message));
      await client.connect();

      server.connections[0]!.socket.terminate(); // client sees close { code: 1006 }
      await waitForConnections(server, 2);
      await waitFor(() => received.length > 0);

      expect(received[0]).toEqual({ n: 2 });
      expect(client.state).toBe('open');
      await client.disconnect();
    });
  });
});
