/**
 * P1 regression suite: OpenAPI request-generation correctness.
 *
 * Each case pins a spec → IR → emitted-contract behavior that previously
 * generated requests that did not match the source specification:
 *
 *   1. path-level parameters are inherited unless overridden (name + in)
 *   2. Swagger 2.0 `formData` maps to form-encoded body params, not query
 *   3. `requestBody.required` survives flattening (`bodyRequired`)
 *   4. scalar / array / free-form bodies serialize as the payload itself
 *      (`raw: true`), never `{ body: value }`
 *   5. recursive `$ref` cycles become free-form objects with a warning,
 *      never silently-wrong scalars
 *   6. `allOf` merges; `oneOf` / `anyOf` / `nullable` warn instead of
 *      silently dropping information
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildApiIR,
  emitContracts,
  generateFromSpecText,
  parseSpecText,
} from '../src/codegen/index.js';

const TMP = resolve(fileURLToPath(new URL('./.openapi-fixes-tmp', import.meta.url)));

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function spec(paths: object, extra: object = {}): string {
  return JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Fixtures', version: '1.0.0' },
    servers: [{ url: 'https://fixtures.test' }],
    paths,
    ...extra,
  });
}

function firstOp(ir: ReturnType<typeof buildApiIR>, name: string) {
  for (const group of ir.groups) {
    const op = group.operations.find((o) => o.name === name);
    if (op) return op;
  }
  throw new Error(`operation ${name} not found`);
}

function emitted(ir: ReturnType<typeof buildApiIR>): string {
  return emitContracts(ir)
    .map((f) => f.content)
    .join('\n');
}

describe('parameter inheritance (path-level vs operation-level)', () => {
  it('inherits path-level parameters when the operation declares none', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/things/{thingId}': {
        parameters: [
          { name: 'thingId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
        ],
        get: {
          operationId: 'getThing',
          responses: { '200': { description: 'ok' } },
        },
      },
    })));
    const op = firstOp(ir, 'getThing');
    expect(op.params.map((p) => `${p.wireName}:${p.location}`)).toEqual([
      'thingId:path',
      'verbose:query',
    ]);
  });

  it('inherits path-level parameters alongside operation-level ones, and the operation entry wins on (name, in) conflicts', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/things': {
        parameters: [
          { name: 'shared', in: 'query', schema: { type: 'string', default: 'from-path' } },
          { name: 'pathOnly', in: 'query', schema: { type: 'integer' } },
        ],
        get: {
          operationId: 'listThings',
          parameters: [
            { name: 'shared', in: 'query', schema: { type: 'string', default: 'from-op' } },
            { name: 'opOnly', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    })));
    const op = firstOp(ir, 'listThings');
    // One `shared` (the operation-level override), plus both uniques.
    const shared = op.params.filter((p) => p.wireName === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]!.schema.default).toBe('from-op');
    expect(op.params.map((p) => p.wireName).sort()).toEqual(['opOnly', 'pathOnly', 'shared']);
  });
});

describe('Swagger 2.0 formData', () => {
  const v2Spec = JSON.stringify({
    swagger: '2.0',
    info: { title: 'V2 Forms', version: '1.0.0' },
    host: 'forms.test',
    basePath: '/v2',
    schemes: ['https'],
    paths: {
      '/subscribe': {
        post: {
          operationId: 'subscribe',
          consumes: ['application/x-www-form-urlencoded'],
          parameters: [
            { name: 'email', in: 'formData', required: true, type: 'string' },
            { name: 'topics', in: 'formData', required: false, type: 'array', items: { type: 'string' } },
            { name: 'avatar', in: 'formData', required: false, type: 'file' },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });

  it('maps formData to body placement with form: true (never query)', () => {
    const ir = buildApiIR(parseSpecText(v2Spec));
    const op = firstOp(ir, 'subscribe');
    expect(op.form).toBe(true);
    expect(op.params.map((p) => `${p.wireName}:${p.location}`)).toEqual([
      'email:body',
      'topics:body',
      'avatar:body',
    ]);
    const out = emitted(ir);
    expect(out).toContain('in: "body"');
    expect(out).toContain('form: true');
    expect(out).not.toMatch(/avatar: P\.[a-z]+.\(.*in: "query"/);
  });

  it('warns that file uploads are emitted as placeholders', () => {
    const ir = buildApiIR(parseSpecText(v2Spec));
    const op = firstOp(ir, 'subscribe');
    expect(op.warnings?.some((w) => w.includes('avatar') && w.includes('file upload'))).toBe(true);
    expect(ir.notes?.some((n) => n.includes('file upload'))).toBe(true);
  });
});

describe('requestBody.required propagation', () => {
  it('emits bodyRequired when a required body has only optional properties', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    color: { type: 'string' },
                    weight: { type: 'number' },
                  },
                  // no `required` list — every property optional
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    })));
    const op = firstOp(ir, 'createThing');
    expect(op.bodyRequired).toBe(true);
    expect(op.params.every((p) => !p.required)).toBe(true);
    expect(emitted(ir)).toContain('bodyRequired: true');
  });

  it('does not emit bodyRequired for optional request bodies', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/things': {
        post: {
          operationId: 'maybeThing',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { color: { type: 'string' } } },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    })));
    expect(firstOp(ir, 'maybeThing').bodyRequired).toBeUndefined();
  });
});

describe('scalar / array / free-form request bodies', () => {
  it('emits a raw body parameter for a string body', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/echo': {
        post: {
          operationId: 'echo',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'string', minLength: 1 } } },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    })));
    const op = firstOp(ir, 'echo');
    expect(op.params).toHaveLength(1);
    expect(op.params[0]!.raw).toBe(true);
    expect(op.params[0]!.required).toBe(true);
    expect(emitted(ir)).toContain('body: P.string({ required: true, in: "body", raw: true');
  });

  it('emits a raw body parameter for an array body', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/tags': {
        post: {
          operationId: 'setTags',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'string' }, minItems: 1 },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    })));
    const op = firstOp(ir, 'setTags');
    expect(op.params[0]!.raw).toBe(true);
    expect(emitted(ir)).toContain('body: P.array({ required: true, in: "body", raw: true');
  });

  it('emits a raw hash for a free-form object body (no properties)', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/meta': {
        post: {
          operationId: 'setMeta',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    })));
    const op = firstOp(ir, 'setMeta');
    expect(op.params[0]!.raw).toBe(true);
    expect(emitted(ir)).toContain('body: P.hash({ required: true, in: "body", raw: true');
  });

  it('request bodies with urlencoded content set form: true (OpenAPI 3)', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/form': {
        post: {
          operationId: 'submitForm',
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  required: ['a'],
                  properties: { a: { type: 'integer' }, b: { type: 'string' } },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    })));
    const op = firstOp(ir, 'submitForm');
    expect(op.form).toBe(true);
    expect(op.params.find((p) => p.wireName === 'a')!.required).toBe(true);
    expect(emitted(ir)).toContain('form: true');
  });

  it('multipart request bodies produce a warning', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/upload': {
        post: {
          operationId: 'upload',
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    })));
    const op = firstOp(ir, 'upload');
    expect(op.warnings?.some((w) => w.includes('multipart'))).toBe(true);
  });
});

describe('schema combinators and recursion', () => {
  it('merges allOf member schemas (properties + required union, tighter bounds)', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
                    {
                      type: 'object',
                      properties: { weight: { type: 'number', minimum: 0, maximum: 500 } },
                    },
                  ],
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    })));
    const op = firstOp(ir, 'createPet');
    expect(op.params.map((p) => p.wireName).sort()).toEqual(['name', 'weight']);
    expect(op.params.find((p) => p.wireName === 'name')!.required).toBe(true);
    expect(op.params.find((p) => p.wireName === 'weight')!.schema.maximum).toBe(500);
    expect(op.warnings).toBeUndefined();
  });

  it('recursive $ref cycles emit free-form objects and a warning — never scalars', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/nodes': {
        post: {
          operationId: 'createNode',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Node' } },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    }, {
      components: {
        schemas: {
          Node: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
              parent: { $ref: '#/components/schemas/Node' },
            },
          },
        },
      },
    })));
    const op = firstOp(ir, 'createNode');
    const parent = op.params.find((p) => p.wireName === 'parent')!;
    // Free-form object — NOT the silently-wrong P.string() an empty
    // placeholder used to produce.
    expect(parent.schema.type).toBe('object');
    expect(parent.schema.description).toMatch(/recursive schema/);
    expect(ir.notes?.some((n) => n.includes('recursive $ref'))).toBe(true);
    const out = emitted(ir);
    expect(out).toContain('parent: P.hash(');
    expect(out).toContain('recursive schema (#/components/schemas/Node)');
  });

  it('oneOf parameters emit P.custom with a warning instead of dropping the construct', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/values': {
        post: {
          operationId: 'setValue',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'number' },
                  ],
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    })));
    const op = firstOp(ir, 'setValue');
    expect(op.params[0]!.schema.untyped).toBe(true);
    expect(op.warnings?.some((w) => w.includes('oneOf'))).toBe(true);
    expect(emitted(ir)).toContain('body: P.custom(() => true,');
  });

  it('nullable schemas warn that null means "not provided"', () => {
    const ir = buildApiIR(parseSpecText(spec({
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { note: { type: 'string', nullable: true } },
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    })));
    const op = firstOp(ir, 'createThing');
    expect(op.warnings?.some((w) => w.includes('nullable'))).toBe(true);
  });
});

describe('generated wire format matches the spec (executable round-trip)', () => {
  it('scalar, array, form and empty-object bodies serialize exactly as the spec intends', async () => {
    const distUrl = new URL('../dist/index.js', import.meta.url).href;
    const { files } = generateFromSpecText(
      spec({
        '/echo': {
          post: {
            operationId: 'echo',
            tags: ['wire'],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'string' } } },
            },
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } },
          },
        },
        '/tags': {
          post: {
            operationId: 'setTags',
            tags: ['wire'],
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { type: 'array', items: { type: 'string' } } },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/form': {
          post: {
            operationId: 'submitForm',
            tags: ['wire'],
            requestBody: {
              required: true,
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    required: ['a'],
                    properties: { a: { type: 'integer' }, b: { type: 'string' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/things': {
          post: {
            operationId: 'createThing',
            tags: ['wire'],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { color: { type: 'string' } } },
                },
              },
            },
            responses: { '201': { description: 'created' } },
          },
        },
      }),
      { importFrom: distUrl },
    );

    await mkdir(TMP, { recursive: true });
    for (const file of files) {
      await writeFile(join(TMP, file.path), file.content, 'utf8');
    }
    const mod = await import(pathToFileURL(join(TMP, 'wire.ts')).href);

    const bodies: unknown[] = [];
    const transport = {
      send: async (req: { body: unknown; method?: string; url: string }) => {
        bodies.push(req.body);
        const isEcho = req.url.endsWith('/echo');
        const isThings = req.url.endsWith('/things');
        return {
          status: isThings ? 201 : 200,
          headers: {},
          body: isEcho ? 'echo' : { ok: true },
        };
      },
    };
    const client = new mod.wireApi({ transport });

    // Scalar body: the payload IS the string — not { body: "hello" }.
    await client.echo({ body: 'hello' });
    expect(bodies.at(-1)).toBe('hello');

    // Array body: the payload IS the array.
    await client.setTags({ body: ['a', 'b'] });
    expect(bodies.at(-1)).toEqual(['a', 'b']);

    // Form body: URLSearchParams with the declared wire names.
    await client.submitForm({ a: 1, b: 'two' });
    const form = bodies.at(-1);
    expect(form).toBeInstanceOf(URLSearchParams);
    expect(String(form)).toBe('a=1&b=two');

    // Required body, all-optional properties, nothing provided: `{}` is sent.
    await client.createThing({});
    expect(bodies.at(-1)).toEqual({});
  });
});
