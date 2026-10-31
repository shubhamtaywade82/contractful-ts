/**
 * AsyncAPI 2.x / 3.x adapter — translates event-driven API documents into
 * the channel IR used by the events emitter.
 *
 * Direction semantics: AsyncAPI documents are written from someone's
 * perspective, and `publish`/`subscribe` flip meaning depending on whose.
 * `perspective` states whose eyes the document is written from:
 *
 * - `'server'` (default): the doc describes the API provider. The server's
 *   `publish` blocks (2.x) / `send` operations (3.x) are messages the
 *   client SUBSCRIBES to; the server's `subscribe` / `receive` are channels
 *   the client PUBLISHES to.
 * - `'client'`: the doc describes the client application itself (the
 *   Streetlights style) — the mapping flips.
 */

import { dereference, schemaFrom, toCamelCase, toKebabCase, toPascalCase, uniqueName, type Json, type JsonRecord, type ParamIR, type SchemaIR } from './openapi.js';
import { loadSpec, type OpenApiSpec } from './openapi.js';
import type { ChannelGroupIR, ChannelIR, EventsIR } from './model.js';

export type AsyncApiPerspective = 'server' | 'client';

/** Deterministic naming rules for derived client surface names. */
export interface EventNamingOptions {
  /**
   * Normalizes channel labels before method names are derived, and keys the
   * generated `EVENT_NAMES` alias map. Default `'keep'`.
   *
   * - `'dot.case'` — `OrderCreated` / `order-created` → `order.created`
   * - `'kebab-case'` — → `order-created`
   * - `'keep'` — the raw channel label
   */
  eventNameStyle?: 'dot.case' | 'kebab-case' | 'keep';
  /** Prefix for subscribe-channel methods. Default `'on'`. */
  handlerPrefix?: string;
  /** Drop `v<digits>` version segments from derived names. Default `false`. */
  stripVersion?: boolean;
}

export interface BuildEventsIROptions {
  /** Whose perspective the document is written from. Default `'server'`. */
  perspective?: AsyncApiPerspective;
  /** Overrides the server URL from the spec. */
  url?: string;
  /** Deterministic naming rules (see {@link EventNamingOptions}). */
  naming?: EventNamingOptions;
}

export class AsyncApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsyncApiError';
  }
}

/** Loads an AsyncAPI document from a path, URL or raw JSON/YAML text. */
export async function loadAsyncApiSpec(source: string): Promise<OpenApiSpec> {
  return loadSpec(source);
}

/** Builds the events IR from a parsed AsyncAPI 2.x or 3.x document. */
export function buildEventsIR(spec: OpenApiSpec, options: BuildEventsIROptions = {}): EventsIR {
  const rawVersion = typeof spec.asyncapi === 'string' ? spec.asyncapi : '';
  if (!rawVersion) throw new AsyncApiError('Document does not declare an `asyncapi` version.');
  const major = Number.parseInt(rawVersion.split('.')[0] ?? '0', 10);
  if (major !== 2 && major !== 3) {
    throw new AsyncApiError(`Unsupported AsyncAPI version ${JSON.stringify(rawVersion)} (expected 2.x or 3.x).`);
  }

  const title = (spec.info?.title ?? 'Events').trim() || 'Events';
  const version = spec.info?.version;
  const url = options.url ?? pickServerUrl(spec, major);
  const perspective = options.perspective ?? 'server';
  const naming: EventNamingOptions = options.naming ?? {};

  const dereferenced = dereference(spec as unknown as Json, spec) as JsonRecord;
  const channels = (dereferenced.channels ?? {}) as JsonRecord;

  // Channels group by `x-client-domain` (the domain facade hook), falling
  // back to a single `events` group.
  const groups = new Map<string, ChannelGroupIR>();
  const ensureGroup = (domain: string): ChannelGroupIR => {
    const key = domain || 'events';
    let group = groups.get(key);
    if (!group) {
      group = {
        name: key,
        constName: `${toCamelCase(title)}${toPascalCase(key)}`,
        fileName: `${toKebabCase(title)}-${toKebabCase(key)}.ts`,
        channels: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  const usedNames = new Set<string>();
  const defaultGroup = ensureGroup('events');

  if (major === 2) {
    buildV2Channels(channels, defaultGroup, groups, ensureGroup, usedNames, perspective, naming);
  } else {
    // 3.x: raw operations keep $ref pointers whose trailing segment names the
    // message — that name is lost after dereferencing, so read refs raw and
    // resolve the objects individually.
    buildV3Channels(
      channels,
      (spec.operations ?? {}) as JsonRecord,
      defaultGroup,
      groups,
      ensureGroup,
      usedNames,
      perspective,
      naming,
      spec,
    );
  }

  const sorted = [...groups.values()]
    .filter((g) => g.channels.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    title,
    version,
    url,
    groups: sorted,
  };
}

/* -------------------------------------------------------------------------- */
/* Servers                                                                     */
/* -------------------------------------------------------------------------- */

function pickServerUrl(spec: OpenApiSpec, major: 2 | 3): string {
  const servers = (spec.servers ?? {}) as JsonRecord;
  const entries = Object.values(servers).filter(
    (s): s is JsonRecord => typeof s === 'object' && s !== null,
  );
  for (const server of entries) {
    const protocol = typeof server.protocol === 'string' ? server.protocol : '';
    if (protocol !== 'ws' && protocol !== 'wss' && protocol !== 'websocket') continue;
    const url = major === 3 ? hostToUrl(server) : substituteServerVariables(String(server.url ?? ''), server);
    if (url) return url;
  }
  const first = entries[0];
  if (first) {
    const url = major === 3 ? hostToUrl(first) : substituteServerVariables(String(first.url ?? ''), first);
    if (url) return url;
  }
  return 'wss://example.com';
}

/**
 * Fills `{variable}` templates in a server URL from each variable's
 * `default` (the AsyncAPI server-variables convention). Variables without a
 * default are left in place — a visible, greppable marker rather than a
 * silently broken URL.
 */
function substituteServerVariables(url: string, server: JsonRecord): string {
  const variables = (server.variables ?? {}) as JsonRecord;
  if (typeof variables !== 'object' || variables === null) return url;
  return url.replace(/\{([^}]+)\}/g, (template, name: string) => {
    const variable = variables[name];
    if (typeof variable === 'object' && variable !== null) {
      const fallback = (variable as JsonRecord).default;
      if (typeof fallback === 'string' && fallback.length > 0) return fallback;
    }
    return template;
  });
}

/** Last segment of a local $ref pointer (`#/channels/order` → `order`). */
function refTail(ref: unknown): string | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  const segments = ref.split('/');
  return segments[segments.length - 1] || undefined;
}

function hostToUrl(server: JsonRecord): string {
  // AsyncAPI 3.x servers use `host` without scheme; 2.x uses full `url`.
  const rawHost = typeof server.host === 'string' ? server.host : '';
  if (!rawHost) return substituteServerVariables(String(server.url ?? ''), server);
  const host = substituteServerVariables(rawHost, server);
  if (/^wss?:\/\//i.test(host)) return host;
  const protocol = typeof server.protocol === 'string' && server.protocol.startsWith('ws')
    ? server.protocol
    : 'wss';
  return `${protocol}://${host}`;
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

/** Applies the configured naming rules to a channel label. */
export function normalizeEventName(label: string, naming: EventNamingOptions): string {
  let name = label;
  if (naming.stripVersion) {
    name = name
      .split(/[.\-/]/)
      .filter((segment) => !/^v\d+$/i.test(segment))
      .join('.');
  }
  if (naming.eventNameStyle === 'dot.case') {
    name = name
      .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
      .toLowerCase()
      .replace(/[.\-/]+/g, '.')
      .replace(/^\.+|\.+$/g, '');
  } else if (naming.eventNameStyle === 'kebab-case') {
    name = name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[.\-/]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  return name || label;
}

/* -------------------------------------------------------------------------- */
/* 2.x                                                                        */
/* -------------------------------------------------------------------------- */

type EnsureGroup = (domain: string) => ChannelGroupIR;

function buildV2Channels(
  channels: JsonRecord,
  defaultGroup: ChannelGroupIR,
  groups: Map<string, ChannelGroupIR>,
  ensureGroup: EnsureGroup,
  usedNames: Set<string>,
  perspective: AsyncApiPerspective,
  naming: EventNamingOptions,
): void {
  for (const [rawName, rawChannel] of Object.entries(channels)) {
    if (typeof rawChannel !== 'object' || rawChannel === null) continue;
    const channel = rawChannel as JsonRecord;
    const topic = rawName.replace(/\{([^}]+)\}/g, (_m, param: string) => `:${param}`);
    const params = paramsFromV2Parameters(channel.parameters as JsonRecord | undefined);
    const description =
      typeof channel.description === 'string' ? channel.description : undefined;
    const domain =
      typeof channel['x-client-domain'] === 'string' ? channel['x-client-domain'] : '';
    const group = domain ? ensureGroup(domain) : defaultGroup;

    // 2.x: from the document perspective, `publish` = this side publishes.
    for (const [key, direction] of [
      ['publish', perspective === 'server' ? 'in' : 'out'],
      ['subscribe', perspective === 'server' ? 'out' : 'in'],
    ] as const) {
      const operation = channel[key];
      if (typeof operation !== 'object' || operation === null) continue;
      const operationRecord = operation as JsonRecord;
      const messages = messagesFromV2Operation(operationRecord);
      emitChannelMethods({
        topic,
        direction,
        params,
        description,
        channelLabel: rawName,
        eventNameOverride:
          typeof channel['x-client-event-name'] === 'string'
            ? (channel['x-client-event-name'] as string)
            : undefined,
        messages,
        group,
        usedNames,
        naming,
        // 2.x `operationId` is the operation's stable name — same role as the
        // 3.x operation key.
        methodName:
          typeof operationRecord.operationId === 'string' && operationRecord.operationId.length > 0
            ? operationRecord.operationId
            : undefined,
      });
    }
  }
}

function messagesFromV2Operation(operation: JsonRecord): MessageSource[] {
  const message = operation.message;
  if (typeof message !== 'object' || message === null) return [];
  const record = message as JsonRecord;
  if (Array.isArray(record.oneOf)) {
    return record.oneOf.filter((m) => typeof m === 'object' && m !== null) as unknown as MessageSource[];
  }
  return [record as unknown as MessageSource];
}

function paramsFromV2Parameters(parameters: JsonRecord | undefined): ParamIR[] {
  if (!parameters || typeof parameters !== 'object') return [];
  const params: ParamIR[] = [];
  for (const [name, raw] of Object.entries(parameters)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as JsonRecord;
    params.push({
      tsName: toCamelCase(name),
      wireName: name,
      location: 'path',
      schema: schemaFrom((record.schema ?? record) as JsonRecord),
      required: true,
      description: typeof record.description === 'string' ? record.description : undefined,
    });
  }
  return params;
}

/* -------------------------------------------------------------------------- */
/* 3.x                                                                        */
/* -------------------------------------------------------------------------- */

function buildV3Channels(
  channels: JsonRecord,
  operations: JsonRecord,
  defaultGroup: ChannelGroupIR,
  groups: Map<string, ChannelGroupIR>,
  ensureGroup: EnsureGroup,
  usedNames: Set<string>,
  perspective: AsyncApiPerspective,
  naming: EventNamingOptions,
  spec: OpenApiSpec,
): void {
  const channelEntries = Object.entries(channels).filter(
    ([, value]) => typeof value === 'object' && value !== null,
  ) as Array<[string, JsonRecord]>;
  const channelByName = new Map(channelEntries);

  // Channels without any operation: emit their messages as inbound (the
  // common case for server → client streams described without operations).
  const seenChannels = new Set<string>();

  for (const [opName, rawOp] of Object.entries(operations)) {
    if (typeof rawOp !== 'object' || rawOp === null) continue;
    const operation = rawOp as JsonRecord;
    const action = typeof operation.action === 'string' ? operation.action : '';
    if (action !== 'send' && action !== 'receive') continue;

    const channelRef = operation.channel;
    const channelName =
      typeof channelRef === 'object' && channelRef !== null
        ? refTail((channelRef as JsonRecord).$ref) ?? (typeof (channelRef as JsonRecord).name === 'string' ? (channelRef as JsonRecord).name as string : undefined)
        : undefined;
    const resolvedChannelName = channelName ?? opName;
    const channel = channelByName.get(resolvedChannelName);
    seenChannels.add(resolvedChannelName);
    if (!channel) continue;

    const domain =
      typeof channel['x-client-domain'] === 'string' ? (channel['x-client-domain'] as string) : '';
    const group = domain ? ensureGroup(domain) : defaultGroup;
    const address =
      typeof channel.address === 'string' && channel.address.length > 0 ? channel.address : resolvedChannelName;
    const topic = address.replace(/\{([^}]+)\}/g, (_m, param: string) => `:${param}`);
    const params = paramsFromV2Parameters(channel.parameters as JsonRecord | undefined);

    // Message refs: the trailing pointer segment names the message; the
    // object itself is resolved through the (dereferenced) ref target.
    const messages: MessageSource[] = [];
    const messageList = operation.messages;
    if (Array.isArray(messageList)) {
      for (const entry of messageList) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as JsonRecord;
        const resolved = dereference(record, spec) as JsonRecord;
        const refName = refTail(record.$ref);
        messages.push(
          refName ? { __name: refName, ...resolved } : (resolved as unknown as MessageSource),
        );
      }
    }
    if (messages.length === 0) {
      const channelMessages = channel.messages;
      if (typeof channelMessages === 'object' && channelMessages !== null) {
        for (const [messageName, rawMessage] of Object.entries(channelMessages as JsonRecord)) {
          if (typeof rawMessage !== 'object' || rawMessage === null) continue;
          messages.push({ __name: messageName, ...(rawMessage as object) } as MessageSource);
        }
      }
    }

    // 3.x `action` is from the document perspective: `send` = this side sends.
    const direction: 'in' | 'out' =
      (action === 'send') === (perspective === 'server') ? 'in' : 'out';

    emitChannelMethods({
      topic,
      direction,
      params,
      description:
        typeof operation.description === 'string' ? operation.description : undefined,
      channelLabel: resolvedChannelName,
      eventNameOverride:
        typeof channel['x-client-event-name'] === 'string'
          ? (channel['x-client-event-name'] as string)
          : undefined,
      messages,
      group,
      usedNames,
      naming,
      methodName: opName,
    });
  }

  // Channels without any operation: emit their messages as inbound (the
  // common case for server → client streams described without operations).
  for (const [channelName, channel] of channelEntries) {
    if (seenChannels.has(channelName)) continue;
    const channelMessages = channel.messages;
    if (typeof channelMessages !== 'object' || channelMessages === null) continue;
    const address =
      typeof channel.address === 'string' && channel.address.length > 0 ? channel.address : channelName;
    const topic = address.replace(/\{([^}]+)\}/g, (_m, param: string) => `:${param}`);
    const messages: MessageSource[] = [];
    for (const [messageName, rawMessage] of Object.entries(channelMessages as JsonRecord)) {
      if (typeof rawMessage !== 'object' || rawMessage === null) continue;
      messages.push({ __name: messageName, ...(rawMessage as object) } as MessageSource);
    }
    if (messages.length === 0) continue;
    const domain =
      typeof channel['x-client-domain'] === 'string' ? (channel['x-client-domain'] as string) : '';
    emitChannelMethods({
      topic,
      direction: 'in',
      params: paramsFromV2Parameters(channel.parameters as JsonRecord | undefined),
      description: typeof channel.description === 'string' ? channel.description : undefined,
      channelLabel: channelName,
      eventNameOverride:
        typeof channel['x-client-event-name'] === 'string'
          ? (channel['x-client-event-name'] as string)
          : undefined,
      messages,
      group: domain ? ensureGroup(domain) : defaultGroup,
      usedNames,
      naming,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Shared channel construction                                                 */
/* -------------------------------------------------------------------------- */

interface MessageSource {
  __name?: string;
  [key: string]: unknown;
}

function emitChannelMethods(input: {
  topic: string;
  direction: 'in' | 'out';
  params: ParamIR[];
  description?: string;
  channelLabel: string;
  eventNameOverride?: string;
  messages: MessageSource[];
  group: ChannelGroupIR;
  usedNames: Set<string>;
  naming: EventNamingOptions;
  /** 3.x operation key — the operationId equivalent, preferred as method name. */
  methodName?: string;
}): void {
  const { topic, direction, params, description, channelLabel, eventNameOverride, messages, group, usedNames, methodName, naming } =
    input;
  const prefix = direction === 'in' ? (naming.handlerPrefix ?? 'on') : 'publish';
  const eventAlias = normalizeEventName(eventNameOverride ?? channelLabel, naming);
  const nameBase = eventNameOverride ?? eventAlias;

  if (messages.length === 0) {
    // Channel with no message detail — still useful as an untyped channel.
    const name = uniqueName(methodName ?? `${prefix}${toPascalCase(nameBase)}`, usedNames);
    group.channels.push({ name, topic, direction, description, params, fields: [], eventAlias });
    return;
  }

  if (messages.length > 1) {
    // Multi-message channel: one method carrying a union of message types
    // (the emitter generates the per-message interfaces + union).
    const name = uniqueName(methodName ?? `${prefix}${toPascalCase(nameBase)}`, usedNames);
    group.channels.push({
      name,
      topic,
      direction,
      description,
      params,
      fields: [],
      eventAlias,
      messages: messages.map((message) => ({
        name: messageNameOf(message, channelLabel),
        fields: fieldsFromPayload(message.payload as JsonRecord | undefined),
        description: typeof message.description === 'string' ? message.description : undefined,
      })),
    });
    return;
  }

  for (const message of messages) {
    const messageName = messageNameOf(message, channelLabel);
    const base =
      methodName && messages.length === 1
        ? methodName
        : `${prefix}${toPascalCase(normalizeEventName(messageName, naming))}`;
    const name = uniqueName(base, usedNames);
    const fields = fieldsFromPayload(message.payload as JsonRecord | undefined);
    const messageDescription =
      typeof message.description === 'string' ? message.description : undefined;
    group.channels.push({
      name,
      topic,
      direction,
      description: messageDescription ?? description,
      params,
      fields,
      eventAlias: normalizeEventName(messageName, naming),
    });
  }
}

function messageNameOf(message: MessageSource, channelLabel: string): string {
  return (
    (typeof message.__name === 'string' && message.__name) ||
    (typeof message.name === 'string' && message.name) ||
    (typeof message.title === 'string' && message.title) ||
    channelLabel
  );
}

/** Converts a JSON-schema payload into message fields (object payloads only). */
function fieldsFromPayload(payload: JsonRecord | undefined): ParamIR[] {
  if (!payload || typeof payload !== 'object') return [];
  const schema: SchemaIR = schemaFrom(payload);
  if (schema.type !== 'object' || !schema.properties) return [];
  const requiredProps = new Set(schema.requiredProps ?? []);
  return Object.entries(schema.properties).map(([propName, propSchema]) => ({
    tsName: toCamelCase(propName),
    wireName: propName,
    location: 'body' as const,
    schema: propSchema,
    required: requiredProps.has(propName),
    description:
      typeof propSchema.description === 'string' ? propSchema.description : undefined,
  }));
}
