/**
 * Programmatic codegen API — everything the `contractful-gen` CLI does,
 * importable directly:
 *
 * ```ts
 * import { generateFromOpenAPI } from 'contractful-ts/codegen';
 *
 * const files = await generateFromOpenAPI('./openapi.json', {
 *   groupBy: 'tag',
 *   importFrom: 'contractful-ts',
 * });
 * ```
 */

import { buildApiIR, loadSpec, type ApiIR, type BuildIROptions, type OpenApiSpec } from './openapi.js';
import { emitContracts, type EmitOptions, type EmittedFile } from './emitter.js';
import { parseYaml, YamlParseError, type YamlLine } from './yaml.js';

export { loadSpec, parseSpecText, buildApiIR, dereference, OpenApiError, toCamelCase } from './openapi.js';
export type { OpenApiSpec, Json, JsonRecord, ApiIR, ApiGroupIR, OperationIR, ParamIR, ResponseIR, SchemaIR, BuildIROptions, ParamLocationIR } from './openapi.js';
export { emitContracts } from './emitter.js';
export type { EmitOptions, EmittedFile } from './emitter.js';
export { parseYaml, YamlParseError } from './yaml.js';
export type { YamlLine } from './yaml.js';

export interface GenerateOptions extends BuildIROptions, Omit<EmitOptions, 'specOrigin'> {}

/**
 * One-shot generator: loads a spec (path, URL, or raw JSON/YAML text),
 * builds the IR and returns the set of files to write.
 */
export async function generateFromOpenAPI(
  specSource: string,
  options: GenerateOptions = {},
): Promise<{ ir: ApiIR; files: EmittedFile[]; spec: OpenApiSpec }> {
  const spec = await loadSpec(specSource);
  const ir = buildApiIR(spec, options);
  const files = emitContracts(ir, { ...options, specOrigin: specSource });
  return { ir, files, spec };
}

/** Like {@link generateFromOpenAPI} but for a spec already parsed to an object. */
export function generateFromSpec(
  spec: OpenApiSpec,
  options: GenerateOptions = {},
): { ir: ApiIR; files: EmittedFile[] } {
  const ir = buildApiIR(spec, options);
  const files = emitContracts(ir, options);
  return { ir, files };
}

/** Like {@link generateFromOpenAPI} but takes raw JSON/YAML text. */
export function generateFromSpecText(
  text: string,
  options: GenerateOptions = {},
): { ir: ApiIR; files: EmittedFile[] } {
  // Reuse loadSpec's JSON/YAML detection without touching the filesystem.
  const isJson = text.trimStart().startsWith('{');
  const spec: OpenApiSpec = isJson
    ? (JSON.parse(text) as OpenApiSpec)
    : (parseYaml(text) as OpenApiSpec);
  return generateFromSpec(spec, options);
}

export { run as runCli } from './cli.js';
