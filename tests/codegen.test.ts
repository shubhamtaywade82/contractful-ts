import { afterAll, describe, expect, it } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  dereference,
  generateFromSpecText,
  buildApiIR,
  emitContracts,
  OpenApiError,
  parseSpecText,
  toCamelCase,
} from '../src/codegen/index.js';
import type { OpenApiSpec } from '../src/codegen/index.js';

const TMP = resolve(fileURLToPath(new URL('./.codegen-tmp', import.meta.url)));

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const PETSTORE_JSON = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.test/v1' }],
  paths: {
    '/pets': {
      get: {
        tags: ['pets'],
        operationId: 'listPets',
        summary: 'List all pets',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: 'sort',
            in: 'query',
            schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
          },
        ],
        responses: {
          '200': {
            description: 'A list of pets',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
              },
            },
          },
        },
      },
      post: {
        tags: ['pets'],
        operationId: 'createPet',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePetInput' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
            },
          },
          '422': { description: 'Validation error' },
        },
      },
    },
    '/pets/{petId}': {
      get: {
        tags: ['pets'],
        operationId: 'showPetById',
        parameters: [
          {
            name: 'petId',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'A pet',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
            },
          },
          '404': { description: 'Not found' },
        },
      },
    },
    '/store/inventory': {
      get: {
        tags: ['store'],
        operationId: 'getInventory',
        responses: {
          '200': {
            description: 'Inventories',
            content: {
              'application/json': { schema: { type: 'object' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer', format: 'int64' },
          name: { type: 'string' },
          tag: { type: 'string' },
        },
      },
      CreatePetInput: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          tag: { type: 'string' },
        },
      },
    },
  },
});

describe('toCamelCase', () => {
  it('snake_case and friends', () => {
    expect(toCamelCase('per_page')).toBe('perPage');
    expect(toCamelCase('HTTP-Status-Code')).toBe('httpStatusCode');
    expect(toCamelCase('alreadyCamel')).toBe('alreadyCamel');
    expect(toCamelCase('')).toBe('value');
  });
});

describe('dereference', () => {
  it('resolves local $refs, deeply', () => {
    const spec = parseSpecText(PETSTORE_JSON);
    const doc = dereference({ data: { $ref: '#/components/schemas/Pet' } }, spec) as any;
    expect(doc.data.properties.id.type).toBe('integer');
  });

  it('breaks cycles instead of recursing forever', () => {
    const spec = parseSpecText(
      JSON.stringify({
        components: {
          schemas: {
            Node: {
              type: 'object',
              properties: {
                child: { $ref: '#/components/schemas/Node' },
              },
            },
          },
        },
      }),
    );
    const doc = dereference({ $ref: '#/components/schemas/Node' }, spec) as any;
    expect(doc.properties.child).toEqual({});
  });

  it('rejects external refs', () => {
    expect(() => dereference({ $ref: './other.yaml#/Foo' }, {} as OpenApiSpec)).toThrow(OpenApiError);
  });

  it('throws on unresolvable pointers', () => {
    expect(() => dereference({ $ref: '#/components/schemas/Missing' }, parseSpecText(PETSTORE_JSON))).toThrow(
      /Unresolvable/,
    );
  });
});

describe('generateFromSpecText — IR', () => {
  const { ir } = generateFromSpecText(PETSTORE_JSON);

  it('extracts title, version and base', () => {
    expect(ir.title).toBe('Petstore');
    expect(ir.version).toBe('1.0.0');
    expect(ir.base).toBe('https://petstore.test/v1');
  });

  it('groups by tag with kebab-case file names', () => {
    const names = ir.groups.map((g) => g.name).sort();
    expect(names).toEqual(['pets', 'store']);
    const pets = ir.groups.find((g) => g.name === 'pets')!;
    expect(pets.fileName).toBe('pets.ts');
    expect(pets.constName).toBe('petsApi');
    expect(pets.operations.map((o) => o.name).sort()).toEqual(['createPet', 'listPets', 'showPetById']);
  });

  it('maps parameters with constraints and wire names', () => {
    const pets = ir.groups.find((g) => g.name === 'pets')!;
    const list = pets.operations.find((o) => o.name === 'listPets')!;
    const limit = list.params.find((p) => p.wireName === 'limit')!;
    expect(limit.tsName).toBe('limit');
    expect(limit.location).toBe('query');
    expect(limit.schema.minimum).toBe(1);
    expect(limit.schema.maximum).toBe(100);
    expect(limit.schema.default).toBe(20);
    const sort = list.params.find((p) => p.wireName === 'sort')!;
    expect(sort.schema.enumValues).toEqual(['asc', 'desc']);
  });

  it('converts {param} routes to :param and forces required path params', () => {
    const pets = ir.groups.find((g) => g.name === 'pets')!;
    const show = pets.operations.find((o) => o.name === 'showPetById')!;
    expect(show.path).toBe('/pets/:petId');
    const petId = show.params.find((p) => p.wireName === 'petId')!;
    expect(petId.location).toBe('path');
    expect(petId.required).toBe(true);
  });

  it('spreads request-body object schemas into body params', () => {
    const pets = ir.groups.find((g) => g.name === 'pets')!;
    const create = pets.operations.find((o) => o.name === 'createPet')!;
    const name = create.params.find((p) => p.wireName === 'name')!;
    expect(name.location).toBe('body');
    expect(name.required).toBe(true);
    expect(name.schema.minLength).toBe(1);
    expect(create.params.find((p) => p.wireName === 'tag')!.required).toBe(false);
  });

  it('derives response types from response schemas', () => {
    const pets = ir.groups.find((g) => g.name === 'pets')!;
    const list = pets.operations.find((o) => o.name === 'listPets')!;
    expect(list.responds).toEqual([{ status: 200, type: 'array' }]);
    const create = pets.operations.find((o) => o.name === 'createPet')!;
    expect(create.responds).toEqual([
      { status: 201, type: 'hash' },
      { status: 422, type: undefined },
    ]);
  });

  it('supports grouping by path segment', () => {
    const { ir } = generateFromSpecText(PETSTORE_JSON, { groupBy: 'path' });
    expect(ir.groups.map((g) => g.name).sort()).toEqual(['pets', 'store']);
  });

  it('derives method names from the route when operationId is absent', () => {
    const spec = parseSpecText(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'X', version: '1' },
        servers: [{ url: 'https://x.test' }],
        paths: {
          '/a/b': { get: { responses: { '200': { description: 'ok' } } } },
          '/a/{id}/c': { delete: { responses: { '204': { description: 'ok' } } } },
        },
      }),
    );
    const ir = buildApiIR(spec, {});
    const names = ir.groups.flatMap((g) => g.operations.map((o) => o.name));
    expect(names.sort()).toEqual(['deleteAByIdC', 'getAB']);
  });
});

describe('generateFromSpecText — emitted code', () => {
  it('emits one file per group plus an index', () => {
    const { files } = generateFromSpecText(PETSTORE_JSON);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['index.ts', 'pets.ts', 'store.ts']);

    const pets = files.find((f) => f.path === 'pets.ts')!;
    expect(pets.content).toContain(`import { defineApi, contract, P } from "contractful-ts";`);
    expect(pets.content).toContain('export const petsApi = defineApi({');
    expect(pets.content).toContain('listPets: contract("GET /pets", {');
    expect(pets.content).toContain('limit: P.integer({ in: "query", default: 20, min: 1, max: 100 })');
    expect(pets.content).toContain('sort: P.string({ in: "query", default: "asc", inclusion: ["asc", "desc"] })');
    expect(pets.content).toContain('petId: P.string({ required: true, length: { min: 1 } })');
    expect(pets.content).toContain('createPet: contract("POST /pets", {');
    expect(pets.content).toContain('name: P.string({ required: true, in: "body", length: { min: 1, max: 64 } })');
    expect(pets.content).toContain('responds: [{ status: 200, type: "array" }]');
    expect(pets.content).toContain('responds: [{ status: 201, type: "hash" }, { status: 422 }]');
    expect(pets.content).toContain('// Auto-generated by contractful-gen');

    const index = files.find((f) => f.path === 'index.ts')!;
    expect(index.content).toContain(`export * from './pets.js';`);
    expect(index.content).toContain(`export * from './store.js';`);
  });

  it('honors importFrom and base overrides', () => {
    const { files } = generateFromSpecText(PETSTORE_JSON, {
      importFrom: '@acme/contractful',
      base: 'https://custom.test/api',
    });
    const pets = files.find((f) => f.path === 'pets.ts')!;
    expect(pets.content).toContain('from "@acme/contractful"');
    expect(pets.content).toContain('"https://custom.test/api"');
  });

  it('emits the same structure from a YAML spec', () => {
    const yamlSpec = `
openapi: 3.0.0
info:
  title: Yamlstore
  version: 2.0.0
servers:
  - url: https://yaml.test
paths:
  /items:
    get:
      tags: [items]
      operationId: listItems
      parameters:
        - name: per_page
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 50
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: array
`;
    const { files, ir } = generateFromSpecText(yamlSpec);
    expect(ir.base).toBe('https://yaml.test');
    const items = files.find((f) => f.path === 'items.ts')!;
    expect(items.content).toContain('perPage: P.integer({ as: "per_page", in: "query", min: 1, max: 50 })');
  });
});

describe('generated code is executable', () => {
  it('imports, validates and dispatches against a mock transport', async () => {
    // Generate code that imports the built library through a file:// URL,
    // write it to a temp dir and dynamically import it — a full round-trip:
    // OpenAPI JSON -> emitted contracts -> running client.
    const distUrl = new URL('../dist/index.js', import.meta.url).href;
    const { files } = generateFromSpecText(PETSTORE_JSON, { importFrom: distUrl });

    await mkdir(TMP, { recursive: true });
    for (const file of files) {
      await writeFile(join(TMP, file.path), file.content, 'utf8');
    }

    const mod = await import(pathToFileURL(join(TMP, 'pets.ts')).href);
    expect(mod.petsApi).toBeDefined();
    expect(typeof mod.petsApi).toBe('function');

    const requests: { url: string; query: URLSearchParams; body: unknown }[] = [];
    const transport = {
      send: async (req: { url: string; method?: string; query: URLSearchParams; body: unknown }) => {
        requests.push(req);
        if (req.url.endsWith('/pets/abc')) {
          return { status: 200, headers: {}, body: { id: 1, name: 'Rex', tag: 'dog' } };
        }
        if (req.method === 'POST') {
          return { status: 201, headers: {}, body: { id: 9, name: 'Flip' } };
        }
        return { status: 200, headers: {}, body: [{ id: 1, name: 'Rex', tag: 'dog' }] };
      },
    };
    const client = new mod.petsApi({ transport });

    // Query params, defaults and wire names applied.
    const pets = await client.listPets({ limit: 5 });
    expect(pets).toEqual([{ id: 1, name: 'Rex', tag: 'dog' }]);
    expect(requests[0]!.query.get('limit')).toBe('5');
    expect(requests[0]!.query.get('sort')).toBe('asc');
    expect(requests[0]!.url).toBe('https://petstore.test/v1/pets');

    // Closed schema from generated specs: unknown keys rejected.
    await expect(client.listPets({ nope: 1 })).rejects.toThrow(/not declared/);

    // Constraints from the spec enforced: limit must be 1..100.
    await expect(client.listPets({ limit: 500 })).rejects.toThrow(/must be <= 100/);

    // Path params work.
    await client.showPetById({ petId: 'abc' });
    expect(requests[requests.length - 1]!.url).toBe('https://petstore.test/v1/pets/abc');

    // Body params sent as JSON (optional ones included when provided).
    await client.createPet({ name: 'Flip', tag: 'cat' });
    expect(requests[requests.length - 1]!.body).toEqual({ name: 'Flip', tag: 'cat' });
  });
});
