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

/** Reads a spec source (http(s) URL or file path) as raw text. */
export async function readSourceText(source: string): Promise<string> {
  const isUrl = /^https?:\/\//i.test(source);
  if (isUrl) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new OpenApiError(`Fetching ${source} failed with HTTP ${res.status}`);
    }
    return res.text();
  }
  try {
    return await readFile(source, 'utf8');
  } catch (err) {
    throw new OpenApiError(
      `Could not read spec file ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  } else if (!source.includes('\n') && !source.trimStart().startsWith('{')) {
    // Single-line, non-JSON source: treat as a file path even when the file
    // is missing so the error message names the path.
    text = await readSourceText(source);
  } else {
    text = source;
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

/** Optional warning sink used while translating a spec into the IR. */
export interface SchemaWarnCtx {
  warn(message: string): void;
}

/**
 * Deeply dereferences local `$ref` pointers (`#/components/schemas/Foo`).
 * Cycles are broken by substituting a free-form object placeholder (typed as
 * `P.hash()` — never a silently-wrong scalar) and recording a warning.
 */
export function dereference<T>(node: T, spec: OpenApiSpec, warnings?: string[]): T {
  return dereferenceNode(node as Json, spec, 0, new Set<string>(), warnings) as T;
}

function dereferenceNode(
  node: Json,
  spec: OpenApiSpec,
  depth: number,
  seen: Set<string>,
  warnings?: string[],
): Json {
  if (depth > MAX_REF_DEPTH) {
    warnings?.push(`$ref nesting deeper than ${MAX_REF_DEPTH} — emitted as a free-form object`);
    return { type: 'object', description: 'deeply nested schema — free-form' };
  }
  if (Array.isArray(node)) {
    return node.map((item) => dereferenceNode(item, spec, depth + 1, seen, warnings));
  }
  if (typeof node !== 'object' || node === null) return node;

  const ref = node.$ref;
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/')) {
      throw new OpenApiError(
        `External $ref ${JSON.stringify(ref)} is not supported — inline it or convert the spec to a single file.`,
      );
    }
    if (seen.has(ref)) {
      warnings?.push(
        `recursive $ref ${ref} — the cycle is cut and the affected parameter is emitted as a free-form object`,
      );
      return { type: 'object', description: `recursive schema (${ref}) — free-form` };
    }
    const target = resolvePointer(ref, spec);
    return dereferenceNode(target, spec, depth + 1, new Set([...seen, ref]), warnings);
  }

  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = dereferenceNode(value, spec, depth + 1, seen, warnings);
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
  /** `oneOf` / `anyOf` / conflicting `allOf` types — any value accepted. */
  untyped?: boolean;
  /** `nullable: true` — the runtime treats null as "not provided". */
  nullable?: boolean;
}

export type ParamLocationIR = 'path' | 'query' | 'header' | 'body';

export interface ParamIR {
  tsName: string;
  wireName: string;
  location: ParamLocationIR;
  schema: SchemaIR;
  required: boolean;
  /** The parameter IS the entire request body (scalar / array / free-form). */
  raw?: boolean;
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
  /** Security requirement names / OAuth scopes, forwarded to the auth provider. */
  security?: string[];
  /** Body parameters are sent as `application/x-www-form-urlencoded`. */
  form?: boolean;
  /** A (possibly empty) body must be sent even when all body params are optional. */
  bodyRequired?: boolean;
  /** Translation warnings surfaced as `// NOTE:` comments above the contract. */
  warnings?: string[];
}

/** A security scheme from `components.securitySchemes` (3.x) / `securityDefinitions` (2.0). */
export interface SecuritySchemeIR {
  name: string;
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  /** apiKey location: `header` | `query` | `cookie`. */
  in?: 'header' | 'query' | 'cookie';
  /** apiKey parameter name. */
  paramName?: string;
  /** http scheme, e.g. `basic` | `bearer`. */
  scheme?: string;
  bearerFormat?: string;
  /** OAuth2 flows: name → { tokenUrl?, authorizationUrl?, refreshUrl?, scopes }. */
  flows?: Record<string, { tokenUrl?: string; authorizationUrl?: string; refreshUrl?: string; scopes: Record<string, string> }>;
  description?: string;
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
  /** Free-form notes surfaced in generated file headers (e.g. auth hints). */
  notes?: string[];
  /** Declared security schemes, emitted as a typed auth surface. */
  securitySchemes?: SecuritySchemeIR[];
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
  // Malformed-spec gate: a document that declares neither an `openapi` nor a
  // `swagger` version is not an OpenAPI document. Building an (empty) client
  // from it silently — e.g. because the wrong format was forced — is exactly
  // the "silently wrong output" failure mode the generator must avoid.
  const specVersion =
    typeof spec.openapi === 'string' ? spec.openapi : typeof spec.swagger === 'string' ? spec.swagger : undefined;
  if (!specVersion) {
    throw new OpenApiError(
      'Document does not look like OpenAPI: missing the "openapi" (3.x) or "swagger" (2.0) ' +
        'version field. If this is another format (AsyncAPI, Postman, GraphQL, api-model), ' +
        'let the CLI auto-detect it or pass --format explicitly.',
    );
  }
  const isV2 = specVersion.startsWith('2');
  const title = (spec.info?.title ?? 'Api').trim() || 'Api';
  const version = spec.info?.version;
  const warnings: string[] = [];
  if (spec.paths === undefined || spec.paths === null) {
    // Legal in OpenAPI 3.1, required in 2.0/3.0 — never silent, always a
    // visible warning next to the (empty) generated client.
    warnings.push(
      'The spec declares no "paths" object — the generated client will have no operations. ' +
        '(OpenAPI 2.0 and 3.0 require "paths"; 3.1 allows omitting it.)',
    );
  }

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

  const paths = dereference(spec.paths ?? {}, spec, warnings) as JsonRecord;
  const groupBy = options.groupBy ?? 'tag';
  const securitySchemes = securitySchemesFrom(spec, isV2);
  const knownSchemes = new Set((securitySchemes ?? []).map((s) => s.name));
  const globalSecurity = (spec as JsonRecord).security;
  const groups = new Map<string, ApiGroupIR>();

  for (const [rawPath, rawItem] of Object.entries(paths)) {
    if (typeof rawItem !== 'object' || rawItem === null) continue;
    const pathItem = rawItem as JsonRecord;

    for (const verb of VERBS) {
      const rawOp = pathItem[verb];
      if (typeof rawOp !== 'object' || rawOp === null) continue;
      const op = rawOp as JsonRecord;
      const operation = buildOperation(
        verb.toUpperCase(),
        rawPath,
        pathItem,
        op,
        isV2,
        globalSecurity,
        knownSchemes,
        warnings,
      );
      if (!operation) continue;

      const groupName = pickGroup(operation, pathItem, op, groupBy);
      const group = ensureGroup(groups, groupName);
      const used = new Set(group.operations.map((o) => o.name));
      operation.name = uniqueName(operation.name, used);
      group.operations.push(operation);
    }
  }

  const uniqueWarnings = [...new Set(warnings)];
  return {
    title,
    version,
    base,
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    securitySchemes,
    notes: uniqueWarnings.length > 0 ? uniqueWarnings : undefined,
  };
}

/** Parses `components.securitySchemes` (3.x) / `securityDefinitions` (2.0). */
function securitySchemesFrom(spec: OpenApiSpec, isV2: boolean): SecuritySchemeIR[] | undefined {
  const raw = isV2
    ? (spec as JsonRecord).securityDefinitions
    : ((spec.components as JsonRecord | undefined)?.securitySchemes ?? undefined);
  if (!raw || typeof raw !== 'object' || raw === null) return undefined;
  const schemes: SecuritySchemeIR[] = [];
  for (const [name, value] of Object.entries(raw as JsonRecord)) {
    if (typeof value !== 'object' || value === null) continue;
    const s = value as JsonRecord;
    const rawType = String(s.type ?? '');
    if (rawType !== 'apiKey' && rawType !== 'http' && rawType !== 'oauth2' && rawType !== 'openIdConnect') {
      continue;
    }
    const scheme: SecuritySchemeIR = { name, type: rawType };
    if (s.in === 'header' || s.in === 'query' || s.in === 'cookie') scheme.in = s.in;
    if (typeof s.name === 'string') scheme.paramName = s.name;
    if (typeof s.scheme === 'string') scheme.scheme = s.scheme;
    if (typeof s.bearerFormat === 'string') scheme.bearerFormat = s.bearerFormat;
    if (typeof s.description === 'string') scheme.description = s.description;
    if (s.flows && typeof s.flows === 'object' && s.flows !== null) {
      scheme.flows = {};
      for (const [flowName, rawFlow] of Object.entries(s.flows as JsonRecord)) {
        if (typeof rawFlow !== 'object' || rawFlow === null) continue;
        const flow = rawFlow as JsonRecord;
        const scopes: Record<string, string> = {};
        if (flow.scopes && typeof flow.scopes === 'object' && flow.scopes !== null) {
          for (const [scope, doc] of Object.entries(flow.scopes as JsonRecord)) {
            scopes[scope] = typeof doc === 'string' ? doc : '';
          }
        }
        scheme.flows[flowName] = {
          tokenUrl: typeof flow.tokenUrl === 'string' ? flow.tokenUrl : undefined,
          authorizationUrl: typeof flow.authorizationUrl === 'string' ? flow.authorizationUrl : undefined,
          refreshUrl: typeof flow.refreshUrl === 'string' ? flow.refreshUrl : undefined,
          scopes,
        };
      }
    }
    schemes.push(scheme);
  }
  return schemes.length > 0 ? schemes : undefined;
}

/** Flattens an operation's `security` requirements into scheme/scope names. */
function securityFromOperation(
  op: JsonRecord,
  globalSecurity: unknown,
  knownSchemes: Set<string>,
): string[] | undefined {
  const raw = Array.isArray(op.security) ? op.security : (Array.isArray(globalSecurity) ? globalSecurity : []);
  const out: string[] = [];
  for (const requirement of raw) {
    if (typeof requirement !== 'object' || requirement === null) continue;
    for (const [schemeName, scopes] of Object.entries(requirement as JsonRecord)) {
      if (knownSchemes.size > 0 && !knownSchemes.has(schemeName)) continue;
      out.push(schemeName);
      if (Array.isArray(scopes)) {
        for (const scope of scopes) {
          if (typeof scope === 'string' && !out.includes(scope)) out.push(scope);
        }
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function pickGroup(op: OperationIR, pathItem: JsonRecord, opRecord: JsonRecord, groupBy: 'tag' | 'path'): string {
  // Explicit domain extension wins (spec → domain facade grouping).
  const domain =
    (typeof opRecord['x-client-domain'] === 'string' && opRecord['x-client-domain']) ||
    (typeof pathItem['x-client-domain'] === 'string' && pathItem['x-client-domain']);
  if (domain) return sanitizeGroup(domain);
  if (groupBy === 'path') {
    const first = op.path.split('/').find((seg) => seg.length > 0 && !seg.startsWith(':'));
    return sanitizeGroup(first ?? 'root');
  }
  const tag = op.tags[0] ?? (typeof pathItem.tags === 'object' && pathItem.tags !== null && Array.isArray(pathItem.tags)
    ? String((pathItem.tags as Json[])[0])
    : undefined);
  return sanitizeGroup(tag ?? 'default');
}

/**
 * Merges path-level parameters with operation-level ones. Per the OpenAPI
 * spec, path items' `parameters` are inherited by every operation; an
 * operation-level entry with the same `name` + `in` OVERRIDES the inherited
 * one, and everything else is kept.
 */
function mergeParameters(pathLevel: unknown, opLevel: unknown): Json[] {
  const pathParams = Array.isArray(pathLevel) ? (pathLevel as Json[]) : [];
  const opParams = Array.isArray(opLevel) ? (opLevel as Json[]) : [];
  if (pathParams.length === 0) return opParams;
  if (opParams.length === 0) return pathParams;

  const keyOf = (p: Json): string | null => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const rec = p as JsonRecord;
    return typeof rec.name === 'string' && typeof rec.in === 'string'
      ? `${rec.in}:${rec.name}`
      : null;
  };
  const opKeys = new Set(opParams.map(keyOf).filter((k): k is string => k !== null));
  const inherited = pathParams.filter((p) => {
    const key = keyOf(p);
    return key === null || !opKeys.has(key);
  });
  return [...inherited, ...opParams];
}

function buildOperation(
  method: string,
  rawPath: string,
  pathItem: JsonRecord,
  op: JsonRecord,
  isV2: boolean,
  globalSecurity: unknown,
  knownSchemes: Set<string>,
  apiWarnings: string[],
): OperationIR | null {
  // Route: {param} → :param
  const path = rawPath.replace(/\{([^}]+)\}/g, (_m, name: string) => `:${name}`);

  // Method name
  const operationId = typeof op.operationId === 'string' ? op.operationId : null;
  const name = operationId ?? methodNameFromPath(method, path);

  // Params — path-level entries are inherited unless overridden (name + in).
  const params: ParamIR[] = [];
  const rawParams = mergeParameters(pathItem.parameters, op.parameters);
  const opWarnings: string[] = [];
  const schemaCtx: SchemaWarnCtx = {
    warn: (message) => {
      const line = `${name}: ${message}`;
      opWarnings.push(line);
      apiWarnings.push(line);
    },
  };
  let formBody = false;
  let bodyRequired = false;

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
      const schema = schemaFrom(p.schema as JsonRecord | undefined, schemaCtx);
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
        // A required body must be sent even if every property is optional.
        if (required) bodyRequired = true;
      } else {
        // Scalar / array / free-form body: the param IS the payload.
        params.push({
          tsName: 'body',
          wireName: 'body',
          location: 'body',
          schema,
          required,
          raw: true,
        });
      }
      continue;
    }

    if (in_ === 'formData') {
      // Swagger 2.0 formData: values travel in the request body as
      // application/x-www-form-urlencoded — body placement + `form: true`,
      // never query parameters.
      formBody = true;
      const fs = schemaFrom(p as JsonRecord, schemaCtx);
      if (fs.type === 'file') {
        schemaCtx.warn(
          `formData parameter "${wireName}" is a file upload — multipart/form-data is not supported; it is emitted as a string placeholder`,
        );
        fs.type = 'string';
        fs.format = 'binary';
      }
      params.push({
        tsName: toCamelCase(wireName),
        wireName,
        location: 'body',
        schema: fs,
        required,
        description: typeof p.description === 'string' ? p.description : undefined,
      });
      continue;
    }

    const location: ParamLocationIR =
      in_ === 'path' ? 'path' : in_ === 'header' ? 'header' : 'query';
    params.push({
      tsName: toCamelCase(wireName),
      wireName,
      location,
      // OpenAPI 3 keeps the schema under `schema`; Swagger 2.0 inlines it.
      schema: schemaFrom((p.schema ?? p) as JsonRecord, schemaCtx),
      required,
      description: typeof p.description === 'string' ? p.description : undefined,
    });
  }

  // OpenAPI 3 requestBody
  if (!isV2 && op.requestBody && typeof op.requestBody === 'object') {
    const body = op.requestBody as JsonRecord;
    const required = body.required === true;
    const content = body.content && typeof body.content === 'object'
      ? (body.content as JsonRecord)
      : undefined;
    // Prefer application/json, then urlencoded, then any other media type.
    let mediaType: string | undefined;
    let jsonContent: JsonRecord | undefined;
    if (content) {
      if (content['application/json'] && typeof content['application/json'] === 'object') {
        mediaType = 'application/json';
        jsonContent = content['application/json'] as JsonRecord;
      } else if (
        content['application/x-www-form-urlencoded'] &&
        typeof content['application/x-www-form-urlencoded'] === 'object'
      ) {
        mediaType = 'application/x-www-form-urlencoded';
        jsonContent = content['application/x-www-form-urlencoded'] as JsonRecord;
      } else {
        const entry = firstEntry(content);
        if (entry) {
          mediaType = Object.keys(content).find(
            (k) => content[k] === entry,
          );
          jsonContent = entry;
        }
      }
    }
    if (mediaType === 'application/x-www-form-urlencoded') {
      formBody = true;
    }
    if (mediaType?.startsWith('multipart/')) {
      schemaCtx.warn(
        `requestBody media type ${mediaType} (multipart) is not supported — body properties are emitted, but multipart encoding is not`,
      );
    }
    const schema = schemaFrom(jsonContent?.schema as JsonRecord | undefined, schemaCtx);
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
      // A required body must be sent even if every property is optional.
      if (required) bodyRequired = true;
    } else {
      // Scalar / array / free-form body: the param IS the payload.
      params.push({ tsName: 'body', wireName: 'body', location: 'body', schema, required, raw: true });
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
      schemaCtx,
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
  const security = securityFromOperation(op, globalSecurity, knownSchemes);

  return {
    name,
    method,
    path,
    description,
    summary,
    tags,
    params,
    responds,
    security,
    form: formBody || undefined,
    bodyRequired: bodyRequired || undefined,
    warnings: opWarnings.length > 0 ? opWarnings : undefined,
  };
}

function firstEntry(record: JsonRecord): JsonRecord | undefined {
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  }
  return undefined;
}

export function schemaFrom(raw: JsonRecord | undefined, ctx?: SchemaWarnCtx): SchemaIR {
  if (!raw || typeof raw !== 'object') return {};
  const out: SchemaIR = {};

  // allOf: merge every member schema — properties and required lists union,
  // numeric bounds intersect (the tighter side wins).
  if (Array.isArray(raw.allOf) && raw.allOf.length > 0) {
    const members = raw.allOf
      .filter((m): m is JsonRecord => !!m && typeof m === 'object' && !Array.isArray(m))
      .map((m) => schemaFrom(m, ctx));
    for (const member of members) {
      Object.assign(out, mergeSchemaIR(out, member));
    }
  }

  if (Array.isArray(raw.oneOf) || Array.isArray(raw.anyOf)) {
    const combinator = Array.isArray(raw.oneOf) ? 'oneOf' : 'anyOf';
    ctx?.warn(
      `schema uses ${combinator} — the generated parameter accepts any value (discriminated unions are not inferred)`,
    );
    out.untyped = true;
  }
  if (raw.nullable === true) {
    out.nullable = true;
    ctx?.warn('schema is nullable — the runtime treats null as "not provided"');
  }

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
    out.items = schemaFrom(raw.items as JsonRecord, ctx);
  }
  if (raw.properties && typeof raw.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(raw.properties as JsonRecord)) {
      out.properties[k] = schemaFrom(v as JsonRecord, ctx);
    }
  }
  if (Array.isArray(raw.required)) {
    const own = raw.required.filter((r): r is string => typeof r === 'string');
    out.requiredProps = out.requiredProps ? [...new Set([...out.requiredProps, ...own])] : own;
  }
  return out;
}

/** Merges two schemas the way `allOf` intends: union of structure, intersection of bounds. */
function mergeSchemaIR(base: SchemaIR, overlay: SchemaIR): SchemaIR {
  if (Object.keys(base).length === 0) return { ...overlay };
  if (Object.keys(overlay).length === 0) return { ...base };
  const out: SchemaIR = { ...base };

  if (overlay.type !== undefined) {
    if (out.type !== undefined && out.type !== overlay.type) {
      out.type = undefined;
      out.untyped = true;
    } else {
      out.type = overlay.type;
    }
  }
  if (overlay.format !== undefined) out.format = overlay.format;
  if (overlay.pattern !== undefined) out.pattern = overlay.pattern;
  if (overlay.description !== undefined) out.description = overlay.description;
  if (overlay.default !== undefined) out.default = overlay.default;
  if (overlay.enumValues !== undefined) out.enumValues = overlay.enumValues;
  if (overlay.minimum !== undefined) out.minimum = Math.max(out.minimum ?? -Infinity, overlay.minimum);
  if (overlay.maximum !== undefined) out.maximum = Math.min(out.maximum ?? Infinity, overlay.maximum);
  if (overlay.minLength !== undefined) out.minLength = Math.max(out.minLength ?? 0, overlay.minLength);
  if (overlay.maxLength !== undefined) out.maxLength = Math.min(out.maxLength ?? Infinity, overlay.maxLength);
  if (overlay.untyped) out.untyped = true;
  if (overlay.nullable) out.nullable = true;

  if (overlay.properties) {
    out.properties = { ...(out.properties ?? {}), ...overlay.properties };
  }
  if (overlay.requiredProps) {
    out.requiredProps = [...new Set([...(out.requiredProps ?? []), ...overlay.requiredProps])];
  }
  if (overlay.items) {
    out.items = out.items ? mergeSchemaIR(out.items, overlay.items) : overlay.items;
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

export function toPascalCase(input: string): string {
  const camel = toCamelCase(input);
  return camel[0]!.toUpperCase() + camel.slice(1);
}

export function toKebabCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'group';
}

export function sanitizeGroup(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'default';
}

export function sanitizeIdentifier(name: string): string {
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

export function uniqueName(base: string, used: Set<string>): string {
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
