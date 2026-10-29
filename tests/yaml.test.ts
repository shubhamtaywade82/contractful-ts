import { describe, expect, it } from 'vitest';
import { parseYaml, YamlParseError } from '../src/codegen/yaml.js';

describe('parseYaml — scalars', () => {
  it('parses typed plain scalars', () => {
    expect(parseYaml('hello')).toBe('hello');
    expect(parseYaml('42')).toBe(42);
    expect(parseYaml('-17')).toBe(-17);
    expect(parseYaml('3.14')).toBe(3.14);
    expect(parseYaml('1e5')).toBe(100_000);
    expect(parseYaml('0x1F')).toBe(31);
    expect(parseYaml('true')).toBe(true);
    expect(parseYaml('False')).toBe(false);
    expect(parseYaml('null')).toBe(null);
    expect(parseYaml('~')).toBe(null);
  });

  it('treats version-looking strings as strings when not numeric', () => {
    expect(parseYaml('v1.0')).toBe('v1.0');
    expect(parseYaml('1.0.0')).toBe('1.0.0');
  });

  it('parses quoted scalars with escapes', () => {
    expect(parseYaml(`'it''s'`)).toBe("it's");
    expect(parseYaml(`"line1\\nline2"`)).toBe('line1\nline2');
    expect(parseYaml(`"quote: \\" backslash: \\\\ done"`)).toBe('quote: " backslash: \\ done');
    expect(parseYaml(`"caf\\u00e9"`)).toBe('café');
  });

  it('strips trailing comments outside quotes', () => {
    expect(parseYaml('value # a comment')).toBe('value');
    expect(parseYaml(`"has # inside" # comment`)).toBe('has # inside');
  });
});

describe('parseYaml — mappings and sequences', () => {
  it('parses nested block mappings', () => {
    const doc = parseYaml(`
openapi: 3.0.0
info:
  title: Petstore
  version: 1.0.0
  contact:
    name: API Support
    email: support@example.test
`);
    expect(doc).toEqual({
      openapi: '3.0.0',
      info: {
        title: 'Petstore',
        version: '1.0.0',
        contact: { name: 'API Support', email: 'support@example.test' },
      },
    });
  });

  it('parses block sequences of scalars and nested structures', () => {
    const doc = parseYaml(`
tags:
  - pets
  - store
servers:
  - url: https://petstore.test/v1
    description: Production
  - url: https://staging.petstore.test
`);
    expect(doc).toEqual({
      tags: ['pets', 'store'],
      servers: [
        { url: 'https://petstore.test/v1', description: 'Production' },
        { url: 'https://staging.petstore.test' },
      ],
    });
  });

  it('parses sequences of mappings with compact first entries', () => {
    const doc = parseYaml(`
parameters:
  - name: status
    in: query
    required: false
    schema:
      type: string
  - name: limit
    in: query
    schema:
      type: integer
`);
    expect(doc).toEqual({
      parameters: [
        { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
      ],
    });
  });

  it('parses empty values as null and empty maps', () => {
    const doc = parseYaml(`
a:
b: 2
empty-map: {}
empty-list: []
`);
    expect(doc).toEqual({ a: null, b: 2, 'empty-map': {}, 'empty-list': [] });
  });

  it('parses inline flow collections', () => {
    const doc = parseYaml(`
verbs: [get, post]
matrix: { a: 1, b: [2, 3], c: "x" }
nested: [{name: n1}, {name: n2}]
`);
    expect(doc).toEqual({
      verbs: ['get', 'post'],
      matrix: { a: 1, b: [2, 3], c: 'x' },
      nested: [{ name: 'n1' }, { name: 'n2' }],
    });
  });

  it('parses quoted keys containing colons', () => {
    const doc = parseYaml(`
"application/json":
  schema:
    type: object
`);
    expect(doc).toEqual({ 'application/json': { schema: { type: 'object' } } });
  });

  it('supports multi-line plain scalars', () => {
    const doc = parseYaml(`
description: Find pets by ID
  and return the matching pets
  from the system.
`);
    expect(doc).toEqual({
      description: 'Find pets by ID and return the matching pets from the system.',
    });
  });
});

describe('parseYaml — block scalars', () => {
  it('parses literal blocks keeping newlines', () => {
    const doc = parseYaml(`
description: |
  Line one.
  Line two.
`);
    expect(doc).toEqual({ description: 'Line one.\nLine two.\n' });
  });

  it('parses literal blocks with strip chomping', () => {
    const doc = parseYaml(`
description: |-
  No trailing newline.
`);
    expect(doc).toEqual({ description: 'No trailing newline.' });
  });

  it('parses folded blocks', () => {
    const doc = parseYaml(`
description: >
  Folded into one line
  continuing here.
`);
    expect(doc).toEqual({ description: 'Folded into one line continuing here.\n' });
  });

  it('keeps # lines and deeper indentation inside literal blocks', () => {
    const doc = parseYaml(`
description: |
  Markdown body.
  # not a comment
    indented code
`);
    expect(doc).toEqual({
      description: 'Markdown body.\n# not a comment\n  indented code\n',
    });
  });
});

describe('parseYaml — documents and errors', () => {
  it('skips a leading document marker', () => {
    expect(parseYaml('---\nopenapi: 3.0.0\n')).toEqual({ openapi: '3.0.0' });
  });

  it('rejects multiple documents', () => {
    expect(() => parseYaml('a: 1\n---\nb: 2\n')).toThrow(YamlParseError);
  });

  it('rejects anchors and aliases with a helpful message', () => {
    expect(() => parseYaml('a: &anchor 1\nb: *anchor\n')).toThrow(/anchors/i);
  });

  it('rejects tabs in indentation', () => {
    expect(() => parseYaml('a:\n\tb: 1\n')).toThrow(YamlParseError);
  });

  it('rejects malformed mapping lines', () => {
    expect(() => parseYaml('just some text\nmore text\n')).toThrow(YamlParseError);
  });
});

describe('parseYaml — realistic OpenAPI excerpt', () => {
  const spec = `
openapi: 3.0.3
info:
  title: Swagger Petstore - OpenAPI 3.0
  description: |-
    This is a sample Pet Store Server based on the OpenAPI 3.0 specification.
  version: 1.0.11
servers:
  - url: https://petstore3.swagger.io/api/v3
tags:
  - name: pet
    description: Everything about your Pets
  - name: store
paths:
  /pet:
    put:
      tags: [pet]
      summary: Update an existing pet
      description: Update an existing pet by ID.
      operationId: updatePet
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Pet'
      responses:
        '200':
          description: Successful operation
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
        '400':
          description: Invalid ID supplied
  /pet/{petId}:
    get:
      tags: [pet]
      summary: Find pet by ID
      operationId: getPetById
      parameters:
        - name: petId
          in: path
          description: ID of pet to return
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '200':
          description: Successful operation
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
components:
  schemas:
    Pet:
      type: object
      required: [name, photoUrls]
      properties:
        id:
          type: integer
          format: int64
          example: 10
        name:
          type: string
          example: doggie
        status:
          type: string
          description: pet status in the store
          enum: [available, pending, sold]
`;

  it('parses the full document as expected', () => {
    const doc = parseYaml(spec) as any;
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBe('Swagger Petstore - OpenAPI 3.0');
    expect(doc.info.description).toBe(
      'This is a sample Pet Store Server based on the OpenAPI 3.0 specification.',
    );
    expect(doc.servers[0].url).toBe('https://petstore3.swagger.io/api/v3');
    expect(doc.paths['/pet'].put.operationId).toBe('updatePet');
    expect(doc.paths['/pet'].put.responses['400'].description).toBe('Invalid ID supplied');
    expect(doc.paths['/pet/{petId}'].get.parameters[0].schema.type).toBe('integer');
    const pet = doc.components.schemas.Pet;
    expect(pet.required).toEqual(['name', 'photoUrls']);
    expect(pet.properties.status.enum).toEqual(['available', 'pending', 'sold']);
    expect(pet.properties.id.example).toBe(10);
  });
});
