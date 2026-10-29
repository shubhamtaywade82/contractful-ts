/**
 * `defineEvents` — the events sibling of `defineApi`.
 *
 * Declare the shape of an event API — URL, channels, message fields — and
 * the library derives a typed client class, one method per channel:
 * `subscribe()` channels become `on(handler)` methods with an open-world
 * incoming shape gate, `publish()` channels become `send(message)` methods
 * with contractful's closed-world validation (typos and missing required
 * fields are rejected before anything reaches the wire).
 *
 * ```ts
 * const OrderEvents = defineEvents({
 *   name: 'OrderEvents',
 *   url: 'wss://api.example.com/events',
 *   channels: {
 *     onOrderCreated: subscribe('order.created', {
 *       fields: { orderId: P.string({ required: true }) },
 *     }),
 *     createOrder: publish('order.create', {
 *       fields: { productId: P.string({ required: true }), quantity: P.integer({ min: 1 }) },
 *     }),
 *   },
 * });
 *
 * const events = new OrderEvents({ authMode: 'query', tokenProvider: () => token });
 * await events.connect();
 * const off = events.onOrderCreated((message) => console.log(message.orderId));
 * await events.createOrder({ productId: 'p1', quantity: 2 });
 * ```
 */

import {
  ContractViolationError,
  MessageShapeError,
  type Violation,
} from '../errors.js';
import { buildPath } from '../http/path.js';
import { validateParams } from '../validation/validate.js';
import type { InferArgs, ParamsShape } from '../dsl/params.js';
import { EventsClient } from './client.js';
import type {
  EventsClientOptions,
  EventsConnectionState,
  TopicContext,
} from './types.js';

export type { TopicContext };

/* -------------------------------------------------------------------------- */
/* Channel factories                                                           */
/* -------------------------------------------------------------------------- */

export interface ChannelOptions<P extends ParamsShape, F extends ParamsShape> {
  /** Topic parameters for patterns like `order/:id/created`. */
  params?: P;
  /** Message payload fields — closed on publish, gated on subscribe. */
  fields?: F;
  /** Free-form documentation surfaced by `describe()`. */
  description?: string;
}

/** A channel value: direction + topic + fields, with phantom types for inference. */
export interface ChannelDefinition<
  TMessage = unknown,
  TParams = Record<string, never>,
  D extends 'in' | 'out' = 'in',
> {
  readonly __contractful: 'channel';
  readonly direction: D;
  readonly pattern: string;
  readonly options: ChannelOptions<ParamsShape, ParamsShape>;
  /** Phantom: the message type. */
  readonly __messageType: TMessage;
  /** Phantom: the topic-params type. */
  readonly __paramsType: TParams;
}

export type ChannelMessage<D> = D extends ChannelDefinition<infer T, any, any> ? T : never;
export type ChannelParams<D> = D extends ChannelDefinition<any, infer T, any> ? T : never;

/**
 * Declares a channel the client listens on.
 *
 * ```ts
 * subscribe('order/:id/created', {
 *   params: { id: P.string({ required: true }) },
 *   fields: { orderId: P.string({ required: true }) },
 * })
 * ```
 *
 * The optional type parameter pins the message type:
 * `subscribe<OrderCreated>('order.created', { ... })`.
 */
export function subscribe<T = unknown, P extends ParamsShape = {}, F extends ParamsShape = {}>(
  pattern: string,
  options: ChannelOptions<P, F> = {},
): ChannelDefinition<T, InferArgs<P>, 'in'> {
  return {
    __contractful: 'channel',
    direction: 'in',
    pattern,
    options: options as ChannelOptions<ParamsShape, ParamsShape>,
    __messageType: undefined as never,
    __paramsType: undefined as never,
  };
}

/**
 * Declares a channel the client publishes to. Message fields are validated
 * against a closed schema before anything is sent.
 *
 * ```ts
 * publish('order.create', {
 *   fields: { productId: P.string({ required: true }), quantity: P.integer({ min: 1 }) },
 * })
 * ```
 */
export function publish<T = unknown, P extends ParamsShape = {}, F extends ParamsShape = {}>(
  topic: string,
  options: ChannelOptions<P, F> = {},
): ChannelDefinition<T, InferArgs<P>, 'out'> {
  return {
    __contractful: 'channel',
    direction: 'out',
    pattern: topic,
    options: options as ChannelOptions<ParamsShape, ParamsShape>,
    __messageType: undefined as never,
    __paramsType: undefined as never,
  };
}

/* -------------------------------------------------------------------------- */
/* Derived method types                                                        */
/* -------------------------------------------------------------------------- */

export type EventsChannels = Record<string, ChannelDefinition<any, any, any>>;

/** Handler context for a subscribe channel: topic params are fully typed. */
export type SubscribeContext<D> = TopicContext & { params: ChannelParams<D> };

type HasKeys<T> = [keyof T] extends [never] ? false : true;

/** `(handler) => unsubscribe` for `in` channels; `(message[, params]) => Promise` for `out`. */
export type ChannelMethod<D> = D extends ChannelDefinition<any, any, 'in'>
  ? (handler: (message: ChannelMessage<D>, ctx: SubscribeContext<D>) => void) => () => void
  : D extends ChannelDefinition<any, any, 'out'>
    ? HasKeys<ChannelParams<D>> extends true
      ? (message: ChannelMessage<D>, params: ChannelParams<D>) => Promise<void>
      : (message: ChannelMessage<D>) => Promise<void>
    : never;

export interface EventsClientBase {
  readonly eventsName: string;
  /** Renders all channels (or a single one) as a readable description. */
  describe(name?: string): string;
}

export type EventsClientInstance<C extends EventsChannels> = {
  [K in keyof C]: ChannelMethod<C[K]>;
} & {
  connect(): Promise<void>;
  disconnect(code?: number, reason?: string): Promise<void>;
  readonly state: EventsConnectionState;
  /** Notified for connection errors, socket errors, handler exceptions and shape failures. */
  onError(handler: (error: unknown) => void): () => void;
  onConnected(handler: () => void): () => void;
  onDisconnected(handler: () => void): () => void;
  /** The underlying low-level client (topic routing escape hatch). */
  readonly raw: EventsClient;
} & EventsClientBase;

export interface EventsClientConstructor<C extends EventsChannels> {
  new (options?: EventsChannelClientOptions): EventsClientInstance<C>;
  readonly channels: C;
  readonly eventsName: string;
  describe(): string;
}

/** Everything {@link EventsClientOptions} accepts, minus what `defineEvents` owns. */
export type EventsChannelClientOptions = Omit<EventsClientOptions, 'url'> & {
  /** Overrides the URL declared by `defineEvents`. */
  url?: string;
  /**
   * What happens when an incoming message fails its channel's shape gate.
   * Default: report through `onError` and skip the handler.
   */
  onInvalidMessage?: (error: MessageShapeError, raw: unknown) => void;
};

export interface EventsOptions<C extends EventsChannels> extends Omit<EventsClientOptions, 'url'> {
  /** Name used in error messages and `describe()` output. */
  name?: string;
  /** WebSocket URL every channel is routed over. */
  url: string;
  /** The channels — one client method is derived per entry. */
  channels: C;
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Closed-world validation of an outgoing message: unknown keys are rejected,
 * declared keys are coerced and constraint-checked. Returns the coerced
 * value pool (declared fields only) and every violation.
 */
function validateOutgoing(
  fields: ParamsShape,
  input: unknown,
): { issues: Violation[]; values: Record<string, unknown> } {
  const issues: Violation[] = [];
  const known: Record<string, unknown> = {};

  if (input === undefined || input === null) {
    // validateParams reports the missing required fields below.
  } else if (typeof input !== 'object' || Array.isArray(input)) {
    issues.push({
      param: '(message)',
      rule: 'hash',
      message: `expected an object, got ${Array.isArray(input) ? 'array' : typeof input}`,
      value: input,
    });
  } else {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (key in fields) known[key] = value;
      else {
        issues.push({
          param: key,
          rule: 'unknown',
          message: 'is not declared in this channel',
          value,
        });
      }
    }
  }

  const validation = validateParams(fields, known);
  return { issues: [...issues, ...validation.issues], values: validation.values };
}

/**
 * Open-world gate for incoming messages: required declared fields must be
 * present and well-formed; unknown fields are data, not errors. The message
 * is passed through unmutated.
 */
function gateIncoming(fields: ParamsShape, message: unknown): Violation[] {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return [
      {
        param: '(message)',
        rule: 'hash',
        message: `expected an object, got ${Array.isArray(message) ? 'array' : typeof message}`,
        value: message,
      },
    ];
  }
  return validateParams(fields, message as Record<string, unknown>).issues;
}

/* -------------------------------------------------------------------------- */
/* defineEvents                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Defines an events client class from a set of channels.
 *
 * ```ts
 * export const OrderEvents = defineEvents({
 *   name: 'OrderEvents',
 *   url: 'wss://api.example.com/events',
 *   channels: { onOrderCreated: subscribe('order.created', { ... }) },
 * });
 * ```
 */
export function defineEvents<C extends EventsChannels>(
  options: EventsOptions<C>,
): EventsClientConstructor<C> {
  const eventsName = options.name ?? 'events';

  class EventsClientTyped implements EventsClientBase {
    readonly eventsName = eventsName;
    readonly raw: EventsClient;
    readonly #errorHandlers = new Set<(error: unknown) => void>();
    readonly #invalidMessageHandler: EventsChannelClientOptions['onInvalidMessage'];

    constructor(clientOptions: EventsChannelClientOptions = {}) {
      this.raw = new EventsClient({
        ...options,
        ...clientOptions,
        url: clientOptions.url ?? options.url,
      });
      this.#invalidMessageHandler = clientOptions.onInvalidMessage;
      // Connection / socket errors surface through the same onError handlers.
      this.raw.onError((error) => {
        for (const handler of [...this.#errorHandlers]) handler(error);
      });

      for (const [name, def] of Object.entries(options.channels)) {
        Object.defineProperty(this, name, {
          value: this.#buildMethod(def),
          enumerable: true,
          writable: false,
          configurable: true,
        });
      }
    }

    get state(): EventsConnectionState {
      return this.raw.state;
    }

    connect(): Promise<void> {
      return this.raw.connect();
    }

    disconnect(code = 1000, reason = 'client closed'): Promise<void> {
      return this.raw.disconnect(code, reason);
    }

    onError(handler: (error: unknown) => void): () => void {
      this.#errorHandlers.add(handler);
      return () => this.#errorHandlers.delete(handler);
    }

    onConnected(handler: () => void): () => void {
      return this.raw.onConnected(handler);
    }

    onDisconnected(handler: () => void): () => void {
      return this.raw.onDisconnected(handler);
    }

    describe(name?: string): string {
      return name
        ? describeChannel(options.channels[name])
        : describeEvents(eventsName, options);
    }

    #buildMethod(def: ChannelDefinition<any, any, any>): ChannelMethod<any> {
      if (def.direction === 'in') {
        return ((handler: (message: any, ctx: any) => void) => {
          const fields = def.options.fields ?? {};
          return this.raw.subscribe(def.pattern, (message, ctx) => {
            if (Object.keys(fields).length > 0) {
              const issues = gateIncoming(fields, message);
              if (issues.length > 0) {
                this.#reportInvalid(
                  new MessageShapeError({ topic: ctx.topic, violations: issues, raw: message }),
                );
                return;
              }
            }
            handler(message, ctx);
          });
        }) as ChannelMethod<any>;
      }

      return (async (message: unknown, params?: Record<string, unknown>) => {
        const fields = def.options.fields ?? {};
        const specs = def.options.params ?? {};
        const issues: Violation[] = [];

        let payload = message;
        if (Object.keys(fields).length > 0) {
          const outgoing = validateOutgoing(fields, message);
          issues.push(...outgoing.issues);
          payload = outgoing.values;
        }
        const paramsValidation = validateParams(specs, params);
        issues.push(...paramsValidation.issues);
        if (issues.length > 0) throw new ContractViolationError(issues);

        const { path: topic } = buildPath(def.pattern, paramsValidation.values);
        await this.raw.publish(topic, payload);
      }) as ChannelMethod<any>;
    }

    #reportInvalid(error: MessageShapeError): void {
      if (this.#invalidMessageHandler) {
        this.#invalidMessageHandler(error, error.raw);
        return;
      }
      // Default: surface through onError so subscribers see it while the
      // connection stays up.
      for (const handler of [...this.#errorHandlers]) handler(error);
    }
  }

  const ctor = EventsClientTyped as unknown as EventsClientConstructor<C>;
  Object.defineProperty(ctor, 'channels', {
    value: options.channels,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(ctor, 'eventsName', {
    value: eventsName,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(ctor, 'describe', {
    value: () => describeEvents(eventsName, options),
    enumerable: false,
    writable: false,
  });
  return ctor;
}

/* -------------------------------------------------------------------------- */
/* Introspection                                                              */
/* -------------------------------------------------------------------------- */

function describeChannel(def: ChannelDefinition<any, any, any> | undefined): string {
  if (!def) return 'No such channel on this events client.';
  const lines: string[] = [];
  lines.push(`${def.direction === 'in' ? 'SUBSCRIBE' : 'PUBLISH'}  ${def.pattern}`);
  if (def.options.description) lines.push(`  ${def.options.description}`);
  const params = def.options.params ?? {};
  if (Object.keys(params).length > 0) {
    lines.push('    params:');
    for (const [key, spec] of Object.entries(params)) {
      lines.push(`      ${key}: ${spec.kind}${spec.required ? ' (required)' : ''}`);
    }
  }
  const fields = def.options.fields ?? {};
  if (Object.keys(fields).length > 0) {
    lines.push('    fields:');
    for (const [key, spec] of Object.entries(fields)) {
      lines.push(`      ${key}: ${spec.kind}${spec.required ? ' (required)' : ''}`);
    }
  }
  return lines.join('\n');
}

function describeEvents(eventsName: string, options: EventsOptions<EventsChannels>): string {
  const lines: string[] = [`${eventsName} (${options.url})`];
  const entries = Object.entries(options.channels);
  if (entries.length === 0) lines.push('  (no channels declared)');
  for (const [name, def] of entries) {
    lines.push(`  ${name.padEnd(24)} ${def.direction === 'in' ? 'SUB' : 'PUB'}  ${def.pattern}`);
  }
  return lines.join('\n');
}
