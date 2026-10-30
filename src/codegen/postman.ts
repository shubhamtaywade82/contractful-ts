/**
 * Postman Collection v2.0/v2.1 adapter — turns existing request collections
 * into contract modules.
 *
 * Postman collections are examples, not contracts: they often lack response
 * schemas, required-field information and reusable types. This adapter is
 * therefore conservative — types inferred from request/response examples are
 * marked "(inferred from example)" in the emitted descriptions, and
 * operations without any example stay loosely typed.
 */

import {
  sanitizeGroup,
  toCamelCase,
  toKebabCase,
  uniqueName,
  type Json,
  type JsonRecord,
  type ApiGroupIR,
  type ApiIR,
  type OperationIR,
  type ParamIR,
  type ResponseIR,
  type SchemaIR,
} from './openapi.js';

export interface BuildPostmanIROptions {
  /** Overrides the base URL (collections usually keep it in a `{{baseUrl}}` variable). */
  base?: string;
}

export class PostmanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostmanError';
  }
}

/** Builds the HTTP IR from a parsed Postman collection (v2.0 or v2.1). */
export function buildPostmanIR(
  collection: JsonRecord,
  options: BuildPostmanIROptions = {},
): ApiIR {
  // Malformed-spec gate: mirroring `buildApiIR`, a document without the
  // collection shape must fail loudly instead of emitting an empty client.
  const info = collection.info;
  const infoRecord = typeof info === 'object' && info !== null ? (info as JsonRecord) : null;
  const looksLikeCollection =
    infoRecord !== null &&
    typeof infoRecord.name === 'string' &&
    (Array.isArray(collection.item) ||
      infoRecord._postman_id !== undefined ||
      typeof infoRecord.schema === 'string');
  if (!looksLikeCollection) {
    throw new PostmanError(
      'Document does not look like a Postman Collection v2.x: expected an `info` object ' +
        '(with `name`) and an `item` array (or a `schema`/`_postman_id` marker). ' +
        'If this is another format, let the CLI auto-detect it or pass --format explicitly.',
    );
  }
  const title =
    typeof info === 'object' && info !== null && typeof (info as JsonRecord).name === 'string'
      ? ((info as JsonRecord).name as string).trim() || 'PostmanApi'
      : 'PostmanApi';

  const variables = collectionVariables(collection);
  const groups = new Map<string, ApiGroupIR>();
  const authNotes = new Set<string>();
  collectAuth(collection.auth, authNotes);

  const usedBaseUrl = firstBaseUrl(variables);
  const base = (options.base ?? usedBaseUrl ?? 'https://example.com').replace(/\/+$/, '');

  const items = Array.isArray(collection.item) ? collection.item : [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as JsonRecord;
    if (Array.isArray(record.item)) {
      walkFolder(collection, record, [] as string[], groups, variables, authNotes);
    } else if (record.request) {
      const name = typeof record.name === 'string' ? record.name : 'request';
      addOperation(collection, record, sanitizeGroup(toKebabCase(name)), groups, variables, authNotes);
    }
  }

  return {
    title,
    version: undefined,
    base,
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    notes: [...authNotes].map(
      (type) => `Detected Postman auth "${type}" — configure the equivalent auth resolver on the client.`,
    ),
  };
}

function walkFolder(
  collection: JsonRecord,
  folder: JsonRecord,
  prefix: string[],
  groups: Map<string, ApiGroupIR>,
  variables: Map<string, string>,
  authNotes: Set<string>,
): void {
  const name = typeof folder.name === 'string' ? folder.name : 'folder';
  const path = [...prefix, name];
  collectAuth(folder.auth, authNotes);
  const items = Array.isArray(folder.item) ? folder.item : [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as JsonRecord;
    if (Array.isArray(record.item)) {
      walkFolder(collection, record, path, groups, variables, authNotes);
    } else if (record.request) {
      addOperation(collection, record, sanitizeGroup(toKebabCase(path.join('-'))), groups, variables, authNotes);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

function addOperation(
  collection: JsonRecord,
  item: JsonRecord,
  groupName: string,
  groups: Map<string, ApiGroupIR>,
  variables: Map<string, string>,
  authNotes: Set<string>,
): void {
  const request = item.request;
  if (typeof request !== 'object' || request === null) return;
  const req = request as JsonRecord;
  collectAuth(req.auth, authNotes);

  const itemName = typeof item.name === 'string' ? item.name : 'request';
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
  const parsed = parsePostmanUrl(req.url, variables);

  const group = ensureGroup(groups, groupName);
  const used = new Set(group.operations.map((o) => o.name));
  const name = uniqueName(toCamelCase(itemName) || 'request', used);

  const params: ParamIR[] = [];

  // Path parameters.
  for (const placeholder of parsed.placeholders) {
    const example = parsed.variableExamples.get(placeholder);
    params.push({
      tsName: toCamelCase(placeholder),
      wireName: placeholder,
      location: 'path',
      schema: { type: 'string', ...(example !== undefined ? { description: `e.g. ${example}` } : {}) },
      required: true,
    });
  }

  // Query parameters.
  for (const query of parsed.query) {
    const example = query.value === '' ? undefined : query.value;
    params.push({
      tsName: toCamelCase(query.key),
      wireName: query.key,
      location: 'query',
      schema: inferScalarSchema(query.value),
      required: false,
      description:
        query.description ??
        (example !== undefined ? `(inferred from example) e.g. ${example}` : '(inferred from example)'),
    });
  }

  // Headers.
  const headers = Array.isArray(req.header) ? req.header : [];
  for (const raw of headers) {
    if (typeof raw !== 'object' || raw === null) continue;
    const header = raw as JsonRecord;
    const key = typeof header.key === 'string' ? header.key : '';
    if (!key || header.disabled === true) continue;
    params.push({
      tsName: toCamelCase(key),
      wireName: key,
      location: 'header',
      schema: { type: 'string' },
      required: false,
      description: '(inferred from example) sent by the collection',
    });
  }

  // Body.
  appendBodyParams(req.body, params);

  // Responses (example-inferred).
  const responds: ResponseIR[] = [];
  const responses = Array.isArray(item.response) ? item.response : [];
  const seenStatuses = new Set<number>();
  for (const raw of responses) {
    if (typeof raw !== 'object' || raw === null) continue;
    const response = raw as JsonRecord;
    const code = typeof response.code === 'number' ? response.code : Number(response.code);
    if (!Number.isInteger(code) || seenStatuses.has(code)) continue;
    seenStatuses.add(code);
    responds.push({ status: code, type: inferTopLevelType(response.body) });
  }

  const description =
    typeof req.description === 'string'
      ? req.description
      : typeof req.body === 'object' && req.body !== null && (req.body as JsonRecord).mode === 'graphql'
        ? 'Postman GraphQL body mode — copy the query manually.'
        : undefined;

  group.operations.push({
    name,
    method,
    path: parsed.path,
    description,
    summary: typeof item.name === 'string' ? item.name : undefined,
    tags: [],
    params,
    responds,
  });
}

function appendBodyParams(body: unknown, params: ParamIR[]): void {
  if (typeof body !== 'object' || body === null) return;
  const record = body as JsonRecord;
  const mode = typeof record.mode === 'string' ? record.mode : '';

  if (mode === 'raw') {
    const raw = typeof record.raw === 'string' ? record.raw.trim() : '';
    if (raw === '') return;
    const options = record.options;
    const language =
      typeof options === 'object' && options !== null && typeof (options as JsonRecord).raw === 'object'
        ? ((options as JsonRecord).raw as JsonRecord).language
        : undefined;
    if (language === 'json') {
      try {
        const parsed: unknown = JSON.parse(raw);
        pushInferredObjectFields(parsed, params);
        return;
      } catch {
        // fall through: treat as opaque string body
      }
    }
    params.push({
      tsName: 'body',
      wireName: 'body',
      location: 'body',
      schema: { type: 'string' },
      required: true,
      description: '(inferred from example) raw body',
    });
    return;
  }

  if (mode === 'urlencoded' || mode === 'formdata') {
    const entries = Array.isArray(record[mode]) ? (record[mode] as Json[]) : [];
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as JsonRecord;
      const key = typeof entry.key === 'string' ? entry.key : '';
      if (!key || entry.disabled === true || entry.type === 'file') continue;
      params.push({
        tsName: toCamelCase(key),
        wireName: key,
        location: 'body',
        schema: inferScalarSchema(typeof entry.value === 'string' ? entry.value : ''),
        required: false,
        description: '(inferred from example) form field',
      });
    }
  }
}

/** Object JSON examples become per-field params; other shapes stay opaque. */
function pushInferredObjectFields(parsed: unknown, params: ParamIR[]): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    params.push({
      tsName: 'body',
      wireName: 'body',
      location: 'body',
      schema: inferSchemaFromValue(parsed),
      required: true,
      description: '(inferred from example)',
    });
    return;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    params.push({
      tsName: toCamelCase(key),
      wireName: key,
      location: 'body',
      schema: inferSchemaFromValue(value),
      required: true,
      description: '(inferred from example)',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* URL parsing                                                                 */
/* -------------------------------------------------------------------------- */

interface ParsedPostmanUrl {
  path: string;
  placeholders: string[];
  query: Array<{ key: string; value: string; description?: string }>;
  variableExamples: Map<string, string>;
  origin?: string;
}

function parsePostmanUrl(url: unknown, variables: Map<string, string>): ParsedPostmanUrl {
  const result: ParsedPostmanUrl = {
    path: '/',
    placeholders: [],
    query: [],
    variableExamples: new Map(),
  };

  // v2.0 shorthand: plain string URL.
  if (typeof url === 'string') {
    const substituted = substituteVariables(url, variables);
    const parsed = new URL(substituted);
    result.path = parsed.pathname || '/';
    collectQueryFromString(parsed.search, result.query);
    result.origin = parsed.origin;
    extractPlaceholders(result.path, result);
    return result;
  }

  if (typeof url !== 'object' || url === null) return result;
  const record = url as JsonRecord;

  // Per-request variable examples.
  const variableList = Array.isArray(record.variable) ? (record.variable as Json[]) : [];
  for (const raw of variableList) {
    if (typeof raw !== 'object' || raw === null) continue;
    const variable = raw as JsonRecord;
    if (typeof variable.key === 'string' && typeof variable.value === 'string') {
      result.variableExamples.set(variable.key, variable.value);
    }
  }

  const protocol =
    typeof record.protocol === 'string' && record.protocol.length > 0 ? record.protocol : 'https';
  const host = Array.isArray(record.host)
    ? (record.host as Json[]).filter((s): s is string => typeof s === 'string')
    : [];
  const pathSegments = Array.isArray(record.path)
    ? (record.path as Json[]).filter((s): s is string => typeof s === 'string')
    : [];

  // {{baseUrl}} as the first host segment carries scheme + host (+ prefix).
  let origin = `${protocol}://`;
  const pathPrefix: string[] = [];
  let hostIndex = 0;
  if (host.length > 0 && /^\{\{.*\}\}$/.test(host[0]!)) {
    const value = variables.get(host[0]!.slice(2, -2));
    if (value && /^https?:\/\//i.test(value)) {
      origin = value.replace(/\/+$/, '');
      hostIndex = 1;
    }
  }
  if (hostIndex === 0 && host.length > 0) {
    origin += host.join('.');
  }
  result.origin = origin;

  const allSegments = [...host.slice(hostIndex === 0 ? 1 : hostIndex), ...pathSegments];
  const resolvedSegments = allSegments.map((segment) => {
    const substituted = substituteVariables(segment, variables);
    return substituted;
  });
  result.path = `/${resolvedSegments.join('/')}`.replace(/\/+$/, '') || '/';
  extractPlaceholders(result.path, result);

  const queryList = Array.isArray(record.query) ? (record.query as Json[]) : [];
  for (const raw of queryList) {
    if (typeof raw !== 'object' || raw === null) continue;
    const query = raw as JsonRecord;
    if (typeof query.key !== 'string') continue;
    if (query.disabled === true) continue;
    result.query.push({
      key: substituteVariables(query.key, variables),
      value: substituteVariables(typeof query.value === 'string' ? query.value : '', variables),
      description: typeof query.description === 'string' ? query.description : undefined,
    });
  }

  return result;
}

function extractPlaceholders(path: string, result: ParsedPostmanUrl): void {
  result.placeholders = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

function collectQueryFromString(search: string, out: Array<{ key: string; value: string }>): void {
  const params = new URLSearchParams(search);
  for (const [key, value] of params.entries()) {
    out.push({ key, value });
  }
}

function substituteVariables(text: string, variables: Map<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_m, key: string) => variables.get(key.trim()) ?? `:${key.trim()}`);
}

/* -------------------------------------------------------------------------- */
/* Inference                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Infers a schema from a JSON example value. Only true JSON types map to
 * typed schemas; strings stay strings even when numeric-looking (ZIP codes,
 * phone numbers, ...). Everything inferred is marked in descriptions by the
 * caller.
 */
export function inferSchemaFromValue(value: unknown): SchemaIR {
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'float' };
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string') return { type: 'string' };
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined);
    return {
      type: 'array',
      items: first !== undefined ? inferSchemaFromValue(first) : undefined,
    };
  }
  if (typeof value === 'object' && value !== null) {
    const properties: Record<string, SchemaIR> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = inferSchemaFromValue(child);
    }
    return {
      type: 'object',
      properties,
      // Present-in-example keys are the best guess for required fields.
      requiredProps: Object.keys(properties),
    };
  }
  return {};
}

function inferScalarSchema(value: string): SchemaIR {
  // Deliberately conservative: never infer numbers from numeric strings.
  return { type: 'string', ...(value !== '' ? { default: value } : {}) };
}

function inferTopLevelType(body: unknown): ResponseIR['type'] {
  if (typeof body !== 'string' || body.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) return 'array';
    if (typeof parsed === 'object' && parsed !== null) return 'hash';
    if (typeof parsed === 'string') return 'string';
    if (typeof parsed === 'number') return 'number';
    if (typeof parsed === 'boolean') return 'boolean';
    return undefined;
  } catch {
    return 'string';
  }
}

/* -------------------------------------------------------------------------- */
/* Collection metadata                                                         */
/* -------------------------------------------------------------------------- */

function collectionVariables(collection: JsonRecord): Map<string, string> {
  const variables = new Map<string, string>();
  const list = Array.isArray(collection.variable) ? (collection.variable as Json[]) : [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const variable = raw as JsonRecord;
    if (typeof variable.key === 'string' && typeof variable.value === 'string') {
      variables.set(variable.key, variable.value);
    }
  }
  return variables;
}

function firstBaseUrl(variables: Map<string, string>): string | undefined {
  for (const key of ['baseUrl', 'base_url', 'url', 'host']) {
    const value = variables.get(key);
    if (value && /^https?:\/\//i.test(value)) return value;
  }
  return undefined;
}

function collectAuth(auth: unknown, notes: Set<string>): void {
  if (typeof auth !== 'object' || auth === null) return;
  const type = (auth as JsonRecord).type;
  if (typeof type === 'string' && type.length > 0 && type !== 'noauth') {
    notes.add(type);
  }
}

function ensureGroup(groups: Map<string, ApiGroupIR>, name: string): ApiGroupIR {
  let group = groups.get(name);
  if (!group) {
    group = {
      name,
      constName: `${toCamelCase(name)}Api`,
      fileName: `${toKebabCase(name)}.ts`,
      operations: [],
    };
    groups.set(name, group);
  }
  return group;
}
