/**
 * The canonical API model — the hub every format adapter normalizes into
 * and every emitter reads from.
 *
 * HTTP operations (OpenAPI / Swagger / Postman / GraphQL queries) land in
 * `groups` (the OpenAPI IR); event channels (AsyncAPI / GraphQL
 * subscriptions) land in `channelGroups`. The model serializes to JSON so
 * it can round-trip: `kind: 'api-model'` documents are themselves a valid
 * codegen input.
 */

import type { ApiGroupIR, ApiIR, ParamIR } from './openapi.js';

/** Every input format the codegen understands. */
export type SpecKind = 'openapi' | 'asyncapi' | 'postman' | 'graphql' | 'api-model';

/* -------------------------------------------------------------------------- */
/* Channel IR                                                                  */
/* -------------------------------------------------------------------------- */

/** One typed event channel. `in` = client subscribes, `out` = client publishes. */
export interface ChannelIR {
  /** Client method name, e.g. `onOrderCreated` / `publishOrderCreate`. */
  name: string;
  /** Wire topic; `:param` segments are interpolated (`order/:id/created`). */
  topic: string;
  direction: 'in' | 'out';
  description?: string;
  /** Topic parameters (from `{param}` address segments). */
  params: ParamIR[];
  /** Message payload fields. */
  fields: ParamIR[];
}

export interface ChannelGroupIR {
  /** Raw group name, sanitized. */
  name: string;
  /** Exported `defineEvents` constant name. */
  constName: string;
  /** Emitted file name. */
  fileName: string;
  channels: ChannelIR[];
}

export interface EventsIR {
  title: string;
  version?: string;
  url: string;
  groups: ChannelGroupIR[];
}

/* -------------------------------------------------------------------------- */
/* Canonical model                                                             */
/* -------------------------------------------------------------------------- */

export interface CanonicalModel {
  kind: 'contractful-api-model';
  modelVersion: 1;
  name: string;
  specVersion?: string;
  /** HTTP base URL or WebSocket URL. */
  base: string;
  /** Human-readable origin (source path / URL) for headers. */
  origin?: string;
  groups: ApiGroupIR[];
  channelGroups: ChannelGroupIR[];
}

export function modelFromHttpIr(ir: ApiIR, origin?: string): CanonicalModel {
  return {
    kind: 'contractful-api-model',
    modelVersion: 1,
    name: ir.title,
    specVersion: ir.version,
    base: ir.base,
    origin,
    groups: ir.groups,
    channelGroups: [],
  };
}

export function modelFromEventsIr(ir: EventsIR, origin?: string): CanonicalModel {
  return {
    kind: 'contractful-api-model',
    modelVersion: 1,
    name: ir.title,
    specVersion: ir.version,
    base: ir.url,
    origin,
    groups: [],
    channelGroups: ir.groups,
  };
}

export function httpIrFromModel(model: CanonicalModel): ApiIR {
  return {
    title: model.name,
    version: model.specVersion,
    base: model.base,
    groups: model.groups,
  };
}

export function eventsIrFromModel(model: CanonicalModel): EventsIR {
  return {
    title: model.name,
    version: model.specVersion,
    url: model.base,
    groups: model.channelGroups,
  };
}

/** Serializes a model to deterministic, pretty-printed JSON. */
export function serializeModel(model: CanonicalModel): string {
  return `${JSON.stringify(sortKeys(model), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Parses and validates a serialized canonical model. */
export function parseModel(text: string): CanonicalModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`api-model: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { kind?: unknown }).kind !== 'contractful-api-model'
  ) {
    throw new Error("api-model: missing kind === 'contractful-api-model'");
  }
  const model = parsed as CanonicalModel;
  if (!Array.isArray(model.groups) || !Array.isArray(model.channelGroups)) {
    throw new Error('api-model: groups and channelGroups must be arrays');
  }
  return model;
}

/** Merges models produced by multiple sources (namespaces keep them apart). */
export function mergeModels(models: CanonicalModel[]): CanonicalModel {
  if (models.length === 0) {
    return { kind: 'contractful-api-model', modelVersion: 1, name: 'api', base: '', groups: [], channelGroups: [] };
  }
  const [first, ...rest] = models;
  const merged: CanonicalModel = { ...first!, groups: [...first!.groups], channelGroups: [...first!.channelGroups] };
  for (const model of rest) {
    merged.groups.push(...model.groups);
    merged.channelGroups.push(...model.channelGroups);
  }
  return merged;
}
