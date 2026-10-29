/**
 * Multi-source codegen configuration — the programmatic heart of the CLI.
 *
 * A config names several spec sources (any mix of OpenAPI, AsyncAPI,
 * Postman collections, GraphQL SDL and serialized api-models); each source
 * is detected, adapted and emitted under its own namespace, with a root
 * index re-exporting everything:
 *
 * ```json
 * {
 *   "output": "src/generated/clients",
 *   "sources": [
 *     { "path": "specs/rest.yaml", "namespace": "rest" },
 *     { "path": "specs/events.yaml", "namespace": "events" }
 *   ]
 * }
 * ```
 */

import {
  buildApiIR,
  loadSpec,
  readSourceText,
  type ApiIR,
  type BuildIROptions,
} from './openapi.js';
import { emitContracts, type EmittedFile, type EmitOptions } from './emitter.js';
import { parseYaml } from './yaml.js';
import { detectSpecKind } from './detect.js';
import type { DetectedSpecKind } from './detect.js';
import type { SpecKind } from './model.js';
import {
  eventsIrFromModel,
  httpIrFromModel,
  modelFromEventsIr,
  modelFromHttpIr,
  parseModel,
  serializeModel,
  type CanonicalModel,
} from './model.js';
import { buildEventsIR, type AsyncApiPerspective, type EventNamingOptions } from './asyncapi.js';
import { emitEvents } from './events-emit.js';
import { buildPostmanIR } from './postman.js';
import { emitGraphqlFromSdl } from './graphql-emit.js';
import { emitStandaloneHttp, emitStandaloneEvents } from './standalone.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Generator version surfaced in emitted `CLIENT_METADATA` blocks. */
export function generatorVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Deterministic sha256 of a source document. */
export function hashSource(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export interface CodegenSource {
  /** File path or http(s) URL of the spec. */
  path: string;
  /** Force the format; omit for auto-detection. */
  kind?: SpecKind | 'auto';
  /** Subdirectory (and import namespace) for the generated files. */
  namespace?: string;
  /** Per-source base URL override. */
  base?: string;
}

export interface CodegenConfig {
  /** Output directory for all generated files. */
  output: string;
  /** Module specifier used in imports. Default `contractful-ts`. */
  importFrom?: string;
  /** `runtime` (default) — contract DSL on the contractful-ts runtime;
   *  `standalone` — self-contained clients with zero runtime imports. */
  emit?: 'runtime' | 'standalone';
  groupBy?: 'tag' | 'path';
  /** AsyncAPI document perspective. Default `server`. */
  asyncapiPerspective?: AsyncApiPerspective;
  /** Deterministic event naming rules (AsyncAPI sources). */
  naming?: EventNamingOptions;
  maxPerFile?: number;
  sources: CodegenSource[];
  /**
   * Emit `platform.ts` unifying every HTTP group and events group behind one
   * facade with shared auth. Default: auto (on when both transports exist).
   */
  platform?: boolean;
  /** Identity headers for the platform facade (`X-Client-Name` / `X-Client-Version`). */
  clientName?: string;
  clientVersion?: string;
}

export interface GeneratedBundle {
  files: EmittedFile[];
  /** Namespaces that received files (empty for flat single-source runs). */
  namespaces: string[];
  /** Canonical models per source (for --dump-model). */
  models: CanonicalModel[];
}

/** Loads a codegen config from a JSON or YAML file. */
export async function loadCodegenConfig(path: string): Promise<CodegenConfig> {
  const text = await readSourceText(path);
  const trimmed = text.trim();
  let parsed: unknown;
  if (trimmed.startsWith('{')) {
    parsed = JSON.parse(trimmed);
  } else {
    parsed = parseYaml(trimmed);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { sources?: unknown }).sources)) {
    throw new Error(`Codegen config ${JSON.stringify(path)} must be an object with a "sources" array.`);
  }
  const config = parsed as CodegenConfig;
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error('Codegen config declares no sources.');
  }
  return config;
}

function normalizeKind(kind: SpecKind | 'auto' | undefined, detected: DetectedSpecKind, path: string): SpecKind {
  if (kind && kind !== 'auto') return kind;
  if (detected === 'unknown') {
    throw new Error(
      `Could not detect the format of ${JSON.stringify(path)} — pass an explicit "kind" (openapi | asyncapi | postman | graphql | api-model).`,
    );
  }
  return detected;
}

function defaultNamespace(kind: SpecKind): string {
  switch (kind) {
    case 'openapi':
      return 'rest';
    case 'asyncapi':
      return 'events';
    case 'postman':
      return 'postman';
    case 'graphql':
      return 'graphql';
    case 'api-model':
      return 'api';
  }
}

/**
 * Runs a full codegen config and returns every file to write, namespace
 * directories included. A single source without an explicit namespace is
 * emitted flat at the root (backwards compatible with v0.1 single-spec runs).
 */
export async function runCodegen(config: CodegenConfig): Promise<GeneratedBundle> {
  if (config.sources.length === 0) throw new Error('Codegen config declares no sources.');
  const flat = config.sources.length === 1 && !config.sources[0]!.namespace;
  const version = generatorVersion();

  const files: EmittedFile[] = [];
  const namespaces: string[] = [];
  const models: CanonicalModel[] = [];
  const modelsByNamespace: { model: CanonicalModel; namespace: string }[] = [];
  const sourceHashes: { file: string; hash: string }[] = [];

  for (const source of config.sources) {
    const text = await readSourceText(source.path);
    const kind = normalizeKind(source.kind, detectSpecKind(text), source.path);
    const namespace = flat ? '' : (source.namespace ?? defaultNamespace(kind));
    if (namespace && !namespaces.includes(namespace)) namespaces.push(namespace);
    sourceHashes.push({ file: source.path, hash: hashSource(text) });

    const emitOptions: EmitOptions = {
      importFrom: config.importFrom,
      specOrigin: source.path,
      maxPerFile: config.maxPerFile,
      sourceHash: hashSource(text),
      generatorVersion: version,
    };

    let sourceFiles: EmittedFile[];
    let model: CanonicalModel;

    switch (kind) {
      case 'openapi': {
        const spec = await loadSpec(source.path);
        const ir: ApiIR = buildApiIR(spec, {
          base: source.base,
          groupBy: config.groupBy,
        } satisfies BuildIROptions);
        model = modelFromHttpIr(ir, source.path);
        sourceFiles =
          config.emit === 'standalone'
            ? emitStandaloneHttp(ir, { specOrigin: source.path })
            : emitContracts(ir, emitOptions);
        break;
      }
      case 'postman': {
        const collection = JSON.parse(text) as Parameters<typeof buildPostmanIR>[0];
        const ir = buildPostmanIR(collection, { base: source.base });
        model = modelFromHttpIr(ir, source.path);
        sourceFiles =
          config.emit === 'standalone'
            ? emitStandaloneHttp(ir, { specOrigin: source.path })
            : emitContracts(ir, emitOptions);
        break;
      }
      case 'asyncapi': {
        const spec = await loadSpec(source.path);
        const ir = buildEventsIR(spec, {
          perspective: config.asyncapiPerspective,
          url: source.base,
          naming: config.naming,
        });
        model = modelFromEventsIr(ir, source.path);
        sourceFiles =
          config.emit === 'standalone'
            ? emitStandaloneEvents(ir, { specOrigin: source.path })
            : emitEvents(ir, emitOptions);
        break;
      }
      case 'graphql': {
        const { files: graphqlFiles, doc } = emitGraphqlFromSdl(text, {
          ...emitOptions,
          base: source.base,
        });
        if (config.emit === 'standalone' && doc.subscriptions.length > 0) {
          throw new Error(
            `Standalone emit does not support GraphQL subscriptions (source: ${source.path}); use emit: "runtime".`,
          );
        }
        sourceFiles = graphqlFiles;
        model = {
          kind: 'contractful-api-model',
          modelVersion: 1,
          name: 'GraphQLApi',
          base: source.base ?? 'https://example.com/graphql',
          origin: source.path,
          groups: [],
          channelGroups: [],
        };
        break;
      }
      case 'api-model': {
        model = parseModel(text);
        const httpIr = httpIrFromModel(model);
        const eventsIr = eventsIrFromModel(model);
        sourceFiles = [
          ...(model.groups.length > 0
            ? config.emit === 'standalone'
              ? emitStandaloneHttp(httpIr, { specOrigin: source.path })
              : emitContracts(httpIr, emitOptions)
            : []),
          ...(model.channelGroups.length > 0
            ? config.emit === 'standalone'
              ? emitStandaloneEvents(eventsIr, { specOrigin: source.path })
              : emitEvents(eventsIr, emitOptions)
            : []),
        ];
        break;
      }
    }

    models.push(model);
    modelsByNamespace.push({ model, namespace });
    for (const file of sourceFiles) {
      files.push({
        path: namespace ? `${namespace}/${file.path}` : file.path,
        content: file.content,
      });
    }
  }

  // Track which namespace owns each HTTP / events group (platform facade).
  const httpClients: { key: string; ctor: string; namespace: string }[] = [];
  const eventClients: { key: string; ctor: string; namespace: string }[] = [];
  for (const { model, namespace } of modelsByNamespace) {
    if (!namespace) continue;
    for (const group of model.groups) {
      httpClients.push({ key: group.name, ctor: group.constName, namespace });
    }
    for (const group of model.channelGroups) {
      eventClients.push({ key: group.name, ctor: group.constName, namespace });
    }
  }

  const hasBothTransports = httpClients.length > 0 && eventClients.length > 0;
  const emitPlatform = config.platform ?? (hasBothTransports && namespaces.length > 0);

  if (emitPlatform && hasBothTransports && config.emit !== 'standalone') {
    files.push({
      path: 'platform.ts',
      content: emitPlatformFile(httpClients, eventClients, {
        importFrom: config.importFrom,
        clientName: config.clientName,
        clientVersion: config.clientVersion ?? version,
      }),
    });
  }

  if (namespaces.length > 0) {
    files.push({
      path: 'index.ts',
      content: [
        `// Auto-generated by contractful-gen — DO NOT EDIT.`,
        ...namespaces.map((namespace) => `export * from './${namespace}/index.js';`),
        ...(emitPlatform && hasBothTransports && config.emit !== 'standalone'
          ? [`export * from './platform.js';`]
          : []),
        '',
        `export const CLIENT_METADATA = {`,
        `  generator: 'contractful-ts',`,
        `  generatorVersion: ${JSON.stringify(version)},`,
        `  sources: [`,
        ...sourceHashes.map(
          (entry) =>
            `    { file: ${JSON.stringify(entry.file)}, hash: ${JSON.stringify(entry.hash)} },`,
        ),
        `  ],`,
        `} as const;`,
        '',
      ].join('\n'),
    });
  }

  return { files, namespaces, models };
}

/* -------------------------------------------------------------------------- */
/* Platform facade emission                                                     */
/* -------------------------------------------------------------------------- */

function toCamel(name: string): string {
  const pascal = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join('');
  return pascal ? pascal[0]!.toLowerCase() + pascal.slice(1) : 'client';
}

function emitPlatformFile(
  httpClients: { key: string; ctor: string; namespace: string }[],
  eventClients: { key: string; ctor: string; namespace: string }[],
  options: { importFrom?: string; clientName?: string; clientVersion?: string },
): string {
  const importFrom = options.importFrom ?? 'contractful-ts';
  const multiHttp = new Set(httpClients.map((c) => c.key)).size < httpClients.length;
  const multiEvents = eventClients.length > 1;

  const lines: string[] = [];
  lines.push(`// Auto-generated by contractful-gen — DO NOT EDIT.`);
  lines.push(`// Unified platform facade: typed REST + events clients, shared auth, one dispose().`);
  lines.push(`// Transports stay separate internally; only the API surface is unified.`);
  lines.push('');
  lines.push(`import {`);
  lines.push(`  authProviderResolver,`);
  lines.push(`  type AuthProvider,`);
  lines.push(`  type ClientOptions,`);
  lines.push(`  type EventsChannelClientOptions,`);
  lines.push(`} from ${JSON.stringify(importFrom)};`);
  for (const ctor of new Set(httpClients.map((c) => c.ctor))) {
    const client = httpClients.find((c) => c.ctor === ctor)!;
    lines.push(`import { ${ctor} } from './${client.namespace || '.'}/index.js';`);
  }
  for (const ctor of new Set(eventClients.map((c) => c.ctor))) {
    const client = eventClients.find((c) => c.ctor === ctor)!;
    lines.push(`import { ${ctor} } from './${client.namespace || '.'}/index.js';`);
  }
  lines.push('');
  lines.push(`export interface PlatformOptions {`);
  lines.push(`  /** Shared options for every HTTP group client. */`);
  lines.push(`  http?: ClientOptions;`);
  lines.push(`  /** Shared options for every events client. */`);
  lines.push(`  events?: EventsChannelClientOptions;`);
  lines.push(`  /** Transport-aware auth shared by REST and events. */`);
  lines.push(`  authProvider?: AuthProvider;`);
  lines.push(`  /** Sent as X-Client-Name / X-Client-Version on HTTP requests. */`);
  lines.push(`  identity?: { clientName: string; clientVersion: string };`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export function createPlatformClient(options: PlatformOptions = {}) {`);
  lines.push(`  const auth = options.authProvider;`);
  lines.push(`  const resolver = auth ? authProviderResolver(auth) : undefined;`);
  lines.push(`  const identityHeaders: Record<string, string> = options.identity`);
  lines.push(`    ? { 'X-Client-Name': options.identity.clientName, 'X-Client-Version': options.identity.clientVersion }`);
  lines.push(`    : {};`);
  lines.push(`  const http: ClientOptions = {`);
  lines.push(`    ...options.http,`);
  lines.push(`    headers: { ...identityHeaders, ...(options.http?.headers ?? {}) },`);
  lines.push(`    auth: options.http?.auth ?? resolver,`);
  lines.push(`  };`);
  lines.push('');
  lines.push(`  const rest = {`);
  for (const [i, client] of httpClients.entries()) {
    const key = toCamel(multiHttp ? `${client.namespace}-${client.key}` : client.key);
    lines.push(`    ${key}: new ${client.ctor}(http),${i === httpClients.length - 1 ? '' : ''}`);
  }
  lines.push(`  };`);
  lines.push('');
  lines.push(`  const eventsClients = {`);
  for (const client of eventClients) {
    const key = toCamel(client.key);
    lines.push(
      `    ${key}: new ${client.ctor}({ ...options.events, authProvider: options.events?.authProvider ?? auth }),`,
    );
  }
  lines.push(`  };`);
  lines.push('');
  lines.push(`  return {`);
  lines.push(`    rest,`);
  lines.push(`    events: ${multiEvents ? 'eventsClients' : `eventsClients.${toCamel(eventClients[0]!.key)}`},`);
  lines.push(`    authProvider: auth,`);
  lines.push(`    identityHeaders,`);
  lines.push(`    /** Disconnects every events client; REST is stateless. */`);
  lines.push(`    dispose: async () => {`);
  lines.push(`      await Promise.all(Object.values(eventsClients).map((client) => client.disconnect()));`);
  lines.push(`    },`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push('');
  return lines.join('\n');
}

/** Serializes every model of a bundle into one JSON document. */
export function dumpModels(bundle: GeneratedBundle): string {
  return serializeModel({
    kind: 'contractful-api-model',
    modelVersion: 1,
    name: bundle.models[0]?.name ?? 'api',
    base: bundle.models[0]?.base ?? '',
    origin: bundle.models.map((model) => model.origin).filter(Boolean).join(', ') || undefined,
    groups: bundle.models.flatMap((model) => model.groups),
    channelGroups: bundle.models.flatMap((model) => model.channelGroups),
  });
}
