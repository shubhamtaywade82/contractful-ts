#!/usr/bin/env node
/**
 * contractful-gen — OpenAPI → contractful-ts connector generator.
 *
 * Reads an OpenAPI 3.x (or Swagger 2.0) spec — file path or http(s) URL,
 * JSON or YAML — and emits one typed, hand-editable contract module per
 * API group, in the same style as the binance-connector-js codegen but
 * targeting the contractful-ts runtime DSL.
 *
 * Usage:
 *   contractful-gen --spec ./openapi.json --out ./src/petstore
 *   contractful-gen --spec https://example.com/openapi.yaml --out ./src/api \
 *                   --import-from @myorg/contractful-ts --group-by tag
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildApiIR, loadSpec, OpenApiError } from './openapi.js';
import { emitContracts } from './emitter.js';

const VERSION = '0.1.0';

interface CliArgs {
  spec?: string;
  out?: string;
  base?: string;
  importFrom?: string;
  groupBy?: 'tag' | 'path';
  maxPerFile?: number;
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
      `contractful-gen v${VERSION} — OpenAPI → contractful-ts connector generator`,
      '',
      'Usage:',
      '  contractful-gen --spec <path-or-url> --out <dir> [options]',
      '',
      'Options:',
      '  --spec, -s <path|url>    OpenAPI/Swagger spec (JSON or YAML, file or URL)',
      '  --out, -o <dir>          Output directory for generated .ts files',
      '  --base, -b <url>         Override the API base URL from the spec servers',
      '  --import-from, -i <pkg>  Module specifier used in imports (default: contractful-ts)',
      '  --group-by, -g <mode>    Group contracts by "tag" (default) or "path"',
      '  --max-per-file <n>       Split large groups into files of at most n operations',
      '  --help, -h               Show this help',
      '  --version, -v            Show the version',
      '',
    ].join('\n'),
  );
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
  if (!args.spec) fail('missing required option --spec');
  if (!args.out) fail('missing required option --out');

  process.stderr.write(`contractful-gen: loading spec ${args.spec} ...\n`);
  let spec;
  try {
    spec = await loadSpec(args.spec);
  } catch (err) {
    if (err instanceof OpenApiError) fail(err.message);
    fail(`loading spec failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const isV2 = typeof spec.swagger === 'string';
  if (isV2) {
    process.stderr.write('contractful-gen: note: Swagger 2.0 spec detected; treating formData params as query parameters.\n');
  }

  const ir = buildApiIR(spec, { base: args.base, groupBy: args.groupBy });
  const files = emitContracts(ir, {
    importFrom: args.importFrom,
    specOrigin: args.spec,
    maxPerFile: args.maxPerFile,
  });

  const outDir = resolve(args.out);
  for (const file of files) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }

  const ops = ir.groups.reduce((sum, g) => sum + g.operations.length, 0);
  process.stderr.write(
    [
      `contractful-gen: generated ${files.length} file(s) for ${ops} operation(s) in ${ir.groups.length} group(s) → ${outDir}`,
      `contractful-gen: base URL: ${ir.base}`,
      ...ir.groups.map((g) => `  · ${g.fileName} (${g.operations.length} ops)`),
    ].join('\n') + '\n',
  );
  return 0;
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
