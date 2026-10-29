/**
 * Socket plumbing: the default factory and the shared reconnecting state
 * machine both {@link EventsClient} and the GraphQL-ws client are built on.
 *
 * The default factory prefers a global `WebSocket` (browsers, Node 22+,
 * Deno, Bun) and lazily `import('ws')` otherwise — `ws` stays an optional
 * peer dependency, never a hard one.
 */

import { EventsConnectionError, EventsError, WebSocketApiError } from '../errors.js';
import type { EventsConnectionState, SocketFactory, SocketLike } from './types.js';

/* -------------------------------------------------------------------------- */
/* Default socket factory                                                      */
/* -------------------------------------------------------------------------- */

/** A WebSocket-constructor lookalike (browser, `ws`, undici). */
type WebSocketCtor = new (
  url: string,
  protocols?: string[] | string,
  options?: unknown,
) => SocketLike;

let wsModulePromise: Promise<WebSocketCtor | null> | null = null;

async function loadNodeWs(): Promise<WebSocketCtor | null> {
  // Only attempted in Node-like runtimes; the non-literal specifier keeps
  // bundlers and the type-checker from eagerly resolving the optional peer
  // dependency (`ws`).
  if (typeof process === 'undefined' || !process.versions?.node) return null;
  const moduleName = 'ws';
  wsModulePromise ??= import(/* webpackIgnore: true */ moduleName)
    .then((mod) => ((mod as { default?: unknown }).default ?? null) as WebSocketCtor | null)
    .catch(() => null);
  return wsModulePromise;
}

/**
 * Resolves the best available WebSocket constructor at call time.
 * Throws a helpful {@link EventsError} when none can be found.
 */
export async function resolveWebSocketCtor(): Promise<WebSocketCtor> {
  const globalCtor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (typeof globalCtor === 'function') return globalCtor;
  const nodeCtor = await loadNodeWs();
  if (nodeCtor) return nodeCtor;
  throw new EventsError(
    'No WebSocket implementation found. Install the optional peer dependency ' +
      '(`npm i ws`) or pass a custom `socketFactory`.',
  );
}

/**
 * Default factory: browser/Node-22+ global `WebSocket`, else a lazily
 * imported `ws`. Works in bundles and browsers without pulling `ws` in.
 */
export const defaultSocketFactory: SocketFactory = async (url, protocols, init) => {
  const Ctor = await resolveWebSocketCtor();
  // `ws` accepts (url, protocols, options) and honors options.headers;
  // the browser constructor simply ignores the extra argument.
  const extra = init?.headers && Object.keys(init.headers).length > 0 ? { headers: init.headers } : undefined;
  return new Ctor(url, protocols.length > 0 ? protocols : undefined, extra);
};

/* -------------------------------------------------------------------------- */
/* Backoff                                                                     */
/* -------------------------------------------------------------------------- */

/** Exponential backoff with full jitter, capped at `maxDelayMs`. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(maxMs, exp);
  return Math.floor(Math.random() * capped);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* ReconnectingSocket                                                          */
/* -------------------------------------------------------------------------- */

export interface ReconnectingSocketOptions {
  /** URL (or provider, so query-auth can refresh tokens per attempt). */
  url: string | (() => string | Promise<string>);
  /** Subprotocols (or provider, for subprotocol auth). */
  protocols?: string[] | (() => string[] | Promise<string[]>);
  /** Upgrade-request headers (or provider, for header auth — Node `ws` only). */
  headers?:
    | Record<string, string>
    | undefined
    | (() => Record<string, string> | undefined | Promise<Record<string, string> | undefined>);
  socketFactory?: SocketFactory;
  reconnect?: boolean;
  reconnectMaxAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connectTimeoutMs?: number;
  heartbeat?: { intervalMs: number; payload?: unknown; timeoutMs?: number };
  /** Fired after every (re)connection opens — first-message auth lives here. */
  onOpen?: (send: (data: string | ArrayBuffer | Blob) => void) => void | Promise<void>;
  onMessage?: (data: unknown) => void;
  onClose?: (info: { code?: number; reason?: string; userInitiated: boolean }) => void;
  /** Socket-level errors (connect failures, abnormal closes). */
  onError?: (error: unknown) => void;
  onStateChange?: (state: EventsConnectionState, info?: { error?: unknown }) => void;
  /**
   * Veto hook for non-user closes: return `false` to stop reconnecting (the
   * connection then fails with a {@link WebSocketApiError} carrying the close
   * code). May be async — used to run `AuthProvider.handleUnauthorized` for
   * close code 4001 (token expired) before deciding.
   */
  shouldReconnect?: (info: { code?: number; reason?: string }) => boolean | Promise<boolean>;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * A socket with a production lifecycle: per-attempt URL/protocol providers,
 * connect timeout, exponential-backoff reconnection, heartbeats with liveness
 * timeout, and state change notifications. Routing and wire formats live in
 * the layers above.
 */
export class ReconnectingSocket {
  readonly #options: ReconnectingSocketOptions;
  #socket: SocketLike | null = null;
  #state: EventsConnectionState = 'idle';
  #userClosing = false;
  #everOpened = false;
  #failedAttempts = 0;
  #lastError: unknown = undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #lastReceivedAt = 0;
  #openWaiters: Waiter[] = [];
  #closeWaiters: Waiter[] = [];
  #lastClose: { code?: number; reason?: string } | null = null;
  #forcedReconnect = false;

  constructor(options: ReconnectingSocketOptions) {
    this.#options = options;
  }

  get state(): EventsConnectionState {
    return this.#state;
  }

  /** `true` once the socket has fully opened at least once. */
  get hasOpened(): boolean {
    return this.#everOpened;
  }

  /** Number of failed attempts since the last successful connection. */
  get failedAttempts(): number {
    return this.#failedAttempts;
  }

  /**
   * Opens the connection, resolving on the first successful open. When
   * reconnection is enabled the promise keeps waiting through background
   * retries; it rejects only once the attempt budget is exhausted or the
   * socket is closed by the user before opening.
   */
  open(): Promise<void> {
    if (this.#state === 'open') return Promise.resolve();
    if (this.#state === 'connecting' || this.#state === 'reconnecting') {
      return this.#waitOpen();
    }
    this.#userClosing = false;
    this.#failedAttempts = 0;
    void this.#attempt();
    return this.#waitOpen();
  }

  /** Closes the connection (user-initiated — disables reconnection). */
  close(code = 1000, reason = 'client closed'): Promise<void> {
    this.#userClosing = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#clearTimers();
    const socket = this.#socket;
    if (!socket) {
      this.#setState('closed');
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // Safety net: never leave the caller hanging on a stubborn socket.
      const safety = setTimeout(() => resolve(), 5_000);
      const finish = (): void => {
        clearTimeout(safety);
        resolve();
      };
      try {
        socket.close(code, reason);
      } catch {
        finish();
        return;
      }
      void this.#waitClosed().then(finish);
    });
  }

  /**
   * Forces a fresh connection with fresh URL/protocol/auth providers — used
   * after out-of-band token refreshes (`AuthProvider.onAuthStateChanged`).
   * Resolves once the new connection is open. No failed attempt is counted.
   */
  reconnect(): Promise<void> {
    if (this.#state === 'idle' || this.#state === 'closed' || this.#state === 'failed') {
      return this.open();
    }
    this.#userClosing = false;
    this.#forcedReconnect = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const socket = this.#socket;
    if (!socket) {
      void this.#attempt();
      return this.#waitOpen();
    }
    this.#setState('reconnecting');
    try {
      socket.close(1000, 'reconnecting');
    } catch {
      // Some sockets refuse to close cleanly; onclose may still fire.
    }
    return this.#waitOpen();
  }

  /** Resets the reconnect attempt budget (used after a successful auth refresh). */
  resetAttempts(): void {
    this.#failedAttempts = 0;
  }

  /** Sends raw data; throws {@link EventsError} when not open. */
  send(data: string | ArrayBuffer | Blob): void {
    if (this.#state !== 'open' || !this.#socket) {
      throw new EventsError(`Cannot send while the connection is ${this.#state}`);
    }
    this.#socket.send(data);
  }

  /* ---------------------------------------------------------------------- */
  /* Connection attempts                                                     */
  /* ---------------------------------------------------------------------- */

  async #attempt(): Promise<void> {
    this.#setState(this.#everOpened || this.#failedAttempts > 0 ? 'reconnecting' : 'connecting');
    try {
      const url =
        typeof this.#options.url === 'function' ? await this.#options.url() : this.#options.url;
      const protocols =
        typeof this.#options.protocols === 'function'
          ? await this.#options.protocols()
          : this.#options.protocols;
      const headers =
        typeof this.#options.headers === 'function' ? await this.#options.headers() : this.#options.headers;
      const factory = this.#options.socketFactory ?? defaultSocketFactory;
      const socket = await factory(url, protocols ?? [], headers ? { headers } : undefined);
      if (this.#userClosing) {
        try {
          socket.close();
        } catch {
          /* already closing */
        }
        this.#setState('closed');
        return;
      }
      this.#socket = socket;
      this.#wire(socket);
      this.#armConnectTimeout();
    } catch (err) {
      this.#lastError = err;
      this.#options.onError?.(err);
      this.#handleFailure();
    }
  }

  #wire(socket: SocketLike): void {
    socket.onopen = () => {
      if (this.#connectTimer) {
        clearTimeout(this.#connectTimer);
        this.#connectTimer = null;
      }
      this.#failedAttempts = 0;
      this.#everOpened = true;
      // The handshake (first-message auth, protocol inits) must complete
      // before the connection is announced as open — connect() resolving
      // means "ready to talk", not "TCP upgrade done".
      void (async () => {
        try {
          await this.#options.onOpen?.((data) => socket.send(data));
        } catch (err) {
          this.#lastError = err;
          this.#options.onError?.(err);
          try {
            socket.close(1011, 'onOpen hook failed');
          } catch {
            /* ignore */
          }
          return;
        }
        this.#setState('open');
        this.#settle(this.#openWaiters, 'resolve');
        this.#startHeartbeat();
      })();
    };
    socket.onmessage = (event: unknown) => {
      this.#lastReceivedAt = Date.now();
      this.#options.onMessage?.((event as { data?: unknown } | null)?.data);
    };
    socket.onclose = (event: unknown) => {
      this.#teardownSocket();
      const info = event as { code?: number; reason?: string } | null;
      this.#lastClose = { code: info?.code, reason: info?.reason };
      this.#options.onClose?.({
        code: info?.code,
        reason: info?.reason,
        userInitiated: this.#userClosing,
      });
      this.#settle(this.#closeWaiters, 'resolve');
      if (this.#userClosing) {
        this.#setState('closed');
        this.#settle(
          this.#openWaiters,
          'reject',
          new EventsError('Connection closed by the user before it opened'),
        );
        return;
      }
      if (this.#forcedReconnect) {
        // Forced refresh (e.g. token rotation): reconnect immediately,
        // without burning a reconnect-attempt.
        this.#forcedReconnect = false;
        this.#failedAttempts = 0;
        void this.#attempt();
        return;
      }
      void this.#handleFailure();
    };
    socket.onerror = (event: unknown) => {
      this.#lastError = event ?? this.#lastError;
      this.#options.onError?.(event);
    };
  }

  async #handleFailure(): Promise<void> {
    this.#clearTimers();
    const maxAttempts = this.#options.reconnectMaxAttempts ?? 10;
    let canReconnect = (this.#options.reconnect ?? true) && !this.#userClosing;
    if (canReconnect && this.#options.shouldReconnect && this.#lastClose) {
      let verdict: boolean;
      try {
        verdict = await this.#options.shouldReconnect(this.#lastClose);
      } catch (err) {
        this.#lastError = err;
        this.#options.onError?.(err);
        verdict = false;
      }
      if (!verdict) canReconnect = false;
      else this.#failedAttempts = 0; // policy approved the retry (e.g. after refresh)
    }
    if (canReconnect && this.#failedAttempts < maxAttempts) {
      this.#failedAttempts++;
      this.#setState('reconnecting');
      const base = this.#options.reconnectBaseDelayMs ?? 250;
      const max = this.#options.reconnectMaxDelayMs ?? 30_000;
      const delay = backoffDelayMs(this.#failedAttempts, base, max);
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null;
        void this.#attempt();
      }, delay);
      return;
    }
    const failure = this.#failureError();
    this.#setState('failed', { error: failure });
    this.#settle(this.#openWaiters, 'reject', failure);
    this.#settle(this.#closeWaiters, 'resolve');
  }

  #failureError(): EventsError {
    if (this.#lastClose && this.#options.shouldReconnect) {
      const { code, reason } = this.#lastClose;
      return new WebSocketApiError(
        `WebSocket closed by the server${code ? ` (code ${code})` : ''}${reason ? `: ${reason}` : ''}`,
        { code, reason },
      );
    }
    const cause = this.#lastError;
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    return new EventsConnectionError(
      `Connection failed after ${this.#failedAttempts} attempt(s)${detail}`,
      this.#failedAttempts,
      cause,
    );
  }

  #armConnectTimeout(): void {
    const ms = this.#options.connectTimeoutMs ?? 10_000;
    if (ms <= 0) return;
    this.#connectTimer = setTimeout(() => {
      try {
        this.#socket?.close(4002, 'connect timeout');
      } catch {
        void this.#handleFailure();
      }
    }, ms);
  }

  #startHeartbeat(): void {
    const hb = this.#options.heartbeat;
    if (!hb || hb.intervalMs <= 0) return;
    this.#lastReceivedAt = Date.now();
    const payload = hb.payload ?? { type: 'ping' };
    this.#heartbeatTimer = setInterval(() => {
      const socket = this.#socket;
      if (!socket) return;
      try {
        socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      } catch {
        return; // the close handler drives recovery
      }
      if (hb.timeoutMs && hb.timeoutMs > 0 && Date.now() - this.#lastReceivedAt > hb.timeoutMs) {
        try {
          socket.close(4000, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
      }
    }, hb.intervalMs);
  }

  /* ---------------------------------------------------------------------- */
  /* Waiters & timers                                                        */
  /* ---------------------------------------------------------------------- */

  #waitOpen(): Promise<void> {
    if (this.#state === 'open') return Promise.resolve();
    if (this.#state === 'failed') return Promise.reject(this.#failureError());
    if (this.#state === 'closed') {
      return Promise.reject(new EventsError('Connection closed by the user'));
    }
    return new Promise<void>((resolve, reject) => {
      this.#openWaiters.push({ resolve, reject });
    });
  }

  #waitClosed(): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'failed' || this.#state === 'idle') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#closeWaiters.push({ resolve, reject: () => resolve() });
    });
  }

  #settle(waiters: Waiter[], outcome: 'resolve' | 'reject', err?: unknown): void {
    for (const waiter of waiters.splice(0)) {
      if (outcome === 'resolve') waiter.resolve();
      else waiter.reject(err);
    }
  }

  #teardownSocket(): void {
    this.#clearTimers();
    this.#socket = null;
  }

  #clearTimers(): void {
    if (this.#connectTimer) {
      clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
    }
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #setState(state: EventsConnectionState, info?: { error?: unknown }): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state, info);
  }
}
