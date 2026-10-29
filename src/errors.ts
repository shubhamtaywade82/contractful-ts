/**
 * Error hierarchy for contractful-ts.
 *
 * Every error thrown by the library extends {@link ContractfulError}.
 * The `retryable` flag drives the retry policy: retryable errors are
 * retried (subject to the retry budget), terminal errors fail fast.
 */

export interface ContractfulErrorOptions {
  cause?: unknown;
  retryable?: boolean;
}

/** Base class for every error raised by contractful-ts. */
export class ContractfulError extends Error {
  /** Whether the request that produced this error may be retried. */
  readonly retryable: boolean;

  constructor(message: string, options: ContractfulErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

/** A single request-validation failure. */
export interface Violation {
  /** Parameter name (or `param[index]` / `param.key` for nested values). */
  param: string;
  /** Constraint that failed, e.g. `required`, `inclusion`, `min`. */
  rule: string;
  /** Human-readable explanation of the failure. */
  message: string;
  /** The offending value, if any. */
  value: unknown;
}

/**
 * The request arguments violated the contract's closed request schema.
 * This is a terminal (client-side) error: nothing was sent over the wire.
 */
export class ContractViolationError extends ContractfulError {
  readonly violations: Violation[];

  constructor(violations: Violation[], message?: string) {
    const summary =
      message ??
      `Contract violation: ${violations
        .map((v) => `${v.param} ${v.message}`)
        .join('; ')}`;
    super(summary, { retryable: false });
    this.violations = violations;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), violations: this.violations };
  }
}

/**
 * The API definition itself is invalid (bad route string, a path parameter
 * that is not declared, `required` combined with `default`, ...).
 * Thrown at `contract()` / `defineApi()` time, never at request time.
 */
export class ContractDefinitionError extends ContractfulError {
  constructor(message: string) {
    super(message, { retryable: false });
  }
}

/** A path parameter required by the route template was missing or empty. */
export class PathBuildError extends ContractfulError {
  readonly template: string;
  readonly missing: string[];

  constructor(template: string, missing: string[]) {
    super(
      `Cannot build path from template ${JSON.stringify(template)}: missing path parameter(s): ${missing
        .map((m) => `:${m}`)
        .join(', ')}`,
    );
    this.template = template;
    this.missing = missing;
  }
}

/** Authentication could not be resolved (token provider failure, ...). */
export class AuthError extends ContractfulError {
  constructor(message: string, options: ContractfulErrorOptions = {}) {
    super(message, { ...options, retryable: false });
  }
}

/** A request was aborted through an `AbortSignal` before it completed. */
export class RequestAbortedError extends ContractfulError {
  constructor(message = 'Request aborted', cause?: unknown) {
    super(message, { cause, retryable: false });
  }
}

/** Network-level failure (connection refused, DNS error, ...). Retryable. */
export class TransportError extends ContractfulError {
  /** Machine-readable code, e.g. `ECONNREFUSED`. */
  readonly code?: string;

  constructor(message: string, options: ContractfulErrorOptions & { code?: string } = {}) {
    super(message, { retryable: options.retryable ?? true, cause: options.cause });
    this.code = options.code;
  }
}

/** The request exceeded its timeout. Retryable. */
export class TimeoutError extends TransportError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`Request timed out after ${timeoutMs}ms`, { cause, code: 'ETIMEDOUT' });
    this.timeoutMs = timeoutMs;
  }
}

export interface HttpStatusErrorOptions {
  status: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** True when the status was listed under `responds` in the contract. */
  declared?: boolean;
  /** Parsed `Retry-After` header in milliseconds, when present. */
  retryAfterMs?: number;
  /** Request method, for richer auth error messages. */
  method?: string;
  /** Request path, for richer auth error messages. */
  path?: string;
  /** Full request URL, for richer auth error messages. */
  url?: string;
}

/**
 * The server answered with a status the contract did not declare as
 * successful (or declared as an error). The parsed body is attached so
 * callers can inspect API-specific error payloads.
 */
export class HttpStatusError extends ContractfulError {
  readonly status: number;
  readonly statusText?: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly declared: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: HttpStatusErrorOptions) {
    const retryable =
      options.status === 408 ||
      options.status === 425 ||
      options.status === 429 ||
      options.status >= 500;
    super(message, { retryable });
    this.status = options.status;
    this.statusText = options.statusText;
    this.body = options.body;
    this.headers = options.headers ?? {};
    this.declared = options.declared ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      status: this.status,
      body: this.body,
      declared: this.declared,
    };
  }
}

/** HTTP 429 specifically — retryable, honors `Retry-After`. */
export class RateLimitError extends HttpStatusError {
  constructor(options: HttpStatusErrorOptions) {
    super(`Rate limited (429)${options.retryAfterMs ? `; retry after ${options.retryAfterMs}ms` : ''}`, {
      ...options,
      status: 429,
    });
  }
}

/**
 * The terminal form of an HTTP 401: the server rejected the credentials and
 * no (further) refresh was possible (no refresh hook, or the single refresh
 * retry was exhausted). Carries the status, body and headers of the
 * offending response.
 */
export class AuthenticationError extends HttpStatusError {
  constructor(options: HttpStatusErrorOptions) {
    const target = [options.method, options.path ?? options.url].filter(Boolean).join(' ');
    super(`Authentication failed (401)${target ? ` for ${target}` : ''}`, { ...options, status: 401 });
  }
}

/**
 * HTTP 403 — the credentials are valid but lack permission. Deliberately
 * *not* auto-refreshed: retrying with fresh tokens of the same principal
 * cannot fix an authorization decision.
 */
export class AuthorizationError extends HttpStatusError {
  constructor(options: HttpStatusErrorOptions) {
    const target = [options.method, options.path ?? options.url].filter(Boolean).join(' ');
    super(`Forbidden (403)${target ? ` for ${target}` : ''}`, { ...options, status: 403 });
  }
}

export interface ResponseShapeErrorOptions {
  status: number;
  body: unknown;
  expectedType: string;
  actualType: string;
}

/**
 * The response body did not match the top-level shape declared with
 * `responds: [{ status, type }]`. Note that responses are otherwise
 * *open*: unknown fields are passed through untouched.
 */
export class ResponseShapeError extends ContractfulError {
  readonly status: number;
  readonly body: unknown;
  readonly expectedType: string;
  readonly actualType: string;

  constructor(options: ResponseShapeErrorOptions) {
    super(
      `Response shape mismatch: expected top-level ${options.expectedType} for status ${options.status}, got ${options.actualType}`,
      { retryable: false },
    );
    this.status = options.status;
    this.body = options.body;
    this.expectedType = options.expectedType;
    this.actualType = options.actualType;
  }
}

/** The circuit breaker for a host is open — fail fast instead of calling out. */
export class CircuitOpenError extends ContractfulError {
  readonly host: string;
  readonly cooldownRemainingMs: number;

  constructor(host: string, cooldownRemainingMs: number) {
    super(
      `Circuit breaker open for ${host}: failing fast (${Math.ceil(cooldownRemainingMs)}ms remaining in cooldown)`,
      { retryable: false },
    );
    this.host = host;
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

/** Too many requests are already queued on the rate limiter. */
export class QueueFullError extends ContractfulError {
  readonly maxQueue: number;

  constructor(maxQueue: number) {
    super(`Rate limiter queue is full (${maxQueue} pending); request rejected`, {
      retryable: false,
    });
    this.maxQueue = maxQueue;
  }
}

/**
 * Base class for event/WebSocket runtime failures: the socket could not be
 * created, the connection dropped, or an operation was attempted in a state
 * that does not allow it.
 */
export class EventsError extends ContractfulError {
  constructor(message: string, options: ContractfulErrorOptions = {}) {
    super(message, options);
  }
}

/** The connection failed (or dropped) and the reconnect budget is exhausted. */
export class EventsConnectionError extends EventsError {
  readonly attempts: number;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message, { cause, retryable: true });
    this.attempts = attempts;
  }
}

export interface WebSocketApiErrorOptions {
  /** WebSocket close code, e.g. `4001` (token expired). */
  code?: number;
  /** Close reason supplied by the server. */
  reason?: string;
  /** Channel / topic the connection was serving, when known. */
  channel?: string;
  cause?: unknown;
}

/**
 * The WebSocket counterpart of {@link HttpStatusError}: the server closed the
 * connection with a meaningful close code (authentication, authorization,
 * policy, ...). Private-use codes `4000`–`4999` are convention.
 */
export class WebSocketApiError extends EventsError {
  readonly code?: number;
  readonly reason?: string;
  readonly channel?: string;

  constructor(message: string, options: WebSocketApiErrorOptions = {}) {
    super(message, { cause: options.cause, retryable: false });
    this.code = options.code;
    this.reason = options.reason;
    this.channel = options.channel;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), code: this.code, reason: this.reason, channel: this.channel };
  }
}

/**
 * Conventional private-use WebSocket close codes (range 4000–4999) shared by
 * the client and the server. `shouldReconnectOnClose` implements the policy:
 * token expiry is recoverable (refresh + reconnect); authorization failures
 * are terminal.
 */
export const WS_CLOSE_CODES = {
  /** Client-side: no frame within the heartbeat liveness window. */
  HEARTBEAT_TIMEOUT: 4000,
  /** Server-side: the presented token has expired. */
  TOKEN_EXPIRED: 4001,
  /** Client-side: the upgrade did not complete within the connect timeout. */
  CONNECT_TIMEOUT: 4002,
  /** Server-side: the presented credentials were rejected. */
  UNAUTHORIZED: 4003,
  /** Server-side: valid credentials, insufficient permission. */
  FORBIDDEN: 4004,
} as const;

/**
 * Close-code reconnect policy. `4001` (token expired) reconnects after a
 * refresh; `4003`/`4004` are terminal authorization decisions; everything
 * else (abnormal closes, restarts, ...) reconnects with backoff.
 */
export function shouldReconnectOnClose(code: number | undefined): boolean {
  if (code === WS_CLOSE_CODES.TOKEN_EXPIRED) return true;
  if (code === WS_CLOSE_CODES.UNAUTHORIZED) return false;
  if (code === WS_CLOSE_CODES.FORBIDDEN) return false;
  return true;
}

export interface MessageShapeErrorOptions {
  topic: string | null;
  violations: Violation[];
}

/**
 * An incoming event message did not satisfy the fields declared by its
 * channel (missing required keys or wrong kinds). The raw frame is attached.
 */
export class MessageShapeError extends ContractfulError {
  readonly topic: string | null;
  readonly violations: Violation[];
  readonly raw: unknown;

  constructor(options: MessageShapeErrorOptions & { raw?: unknown }) {
    super(
      `Message shape mismatch on ${options.topic ?? '(no topic)'}: ${options.violations
        .map((v) => `${v.param} ${v.message}`)
        .join('; ')}`,
      { retryable: false },
    );
    this.topic = options.topic;
    this.violations = options.violations;
    this.raw = options.raw;
  }
}

/** A GraphQL response carried a non-empty `errors` array. */
export class GraphQLError extends ContractfulError {
  readonly errors: unknown[];

  constructor(errors: unknown[]) {
    super(`GraphQL operation failed: ${JSON.stringify(errors)}`, { retryable: false });
    this.errors = errors;
  }
}

/**
 * The transport-agnostic error taxonomy from the platform client design:
 * `errorKind(err)` maps any thrown value onto it so consumers can route
 * handling consistently across HTTP and WebSocket surfaces.
 */
export type ApiClientErrorKind =
  | 'authentication'
  | 'authorization'
  | 'validation'
  | 'network'
  | 'timeout'
  | 'server'
  | 'websocket'
  | 'unknown';

/** Classifies any thrown value into the {@link ApiClientErrorKind} taxonomy. */
export function errorKind(err: unknown): ApiClientErrorKind {
  if (err instanceof AuthenticationError || err instanceof AuthError) return 'authentication';
  if (err instanceof AuthorizationError) return 'authorization';
  if (
    err instanceof ContractViolationError ||
    err instanceof ContractDefinitionError ||
    err instanceof ResponseShapeError ||
    err instanceof MessageShapeError
  ) {
    return 'validation';
  }
  if (err instanceof TimeoutError) return 'timeout';
  if (err instanceof CircuitOpenError || err instanceof QueueFullError) return 'network';
  if (err instanceof TransportError) return 'network';
  if (err instanceof GraphQLError) return 'server';
  if (err instanceof EventsError) return 'websocket';
  if (err instanceof HttpStatusError) {
    if (err.status === 408) return 'timeout';
    if (err.status === 429) return 'network';
    return err.status >= 500 ? 'server' : 'validation';
  }
  if (err instanceof RequestAbortedError) return 'network';
  return 'unknown';
}

/** Inspects an unknown thrown value and returns the library error it represents. */
export function asContractfulError(err: unknown): ContractfulError | undefined {
  return err instanceof ContractfulError ? err : undefined;
}
