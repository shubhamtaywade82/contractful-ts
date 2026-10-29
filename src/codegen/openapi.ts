/**
 * OpenAPI document loading and translation into a generator-friendly
 * intermediate representation (IR).
 *
 * Supports OpenAPI 3.x and a pragmatic subset of Swagger 2.0, from JSON or
 * YAML sources, with local `$ref` dereferencing (external references are
 * rejected with a clear error).
 */

import { readFile } from 'node:fs/promises';
import { parseYaml, YamlParseError } from './yaml.js';

/* -------------------------------------------------------------------------- */
/* Raw spec shapes (loose)                                                     */
/* -------------------------------------------------------------------------- */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonRecord = { [key: string]: Json };

export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  servers?: Json[];
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: JsonRecord;
  components?: JsonRecord;
  definitions?: JsonRecord;
  parameters?: JsonRecord;
  [key: string]: Json | undefined;
}

export class OpenApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiError';
  }
}

/** Loads a spec from a file path, an http(s) URL, or a raw document string. */
export async function loadSpec(source: string): Promise<OpenApiSpec> {
  let text: string;
  const isUrl = /^https?:\/\//i.test(source);

  if (isUrl) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new OpenApiError(`Fetching ${source} failed with HTTP ${res.status}`);
    }
    text = await res.text();
  } else {
    try {
      text = await readFile(source, 'utf8');
    } catch (err) {
      throw new OpenApiError(
        `Could not read spec file ${source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return parseSpecText(text, source);
}

/** Parses raw spec text (JSON or YAML) into a document object. */
export function parseSpecText(text: string, origin = 'spec'): OpenApiSpec {
  const trimmed = text.trim();
  let parsed: unknown;
  if (trimmed.startsWith('{')) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new OpenApiError(
        `Invalid JSON in ${origin}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    try {
      parsed = parseYaml(trimmed);
    } catch (err) {
      if (err instanceof YamlParseError) {
        throw new OpenApiError(
          `Could not parse YAML in ${origin}: ${err.message}. ` +
            'If the spec uses anchors/aliases or other advanced YAML, convert it to JSON first.',
        );
      }
      throw err;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OpenApiError(`${origin} did not parse into an object`);
  }
  return parsed as OpenApiSpec;
}

/* -------------------------------------------------------------------------- */
/* $ref resolution                                                             */
/* -------------------------------------------------------------------------- */

const MAX_REF_DEPTH = 64;

/**
 * Deeply dereferences local `$ref` pointers (`#/components/schemas/Foo`).
 * Cycles are broken by leaving a `{}` placeholder.
 */
export function dereference<T>(node: T, spec: OpenApiSpec): T {
  return dereferenceNode(node as Json, spec, 0, new Set<string>()) as T;
}

function dereferenceNode(node: Json, spec: OpenApiSpec, depth: number, seen: Set<string>): Json {
  if (depth > MAX_REF_DEPTH) return {};
  if (Array.isArray(node)) {
    return node.map((item) => dereferenceNode(item, spec, depth + 1, seen));
  }
  if (typeof node !== 'object' || node === null) return node;

  const ref = node.$ref;
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/')) {
      throw new OpenApiError(
        `External $ref ${JSON.stringify(ref)} is not supported — inline it or convert the spec to a single file.`,
      );
    }
    if (seen.has(ref)) return {};
    const target = resolvePointer(ref, spec);
    return dereferenceNode(target, spec, depth + 1, new Set([...seen, ref]));
  }

  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = dereferenceNode(value, spec, depth + 1, seen);
  }
  return out;
}

function resolvePointer(pointer: string, spec: OpenApiSpec): Json {
  const parts = pointer.slice(2).split('/').map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
  let current: Json = spec as unknown as Json;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      throw new OpenApiError(`Unresolvable $ref pointer ${pointer}`);
    }
    const next: Json | undefined = (current as JsonRecord)[part];
    if (next === undefined) {
      throw new OpenApiError(`Unresolvable $ref pointer ${pointer} (missing key ${JSON.stringify(part)})`);
    }
    current = next;
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* Intermediate representation                                                 */
/* -------------------------------------------------------------------------- */

export interface SchemaIR {
  type?: string;
  format?: string;
  enumValues?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: SchemaIR;
  description?: string;
  properties?: Record<string, SchemaIR>;
  requiredProps?: string[];
}

export type ParamLocationIR = 'path' | 'query' | 'header' | 'body';

export interface ParamIR {
  tsName: string;
  wireName: string;
  location: ParamLocationIR;
  schema: SchemaIR;
  required: boolean;
  description?: string;
}

export interface ResponseIR {
  status: number;
  type?: 'array' | 'hash' | 'string' | 'number' | 'boolean';
}

export interface OperationIR {
  name: string;
  method: string;
  path: string;
  description?: string;
  summary?: string;
  tags: string[];
  params: ParamIR[];
  responds: ResponseIR[];
}

export interface ApiGroupIR {
  /** Raw group name (tag or path segment), sanitized. */
  name: string;
  /** Exported `defineApi` constant name. */
  constName: string;
  /** Emitted file name. */
  fileName: string;
  operations: OperationIR[];
}

export interface ApiIR {
  title: string;
  version?: string;
  base: string;
  groups: ApiGroupIR[];
}

export interface BuildIROptions {
  /** Overrides the server base URL from the spec. */
  base?: string;
  /** Group contracts by first tag (default) or by first path segment. */
  groupBy?: 'tag' | 'path';
}

const VERBS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;

/** Builds the generator IR from a parsed OpenAPI document. */
export function buildApiIR(spec: OpenApiSpec, options: BuildIROptions = {}): ApiIR {
  const isV2 = spec.swagger?.startsWith('2') ?? false;
  const title = (spec.info?.title ?? 'Api').trim() || 'Api';
  const version = spec.info?.version;

  let base = options.base;
  if (!base) {
    if (isV2) {
      const scheme = Array.isArray(spec.schemes) && spec.schemes[0] ? String(spec.schemes[0]) : 'https';
      base = `${scheme}://${spec.host ?? 'localhost'}${spec.basePath ?? ''}`;
    } else {
      const server = Array.isArray(spec.servers) ? spec.servers[0] : undefined;
      const url = server && typeof server === 'object' ? (server as JsonRecord).url : undefined;
      base = typeof url === 'string' && url.length > 0 ? url : 'https://example.com';
    }
  }
  base = base.replace(/\/+$/, '');

  const paths = dereference(spec.paths ?? {}, spec) as JsonRecord;
  const groupBy = options.groupBy ?? 'tag';
  const groups = new Map<string, ApiGroupIR>();

  for (const [rawPath, rawItem] of Object.entries(paths)) {
    if (typeof rawItem !== 'object' || rawItem === null) continue;
    const pathItem = rawItem as JsonRecord;

    for (const verb of VERBS) {
      const rawOp = pathItem[verb];
      if (typeof rawOp !== 'object' || rawOp === null) continue;
      const op = rawOp as JsonRecord;
      const operation = buildOperation(verb.toUpperCase(), rawPath, pathItem, op, isV2);
      if (!operation) continue;

      const groupName = pickGroup(operation, pathItem, groupBy);
      const group = ensureGroup(groups, groupName);
      const used = new Set(group.operations.map((o) => o.name));
      operation.name = uniqueName(operation.name, used);
      group.operations.push(operation);
    }
  }

  return {
    title,
    version,
    base,
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function pickGroup(op: OperationIR, pathItem: JsonRecord, groupBy: 'tag' | 'path'): string {
  if (groupBy === 'path') {
    const first = op.path.split('/').find((seg) => seg.length > 0 && !seg.startsWith(':'));
    return sanitizeGroup(first ?? 'root');
  }
  const tag = op.tags[0] ?? (typeof pathItem.tags === 'object' && pathItem.tags !== null && Array.isArray(pathItem.tags)
    ? String((pathItem.tags as Json[])[0])
    : undefined);
  return sanitizeGroup(tag ?? 'default');
}

function buildOperation(
  method: string,
  rawPath: string,
  pathItem: JsonRecord,
  op: JsonRecord,
  isV2: boolean,
): OperationIR | null {
  // Route: {param} → :param
  const path = rawPath.replace(/\{([^}]+)\}/g, (_m, name: string) => `:${name}`);

  // Method name
  const operationId = typeof op.operationId === 'string' ? op.operationId : null;
  const name = operationId ?? methodNameFromPath(method, path);

  // Params
  const params: ParamIR[] = [];
  const rawParams = Array.isArray(op.parameters)
    ? op.parameters
    : Array.isArray(pathItem.parameters)
      ? pathItem.parameters
      : [];

  const pathParamNames = [...rawPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

  for (const raw of rawParams) {
    if (typeof raw !== 'object' || raw === null) continue;
    const p = raw as JsonRecord;
    const wireName = String(p.name ?? '');
    if (!wireName) continue;
    const in_ = String(p.in ?? 'query') as 'query' | 'path' | 'header' | 'body' | 'formData';
    const required = p.required === true || in_ === 'path';

    if (in_ === 'body') {
      // Swagger 2.0 body: a single (usually object) schema.
      const schema = schemaFrom(p.schema as JsonRecord | undefined);
      if (schema.properties && Object.keys(schema.properties).length > 0) {
        const requiredProps = new Set(schema.requiredProps ?? []);
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          params.push({
            tsName: toCamelCase(propName),
            wireName: propName,
            location: 'body',
            schema: propSchema,
            required: requiredProps.has(propName),
          });
        }
      } else {
        params.push({
          tsName: 'body',
          wireName: 'body',
          location: 'body',
          schema,
          required,
        });
      }
      continue;
    }

    const location: ParamLocationIR =
      in_ === 'path' ? 'path' : in_ === 'header' ? 'header' : 'query'; // formData → query
    params.push({
      tsName: toCamelCase(wireName),
      wireName,
      location,
      // OpenAPI 3 keeps the schema under `schema`; Swagger 2.0 inlines it.
      schema: schemaFrom((p.schema ?? p) as JsonRecord),
      required,
      description: typeof p.description === 'string' ? p.description : undefined,
    });
  }

  // OpenAPI 3 requestBody
  if (!isV2 && op.requestBody && typeof op.requestBody === 'object') {
    const body = op.requestBody as JsonRecord;
    const required = body.required === true;
    const jsonContent =
      body.content && typeof body.content === 'object'
        ? ((body.content as JsonRecord)['application/json'] as JsonRecord | undefined) ??
          firstEntry(body.content as JsonRecord)
        : undefined;
    const schema = schemaFrom(jsonContent?.schema as JsonRecord | undefined);
    if (schema.properties && Object.keys(schema.properties).length > 0) {
      const requiredProps = new Set(schema.requiredProps ?? []);
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        params.push({
          tsName: toCamelCase(propName),
          wireName: propName,
          location: 'body',
          schema: propSchema,
          required: requiredProps.has(propName) || (pathParamNames.includes(propName) && false),
        });
      }
    } else {
      params.push({ tsName: 'body', wireName: 'body', location: 'body', schema, required });
    }
  }

  // Declared path params must exist even when `parameters` omits them.
  for (const pp of pathParamNames) {
    if (!params.some((p) => p.location === 'path' && p.wireName === pp)) {
      params.push({
        tsName: toCamelCase(pp),
        wireName: pp,
        location: 'path',
        schema: { type: 'string' },
        required: true,
      });
    }
  }

  // Responses
  const responds: ResponseIR[] = [];
  const rawResponses = op.responses && typeof op.responses === 'object' ? (op.responses as JsonRecord) : {};
  for (const [code, raw] of Object.entries(rawResponses)) {
    if (code === 'default' || !/^\d{3}$/.test(code)) continue;
    if (typeof raw !== 'object' || raw === null) continue;
    const resp = raw as JsonRecord;
    let type: ResponseIR['type'];
    const content =
      resp.content && typeof resp.content === 'object'
        ? ((resp.content as JsonRecord)['application/json'] as JsonRecord | undefined) ??
          firstEntry(resp.content as JsonRecord)
        : undefined;
    const schema = schemaFrom(
      (content?.schema ?? (isV2 ? (resp.schema as JsonRecord | undefined) : undefined)) as
        | JsonRecord
        | undefined,
    );
    if (schema.type === 'array') type = 'array';
    else if (schema.type === 'object') type = 'hash';
    else if (schema.type === 'string') type = 'string';
    else if (schema.type === 'integer' || schema.type === 'number') type = 'number';
    else if (schema.type === 'boolean') type = 'boolean';
    responds.push({ status: Number.parseInt(code, 10), type });
  }

  const description = typeof op.description === 'string' ? op.description : undefined;
  const summary = typeof op.summary === 'string' ? op.summary : undefined;
  const tags = Array.isArray(op.tags)
    ? op.tags.filter((t): t is string => typeof t === 'string')
    : [];

  return { name, method, path, description, summary, tags, params, responds };
}

function firstEntry(record: JsonRecord): JsonRecord | undefined {
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  }
  return undefined;
}

function schemaFrom(raw: JsonRecord | undefined): SchemaIR {
  if (!raw || typeof raw !== 'object') return {};
  const out: SchemaIR = {};
  if (typeof raw.type === 'string') out.type = raw.type;
  if (typeof raw.format === 'string') out.format = raw.format;
  if (Array.isArray(raw.enum)) out.enumValues = raw.enum;
  if ('default' in raw) out.default = raw.default as Json | undefined;
  if (typeof raw.minimum === 'number') out.minimum = raw.minimum;
  if (typeof raw.maximum === 'number') out.maximum = raw.maximum;
  if (typeof raw.minLength === 'number') out.minLength = raw.minLength;
  if (typeof raw.maxLength === 'number') out.maxLength = raw.maxLength;
  if (typeof raw.pattern === 'string') out.pattern = raw.pattern;
  if (typeof raw.description === 'string') out.description = raw.description;
  if (raw.items && typeof raw.items === 'object') {
    out.items = schemaFrom(raw.items as JsonRecord);
  }
  if (raw.properties && typeof raw.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(raw.properties as JsonRecord)) {
      out.properties[k] = schemaFrom(v as JsonRecord);
    }
  }
  if (Array.isArray(raw.required)) {
    out.requiredProps = raw.required.filter((r): r is string => typeof r === 'string');
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Naming helpers                                                              */
/* -------------------------------------------------------------------------- */

export function toCamelCase(input: string): string {
  const parts = input
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean);
  if (parts.length === 0) return 'value';
  const [first, ...rest] = parts;
  return (
    first!.toLowerCase() +
    rest.map((p) => p[0]!.toUpperCase() + p.slice(1)).join('')
  );
}

function toPascalCase(input: string): string {
  const camel = toCamelCase(input);
  return camel[0]!.toUpperCase() + camel.slice(1);
}

function toKebabCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'group';
}

function sanitizeGroup(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'default';
}

function sanitizeIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_$]+/g, '_').replace(/^(\d)/, '_$1');
  const reserved = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
    'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
    'with', 'yield', 'let', 'static', 'await', 'delete',
  ]);
  return reserved.has(cleaned) ? `${cleaned}_` : cleaned;
}

function methodNameFromPath(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(':') ? `By${toPascalCase(s.slice(1))}` : toPascalCase(s.replace(/\./g, '-'))));
  return toCamelCase(`${method} ${segments.join(' ')}`);
}

function uniqueName(base: string, used: Set<string>): string {
  const candidate = sanitizeIdentifier(base);
  if (!used.has(candidate)) return candidate;
  let i = 2;
  while (used.has(`${candidate}${i}`)) i++;
  return `${candidate}${i}`;
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
