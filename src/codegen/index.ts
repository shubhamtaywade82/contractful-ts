/**
 * Programmatic codegen API — everything the `contractful-gen` CLI does,
 * importable directly:
 *
 * ```ts
 * import { generateFromOpenAPI, runCodegen } from 'contractful-ts/codegen';
 *
 * // Single spec:
 * const files = await generateFromOpenAPI('./openapi.json', { groupBy: 'tag' });
 *
 * // Multi-source config (OpenAPI + AsyncAPI + Postman + GraphQL):
 * const bundle = await runCodegen({
 *   output: 'src/generated/clients',
 *   sources: [
 *     { path: 'specs/rest.yaml', namespace: 'rest' },
 *     { path: 'specs/events.yaml', namespace: 'events' },
 *   ],
 * });
 * ```
 */

import { buildApiIR, loadSpec, parseSpecText, type ApiIR, type BuildIROptions, type OpenApiSpec } from './openapi.js';
import { emitContracts, type EmitOptions, type EmittedFile } from './emitter.js';

export { loadSpec, parseSpecText, buildApiIR, dereference, readSourceText, OpenApiError, toCamelCase, toPascalCase, toKebabCase, sanitizeGroup, sanitizeIdentifier, uniqueName, schemaFrom } from './openapi.js';
export type { OpenApiSpec, Json, JsonRecord, ApiIR, ApiGroupIR, OperationIR, ParamIR, ResponseIR, SchemaIR, BuildIROptions, ParamLocationIR, SecuritySchemeIR } from './openapi.js';
export { emitContracts } from './emitter.js';
export type { EmitOptions, EmittedFile } from './emitter.js';
export { parseYaml, YamlParseError } from './yaml.js';
export type { YamlLine } from './yaml.js';

/* Format detection + canonical model ------------------------------------- */
export { detectSpecKind, detectSpecObject } from './detect.js';
export type { DetectedSpecKind } from './detect.js';
export {
  modelFromHttpIr,
  modelFromEventsIr,
  httpIrFromModel,
  eventsIrFromModel,
  serializeModel,
  parseModel,
  mergeModels,
} from './model.js';
export type { SpecKind, CanonicalModel, ChannelIR, ChannelGroupIR, ChannelMessageIR, EventsIR } from './model.js';

/* AsyncAPI --------------------------------------------------------------- */
export { loadAsyncApiSpec, buildEventsIR, AsyncApiError, normalizeEventName } from './asyncapi.js';
export type { AsyncApiPerspective, BuildEventsIROptions, EventNamingOptions } from './asyncapi.js';

/* Events emitter --------------------------------------------------------- */
export { emitEvents } from './events-emit.js';

/* Postman ---------------------------------------------------------------- */
export { buildPostmanIR, inferSchemaFromValue, PostmanError } from './postman.js';
export type { BuildPostmanIROptions } from './postman.js';

/* GraphQL ---------------------------------------------------------------- */
export { parseGraphQLSdl, GraphQLParseError } from './graphql.js';
export type { GqlDocument, GqlField, GqlArg, GqlTypeRef, GqlObjectType } from './graphql.js';
export { emitGraphql, emitGraphqlFromSdl } from './graphql-emit.js';
export type { GraphQLEmitOptions } from './graphql-emit.js';

/* Standalone emit -------------------------------------------------------- */
export { emitStandaloneHttp, emitStandaloneEvents } from './standalone.js';

/* Config runner ----------------------------------------------------------- */
export { loadCodegenConfig, runCodegen, dumpModels, generatorVersion, hashSource } from './config.js';
export type { CodegenConfig, CodegenSource, GeneratedBundle } from './config.js';

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
  // parseSpecText (not a bare JSON.parse/parseYaml) so broken JSON/YAML and
  // non-object documents fail with the same OpenApiError as every other
  // entry point instead of leaking SyntaxError / YamlParseError.
  const spec = parseSpecText(text, 'spec');
  return generateFromSpec(spec, options);
}

export { run as runCli } from './cli.js';
