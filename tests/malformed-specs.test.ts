/**
 * Malformed-spec rejection — garbage in must fail loudly, never silently
 * generate an empty or wrong client. These tests pin every entry point a
 * user can feed a spec through: raw text (JSON/YAML), parsed objects,
 * multi-source configs and the single-spec generator helpers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildApiIR,
  buildPostmanIR,
  generateFromSpec,
  generateFromSpecText,
  loadSpec,
  OpenApiError,
  runCodegen,
  type OpenApiSpec,
} from '../src/codegen/index.js';
import { PostmanError } from '../src/codegen/postman.js';

const VALID_SPEC: OpenApiSpec = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

describe('malformed spec text', () => {
  it('rejects broken JSON with an Invalid JSON error naming the origin', () => {
    expect(() => generateFromSpecText('{"openapi": "3.0.3", "paths": ')).toThrow(OpenApiError);
    expect(() => generateFromSpecText('{"openapi": "3.0.3", "paths": ')).toThrow(/Invalid JSON/);
  });

  it('rejects broken YAML with guidance (anchors/aliases hint)', () => {
    expect(() => generateFromSpecText('openapi: 3.0.3\ninfo:\n\ttitle: broken')).toThrow(OpenApiError);
    expect(() => generateFromSpecText('a: *anchor')).toThrow(OpenApiError);
  });

  it('rejects documents that parse to a scalar or array instead of an object', () => {
    expect(() => generateFromSpecText('just a plain string')).toThrow(/did not parse into an object/);
    expect(() => generateFromSpecText('[1, 2, 3]')).toThrow(/did not parse into an object/);
    expect(() => generateFromSpecText('42')).toThrow(/did not parse into an object/);
  });

  it('rejects a missing spec file with the path in the message', async () => {
    await expect(loadSpec('/definitely/not/here/spec.json')).rejects.toThrow(OpenApiError);
    await expect(loadSpec('/definitely/not/here/spec.json')).rejects.toThrow(/\/definitely\/not\/here\/spec\.json/);
  });
});

describe('malformed parsed documents', () => {
  it('rejects a document that is not OpenAPI (no version field) instead of emitting an empty client', () => {
    const notOpenApi = {
      info: { name: 'Some Collection', schema: 'v2.1.0' },
      item: [{ name: 'x', request: { method: 'GET', url: 'https://x.dev/a' } }],
    } as unknown as OpenApiSpec;

    expect(() => buildApiIR(notOpenApi)).toThrow(OpenApiError);
    expect(() => buildApiIR(notOpenApi)).toThrow(/does not look like OpenAPI/);
    expect(() => generateFromSpec(notOpenApi)).toThrow(OpenApiError);
  });

  it('rejects an empty object', () => {
    expect(() => buildApiIR({} as OpenApiSpec)).toThrow(/does not look like OpenAPI/);
  });

  it('a valid version without `paths` warns loudly instead of failing silently', () => {
    const noPaths = { openapi: '3.0.3', info: { title: 'Empty', version: '1' } } as unknown as OpenApiSpec;
    const ir = buildApiIR(noPaths);
    expect((ir.notes ?? []).join('\n')).toMatch(/no "paths" object/);
    expect(ir.groups).toHaveLength(0);
  });

  it('rejects a non-collection document passed to the Postman builder', () => {
    expect(() => buildPostmanIR({ foo: 'bar' } as never)).toThrow(PostmanError);
    expect(() => buildPostmanIR({ openapi: '3.0.3', paths: {} } as never)).toThrow(
      /does not look like a Postman Collection/,
    );
    expect(() => buildPostmanIR({ item: [] } as never)).toThrow(PostmanError); // info.name missing
  });

  it('accepts an empty-but-valid collection shape', () => {
    const ir = buildPostmanIR({ info: { name: 'Empty', schema: 'https://schema.postman.com/v2.1.0/collection.json' } } as never);
    expect(ir.title).toBe('Empty');
    expect(ir.groups).toHaveLength(0);
  });

  it('valid specs still pass through the same gates', () => {
    const ir = buildApiIR(VALID_SPEC);
    expect((ir.notes ?? []).join('\n')).not.toMatch(/no "paths" object/);
    expect(ir.groups).toHaveLength(1);
  });
});

describe('malformed specs through the config runner (CLI path)', () => {
  const TMP = resolve(fileURLToPath(new URL('./.malformed-tmp', import.meta.url)));
  const write = async (name: string, content: string): Promise<string> => {
    const path = join(TMP, name);
    await writeFile(path, content, 'utf8');
    return path;
  };

  beforeAll(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('propagates the OpenAPI rejection when the kind is forced', async () => {
    const path = await write(
      'asyncapi-as-openapi.yaml',
      'asyncapi: 2.6.0\ninfo: { title: Events, version: "1" }\n',
    );
    await expect(
      runCodegen({
        output: join(TMP, 'out-wrong-format'),
        sources: [{ path, namespace: 'wrong-format', kind: 'openapi' }],
      }),
    ).rejects.toThrow(OpenApiError);
  });

  it('propagates the Postman rejection when the kind is forced', async () => {
    const path = await write(
      'openapi-as-postman.json',
      JSON.stringify({ openapi: '3.0.3', info: { title: 'NotPostman', version: '1' }, paths: {} }),
    );
    await expect(
      runCodegen({
        output: join(TMP, 'out-wrong-format'),
        sources: [{ path, namespace: 'wrong-format', kind: 'postman' }],
      }),
    ).rejects.toThrow(PostmanError);
  });

  it('still fails loudly on undetectable sources', async () => {
    const path = await write('nobody.json', JSON.stringify({ 'i-am': 'nobody' }));
    await expect(
      runCodegen({
        output: join(TMP, 'out-mystery'),
        sources: [{ path, namespace: 'mystery' }],
      }),
    ).rejects.toThrow();
  });
});
