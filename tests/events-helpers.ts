/**
 * Deterministic in-memory socket for events-runtime tests — no network,
 * no real timers beyond the tiny reconnect delays the tests configure.
 */

import type { SocketFactory, SocketLike } from '../src/events/types.js';

export class FakeSocket implements SocketLike {
  private static instances: FakeSocket[] = [];

  readonly url: string;
  readonly protocols: string[];
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readyState = 0; // 0 connecting, 1 open, 3 closed

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer | Blob): void {
    if (this.readyState !== 1) throw new Error('FakeSocket: send while not open');
    this.sent.push(typeof data === 'string' ? data : String(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  /* ---- test-side "server" simulation ---- */

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  serverClose(code = 1006, reason = 'server closed'): void {
    this.readyState = 3;
    this.closed = { code, reason };
    this.onclose?.({ code, reason });
  }

  serverError(error: unknown): void {
    this.onerror?.(error);
  }

  sentJson(): unknown[] {
    return this.sent.map((frame) => JSON.parse(frame) as unknown);
  }

  lastSentJson(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1] ?? '{}') as Record<string, unknown>;
  }

  /* ---- factory helpers ---- */

  static reset(): void {
    FakeSocket.instances = [];
  }

  static all(): FakeSocket[] {
    return [...FakeSocket.instances];
  }

  static last(): FakeSocket {
    const last = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!last) throw new Error('no FakeSocket was created');
    return last;
  }

  static first(): FakeSocket {
    const first = FakeSocket.instances[0];
    if (!first) throw new Error('no FakeSocket was created');
    return first;
  }
}

/** Factory that hands out FakeSockets, optionally scripting each one. */
export function fakeSocketFactory(
  onCreated?: (socket: FakeSocket, index: number) => void,
): SocketFactory {
  let index = 0;
  return (url, protocols) => {
    const socket = new FakeSocket(url, protocols);
    onCreated?.(socket, index++);
    return socket;
  };
}

/** Waits for a condition, failing after `timeoutMs`. */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 2_000,
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
