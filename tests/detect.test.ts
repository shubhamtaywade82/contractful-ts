import { describe, expect, it } from 'vitest';
import { detectSpecKind, detectSpecObject } from '../src/codegen/detect.js';

const OPENAPI_JSON = JSON.stringify({ openapi: '3.0.0', info: { title: 'x' }, paths: {} });
const SWAGGER_JSON = JSON.stringify({ swagger: '2.0', info: { title: 'x' }, paths: {} });
const ASYNCAPI_YAML = ['asyncapi: 2.6.0', 'info:', '  title: Events', 'channels: {}'].join('\n');
const POSTMAN_JSON = JSON.stringify({
  info: { name: 'c', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [],
});
const POSTMAN_NO_SCHEMA = JSON.stringify({ info: { name: 'c', _postman_id: 'abc' }, item: [] });
const MODEL_JSON = JSON.stringify({ kind: 'contractful-api-model', modelVersion: 1, name: 'x', base: '', groups: [], channelGroups: [] });
const GRAPHQL_SDL = [
  'type User { id: ID! name: String }',
  'type Query { user(id: ID!): User }',
  '',
].join('\n');
const INTROSPECTION = JSON.stringify({ data: { __schema: { queryType: { name: 'Query' } } } });

describe('detectSpecKind', () => {
  it('recognizes OpenAPI 3.x and Swagger 2.0', () => {
    expect(detectSpecKind(OPENAPI_JSON)).toBe('openapi');
    expect(detectSpecKind(SWAGGER_JSON)).toBe('openapi');
    expect(detectSpecKind(['openapi: 3.1.0', 'info: { title: x }', 'paths: {}'].join('\n'))).toBe('openapi');
  });

  it('recognizes AsyncAPI', () => {
    expect(detectSpecKind(ASYNCAPI_YAML)).toBe('asyncapi');
    expect(detectSpecKind(JSON.stringify({ asyncapi: '3.0.0', info: { title: 'x' } }))).toBe('asyncapi');
  });

  it('recognizes Postman collections with and without the schema marker', () => {
    expect(detectSpecKind(POSTMAN_JSON)).toBe('postman');
    expect(detectSpecKind(POSTMAN_NO_SCHEMA)).toBe('postman');
  });

  it('recognizes GraphQL SDL and introspection responses', () => {
    expect(detectSpecKind(GRAPHQL_SDL)).toBe('graphql');
    expect(detectSpecKind(INTROSPECTION)).toBe('graphql');
  });

  it('recognizes serialized canonical models', () => {
    expect(detectSpecKind(MODEL_JSON)).toBe('api-model');
  });

  it('prefers OpenAPI when a YAML path uses {param} braces', () => {
    const openapiYaml = [
      'openapi: 3.0.0',
      'info: { title: Petstore }',
      'paths:',
      '  /pets/{petId}:',
      '    get:',
      '      responses: { "200": { description: ok } }',
    ].join('\n');
    expect(detectSpecKind(openapiYaml)).toBe('openapi');
  });

  it('returns unknown for unrecognizable input', () => {
    expect(detectSpecKind('')).toBe('unknown');
    expect(detectSpecKind('hello: world')).toBe('unknown');
    expect(detectSpecKind('not json at all')).toBe('unknown');
  });

  it('detectSpecObject handles non-objects and arrays', () => {
    expect(detectSpecObject(null)).toBe('unknown');
    expect(detectSpecObject([1, 2])).toBe('unknown');
    expect(detectSpecObject('string')).toBe('unknown');
  });
});
