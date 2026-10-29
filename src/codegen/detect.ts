/**
 * Input format detection for the codegen: inspects raw spec text and
 * identifies OpenAPI/Swagger, AsyncAPI, Postman Collection, GraphQL SDL or
 * a serialized canonical model. Explicit `kind` configuration always wins;
 * detection is the `auto` fallback.
 */

import { parseYaml, YamlParseError } from './yaml.js';
import type { SpecKind } from './model.js';

export type DetectedSpecKind = SpecKind | 'unknown';

/** Detects the kind of an already-parsed document object. */
export function detectSpecObject(doc: unknown): DetectedSpecKind {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'unknown';
  const record = doc as Record<string, unknown>;

  if (typeof record.openapi === 'string' || typeof record.swagger === 'string') {
    return 'openapi';
  }
  if (typeof record.asyncapi === 'string') return 'asyncapi';

  const info = record.info;
  if (typeof info === 'object' && info !== null) {
    const schema = (info as Record<string, unknown>).schema;
    if (typeof schema === 'string' && schema.includes('schema.getpostman.com/json/collection')) {
      return 'postman';
    }
    if ((info as Record<string, unknown>)._postman_id !== undefined) return 'postman';
  }
  if (Array.isArray(record.item) && typeof info === 'object' && info !== null) return 'postman';

  if (record.__schema !== undefined) return 'graphql';
  const data = record.data;
  if (typeof data === 'object' && data !== null && '__schema' in data) return 'graphql';

  if (record.kind === 'contractful-api-model') return 'api-model';

  return 'unknown';
}

const GRAPHQL_KEYWORD = /^\s*(?:schema|type|input|enum|interface|union|scalar|extend|directive|query|mutation|subscription)\b/m;

/** Detects the kind of raw spec text (JSON, YAML or GraphQL SDL). */
export function detectSpecKind(text: string): DetectedSpecKind {
  const trimmed = text.trim();
  if (trimmed === '') return 'unknown';

  // JSON documents.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return detectSpecObject(JSON.parse(trimmed));
    } catch {
      return 'unknown';
    }
  }

  // GraphQL SDL: never valid YAML when it contains braces mid-document.
  if (GRAPHQL_KEYWORD.test(trimmed) && trimmed.includes('{')) {
    try {
      const asYaml = parseYaml(trimmed);
      if (typeof asYaml !== 'object' || asYaml === null || Array.isArray(asYaml)) {
        return 'graphql';
      }
      const kind = detectSpecObject(asYaml);
      if (kind === 'unknown') return 'graphql';
      return kind;
    } catch (err) {
      if (err instanceof YamlParseError) return 'graphql';
      return 'unknown';
    }
  }

  // YAML documents.
  try {
    return detectSpecObject(parseYaml(trimmed));
  } catch {
    return 'unknown';
  }
}
