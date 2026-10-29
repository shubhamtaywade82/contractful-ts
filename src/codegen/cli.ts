#!/usr/bin/env node
/**
 * contractful-gen — universal API client generator.
 *
 * Reads an API description — OpenAPI 3.x / Swagger 2.0, AsyncAPI 2.x / 3.x,
 * Postman Collection v2.x, GraphQL SDL, or a serialized api-model — from a
 * file path or http(s) URL, JSON or YAML, and emits typed, hand-editable
 * contract modules for the contractful-ts runtime (or standalone clients
 * with zero runtime imports).
 *
 * Usage:
 *   contractful-gen --spec ./openapi.json --out ./src/petstore
 *   contractful-gen --spec https://example.com/openapi.yaml --out ./src/api
 *   contractful-gen --config codegen.json            # multi-source
 *   contractful-gen --spec ./asyncapi.yaml --out ./src/events --format asyncapi
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  buildApiIR,
  loadSpec,
  OpenApiError,
  readSourceText,
} from './openapi.js';
import { emitContracts } from './emitter.js';
import { emitEvents } from './events-emit.js';
import { buildEventsIR } from './asyncapi.js';
import { buildPostmanIR } from './postman.js';
import { emitGraphqlFromSdl } from './graphql-emit.js';
import { detectSpecKind } from './detect.js';
import {
  dumpModels,
  loadCodegenConfig,
  runCodegen,
} from './config.js';
import { httpIrFromModel, modelFromHttpIr, parseModel, serializeModel, type CanonicalModel } from './model.js';

const VERSION = '0.2.0';

interface CliArgs {
  spec?: string;
  out?: string;
  base?: string;
  importFrom?: string;
  groupBy?: 'tag' | 'path';
  maxPerFile?: number;
  format?: 'auto' | 'openapi' | 'asyncapi' | 'postman' | 'graphql' | 'api-model';
  namespace?: string;
  emit?: 'runtime' | 'standalone';
  perspective?: 'server' | 'client';
  config?: string;
  dumpModel?: string;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        fail(`Missing value for ${arg}`);
      }
      return value!;
    };
    switch (arg) {
      case '--spec':
      case '-s':
        args.spec = next();
        break;
      case '--out':
      case '-o':
        args.out = next();
        break;
      case '--base':
      case '-b':
        args.base = next();
        break;
      case '--import-from':
      case '-i':
        args.importFrom = next();
        break;
      case '--group-by':
      case '-g': {
        const value = next();
        if (value !== 'tag' && value !== 'path') {
          fail(`--group-by must be 'tag' or 'path', got ${JSON.stringify(value)}`);
        }
        args.groupBy = value;
        break;
      }
      case '--max-per-file':
        args.maxPerFile = Number.parseInt(next(), 10);
        break;
      case '--format':
      case '-f': {
        const value = next();
        const allowed = ['auto', 'openapi', 'asyncapi', 'postman', 'graphql', 'api-model'];
        if (!allowed.includes(value)) {
          fail(`--format must be one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`);
        }
        args.format = value as CliArgs['format'];
        break;
      }
      case '--namespace':
      case '-n':
        args.namespace = next();
        break;
      case '--emit': {
        const value = next();
        if (value !== 'runtime' && value !== 'standalone') {
          fail(`--emit must be 'runtime' or 'standalone', got ${JSON.stringify(value)}`);
        }
        args.emit = value;
        break;
      }
      case '--perspective': {
        const value = next();
        if (value !== 'server' && value !== 'client') {
          fail(`--perspective must be 'server' or 'client', got ${JSON.stringify(value)}`);
        }
        args.perspective = value;
        break;
      }
      case '--config':
      case '-c':
        args.config = next();
        break;
      case '--dump-model':
        args.dumpModel = next();
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      default:
        fail(`Unknown option ${JSON.stringify(arg)}`);
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`contractful-gen: ${message}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(
    [
      `contractful-gen v${VERSION} — universal API client generator`,
      '',
      'Supported input formats (auto-detected, or forced with --format):',
      '  openapi     OpenAPI 3.x / Swagger 2.0  → typed HTTP contracts',
      '  asyncapi    AsyncAPI 2.x / 3.x        → typed event channels',
      '  postman     Postman Collection v2.x    → HTTP contracts (inferred types)',
      '  graphql     GraphQL SDL                → typed query/mutation/subscription client',
      '  api-model   serialized contractful model → round-trip regeneration',
      '',
      'Usage:',
      '  contractful-gen --spec <path-or-url> --out <dir> [options]',
      '  contractful-gen --config <codegen.json> [--out <dir>]',
      '',
      'Options:',
      '  --spec, -s <path|url>       Spec (JSON/YAML file, URL, or .graphql SDL)',
      '  --out, -o <dir>             Output directory',
      '  --config, -c <file>         Multi-source config (JSON/YAML)',
      '  --format, -f <kind>         Force format: auto|openapi|asyncapi|postman|graphql|api-model',
      '  --namespace, -n <name>      Subdirectory for single-spec runs',
      '  --emit <mode>               runtime (default) | standalone (no runtime imports)',
      '  --base, -b <url>            Override the base/WS URL from the spec',
      '  --import-from, -i <pkg>     Module specifier used in imports (default: contractful-ts)',
      '  --group-by, -g <mode>       Group HTTP contracts by "tag" (default) or "path"',
      '  --perspective <p>           AsyncAPI direction: server (default) | client',
      '  --max-per-file <n>          Split large groups into files of at most n operations',
      '  --dump-model <file>         Write the canonical model as JSON instead of code',
      '  --help, -h                  Show this help',
      '  --version, -v               Show the version',
      '',
    ].join('\n'),
  );
}

async function writeFiles(outDir: string, files: Array<{ path: string; content: string }>): Promise<void> {
  for (const file of files) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  /* ---------------------------------------------------------------- */
  /* Config mode                                                       */
  /* ---------------------------------------------------------------- */

  if (args.config) {
    let config;
    try {
      config = await loadCodegenConfig(args.config);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    if (args.out) config.output = args.out;
    if (args.importFrom) config.importFrom = args.importFrom;
    if (args.emit) config.emit = args.emit;
    if (args.groupBy) config.groupBy = args.groupBy;
    if (args.maxPerFile !== undefined) config.maxPerFile = args.maxPerFile;
    if (args.perspective) config.asyncapiPerspective = args.perspective;

    process.stderr.write(`contractful-gen: running config ${args.config} (${config.sources.length} source(s)) ...\n`);
    const bundle = await runCodegen(config).catch((err: unknown) => {
      fail(err instanceof Error ? err.message : String(err));
    });

    if (args.dumpModel) {
      await mkdir(dirname(resolve(args.dumpModel)), { recursive: true });
      await writeFile(resolve(args.dumpModel), dumpModels(bundle), 'utf8');
      process.stderr.write(`contractful-gen: wrote canonical model → ${args.dumpModel}\n`);
    }

    await writeFiles(resolve(config.output), bundle.files);
    process.stderr.write(
      `contractful-gen: generated ${bundle.files.length} file(s) across ${bundle.namespaces.length || 1} namespace(s) → ${resolve(config.output)}\n`,
    );
    return 0;
  }

  /* ---------------------------------------------------------------- */
  /* Single-spec mode                                                  */
  /* ---------------------------------------------------------------- */

  if (!args.spec) fail('missing required option --spec (or use --config)');
  if (!args.out) fail('missing required option --out');

  process.stderr.write(`contractful-gen: loading spec ${args.spec} ...\n`);
  const text = await readSourceText(args.spec).catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });

  const detected = detectSpecKind(text);
  const kind = args.format && args.format !== 'auto' ? args.format : detected;
  if (kind === 'unknown') {
    fail(
      `Could not detect the format of ${args.spec} — pass --format openapi|asyncapi|postman|graphql|api-model`,
    );
  }
  process.stderr.write(`contractful-gen: format: ${kind}${args.format ? '' : ' (auto-detected)'}\n`);

  const importFrom = args.importFrom;
  const specOrigin = args.spec;
  const emitOptions = { importFrom, specOrigin, maxPerFile: args.maxPerFile };
  const outDir = resolve(args.out);
  const prefix = args.namespace ? `${args.namespace}/` : '';

  // Canonical model dump path.
  if (args.dumpModel && kind !== 'api-model') {
    const model = await buildModelForDump(kind, text, args);
    await mkdir(dirname(resolve(args.dumpModel)), { recursive: true });
    await writeFile(resolve(args.dumpModel), serializeModel(model), 'utf8');
    process.stderr.write(`contractful-gen: wrote canonical model → ${args.dumpModel}\n`);
  }

  switch (kind) {
    case 'openapi': {
      const spec = await loadSpec(args.spec).catch((err: unknown) => {
        if (err instanceof OpenApiError) fail(err.message);
        fail(err instanceof Error ? err.message : String(err));
      });
      if (typeof spec.swagger === 'string') {
        process.stderr.write('contractful-gen: note: Swagger 2.0 spec detected; treating formData params as query parameters.\n');
      }
      const ir = buildApiIR(spec, { base: args.base, groupBy: args.groupBy });
      const files = emitContracts(ir, emitOptions);
      await writeFiles(outDir, files.map(withPrefix(prefix)));
      report(ir.groups.reduce((sum, g) => sum + g.operations.length, 0), files.length, ir.groups.length, outDir, ir.base);
      return 0;
    }
    case 'postman': {
      const collection = JSON.parse(text) as Parameters<typeof buildPostmanIR>[0];
      const ir = buildPostmanIR(collection, { base: args.base });
      const files = emitContracts(ir, emitOptions);
      await writeFiles(outDir, files.map(withPrefix(prefix)));
      report(ir.groups.reduce((sum, g) => sum + g.operations.length, 0), files.length, ir.groups.length, outDir, ir.base);
      return 0;
    }
    case 'asyncapi': {
      const spec = await loadSpec(args.spec).catch((err: unknown) => {
        fail(err instanceof Error ? err.message : String(err));
      });
      const ir = buildEventsIR(spec, { perspective: args.perspective, url: args.base });
      const files = emitEvents(ir, emitOptions);
      await writeFiles(outDir, files.map(withPrefix(prefix)));
      const channels = ir.groups.reduce((sum, g) => sum + g.channels.length, 0);
      report(channels, files.length, ir.groups.length, outDir, ir.url);
      return 0;
    }
    case 'graphql': {
      const { files, doc } = emitGraphqlFromSdl(text, { ...emitOptions, base: args.base });
      await writeFiles(outDir, files.map(withPrefix(prefix)));
      const ops = doc.queries.length + doc.mutations.length + doc.subscriptions.length;
      process.stderr.write(
        `contractful-gen: generated ${files.length} file(s) for ${ops} operation(s) → ${outDir}\n`,
      );
      return 0;
    }
    case 'api-model': {
      const model = parseModel(text);
      const files = [
        ...(model.groups.length > 0
          ? emitContracts(httpIrFromModel(model), emitOptions)
          : []),
        ...(model.channelGroups.length > 0
          ? emitEvents(eventsIrFromModelFor(model), emitOptions)
          : []),
      ];
      await writeFiles(outDir, files.map(withPrefix(prefix)));
      report(
        model.groups.reduce((sum, g) => sum + g.operations.length, 0) +
          model.channelGroups.reduce((sum, g) => sum + g.channels.length, 0),
        files.length,
        model.groups.length + model.channelGroups.length,
        outDir,
        model.base,
      );
      return 0;
    }
    default:
      fail(`Unsupported format ${JSON.stringify(String(kind))}`);
  }
}

function eventsIrFromModelFor(model: ReturnType<typeof parseModel>) {
  return {
    title: model.name,
    version: model.specVersion,
    url: model.base,
    groups: model.channelGroups,
  };
}

async function buildModelForDump(
  kind: string,
  text: string,
  args: CliArgs,
): Promise<CanonicalModel> {
  switch (kind) {
    case 'openapi': {
      const spec = await loadSpec(args.spec!);
      return modelFromHttpIr(buildApiIR(spec, { base: args.base, groupBy: args.groupBy }));
    }
    case 'postman':
      return modelFromHttpIr(buildPostmanIR(JSON.parse(text) as Parameters<typeof buildPostmanIR>[0], { base: args.base }));
    case 'asyncapi': {
      const spec = await loadSpec(args.spec!);
      const ir = buildEventsIR(spec, { perspective: args.perspective, url: args.base });
      return { ...modelFromHttpIr({ title: ir.title, version: ir.version, base: ir.url, groups: [] }), channelGroups: ir.groups };
    }
    case 'api-model':
      return parseModel(text);
    default:
      fail(`--dump-model does not support format ${JSON.stringify(kind)}`);
  }
}

function withPrefix(prefix: string) {
  return (file: { path: string; content: string }) => ({
    path: `${prefix}${file.path}`,
    content: file.content,
  });
}

function report(operations: number, files: number, groups: number, outDir: string, base: string): void {
  process.stderr.write(
    [
      `contractful-gen: generated ${files} file(s) for ${operations} operation(s) in ${groups} group(s) → ${outDir}`,
      `contractful-gen: base URL: ${base}`,
    ].join('\n') + '\n',
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`contractful-gen: unexpected failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
