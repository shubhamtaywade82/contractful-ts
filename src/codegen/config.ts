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
import { buildEventsIR, type AsyncApiPerspective } from './asyncapi.js';
import { emitEvents } from './events-emit.js';
import { buildPostmanIR } from './postman.js';
import { emitGraphqlFromSdl } from './graphql-emit.js';
import { emitStandaloneHttp, emitStandaloneEvents } from './standalone.js';

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
  maxPerFile?: number;
  sources: CodegenSource[];
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

  const files: EmittedFile[] = [];
  const namespaces: string[] = [];
  const models: CanonicalModel[] = [];

  for (const source of config.sources) {
    const text = await readSourceText(source.path);
    const kind = normalizeKind(source.kind, detectSpecKind(text), source.path);
    const namespace = flat ? '' : (source.namespace ?? defaultNamespace(kind));
    if (namespace && !namespaces.includes(namespace)) namespaces.push(namespace);

    const emitOptions: EmitOptions = {
      importFrom: config.importFrom,
      specOrigin: source.path,
      maxPerFile: config.maxPerFile,
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
    for (const file of sourceFiles) {
      files.push({
        path: namespace ? `${namespace}/${file.path}` : file.path,
        content: file.content,
      });
    }
  }

  if (namespaces.length > 0) {
    files.push({
      path: 'index.ts',
      content: [
        `// Auto-generated by contractful-gen — DO NOT EDIT.`,
        ...namespaces.map((namespace) => `export * from './${namespace}/index.js';`),
        '',
      ].join('\n'),
    });
  }

  return { files, namespaces, models };
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
