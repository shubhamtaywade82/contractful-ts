/**
 * Codegen features from the platform-client design: securitySchemes → typed
 * auth surface, operation `security` metadata, `x-client-domain` grouping,
 * CLIENT_METADATA with source hashes, and the unified platform.ts facade.
 */

import { describe, expect, it } from 'vitest';
import { buildApiIR, emitContracts, type OpenApiSpec } from '../src/codegen/index.js';
import { runCodegen, hashSource, generatorVersion } from '../src/codegen/config.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECURED_SPEC: OpenApiSpec = {
  openapi: '3.1.0',
  info: { title: 'Secured API', version: '2.0.0' },
  servers: [{ url: 'https://api.secured.test' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      OAuth2: {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://auth.secured.test/oauth/token',
            scopes: { 'orders:read': 'Read orders', 'orders:write': 'Write orders' },
          },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }],
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        tags: ['orders'],
        security: [{ OAuth2: ['orders:read'] }],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'createOrder',
        tags: ['orders'],
        security: [{ OAuth2: ['orders:write'] }],
        responses: { '201': { description: 'created' } },
      },
    },
    '/admin/stats': {
      'x-client-domain': 'admin',
      get: {
        operationId: 'getStats',
        tags: ['misc'],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
} as unknown as OpenApiSpec;

describe('securitySchemes IR + typed auth emission', () => {
  const ir = buildApiIR(SECURED_SPEC);

  it('parses securitySchemes into the IR', () => {
    expect(ir.securitySchemes).toHaveLength(3);
    const apiKey = ir.securitySchemes!.find((s) => s.name === 'ApiKeyAuth')!;
    expect(apiKey.type).toBe('apiKey');
    expect(apiKey.in).toBe('header');
    expect(apiKey.paramName).toBe('X-API-Key');

    const oauth = ir.securitySchemes!.find((s) => s.name === 'OAuth2')!;
    expect(oauth.flows!.clientCredentials!.tokenUrl).toBe('https://auth.secured.test/oauth/token');
    expect(Object.keys(oauth.flows!.clientCredentials!.scopes)).toEqual(['orders:read', 'orders:write']);
  });

  it('carries operation security (scopes) into the IR and emitted contracts', () => {
    const orders = ir.groups.find((g) => g.name === 'orders')!;
    const list = orders.operations.find((o) => o.name === 'listOrders')!;
    expect(list.security).toEqual(['OAuth2', 'orders:read']);

    const files = emitContracts(ir);
    const body = files.find((f) => f.path === 'orders.ts')!.content;
    expect(body).toContain('security: ["OAuth2", "orders:read"]');
    expect(body).toContain('security: ["OAuth2", "orders:write"]');
  });

  it('inherits the global security requirement when the operation declares none', () => {
    const admin = ir.groups.find((g) => g.name === 'admin')!;
    expect(admin).toBeDefined(); // x-client-domain moved it out of its tag group
    const stats = admin.operations.find((o) => o.name === 'getStats')!;
    expect(stats.security).toEqual(['BearerAuth']);
  });

  it('emits auth.ts with SecuritySchemeName, AuthOptions and scopes', () => {
    const files = emitContracts(ir);
    const auth = files.find((f) => f.path === 'auth.ts');
    expect(auth).toBeDefined();
    expect(auth!.content).toContain('export type SecuritySchemeName =\n  | "ApiKeyAuth"\n  | "BearerAuth"\n  | "OAuth2";');
    expect(auth!.content).toContain('paramName: "X-API-Key"');
    expect(auth!.content).toContain('tokenProvider: (context: AuthContext) => string | Promise<string>');
    expect(auth!.content).toContain('oauth: { clientId: string; clientSecret?: string; scopes?: string[] }');
    expect(auth!.content).toContain('export type SecurityScope = "orders:read" | "orders:write";');
    expect(auth!.content).toContain('import type { AuthProvider, AuthContext } from "contractful-ts";');

    const index = files.find((f) => f.path === 'index.ts')!;
    expect(index.content).toContain("export * from './auth.js';");
  });

  it('omits auth.ts when the spec declares no schemes', () => {
    const plain = buildApiIR({
      openapi: '3.0.0',
      info: { title: 'Plain' },
      paths: { '/x': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } } } } },
    } as unknown as OpenApiSpec);
    expect(plain.securitySchemes).toBeUndefined();
    const files = emitContracts(plain);
    expect(files.find((f) => f.path === 'auth.ts')).toBeUndefined();
  });
});

const REST_SPEC = `openapi: 3.0.0
info:
  title: Shop REST
  version: 1.0.0
servers:
  - url: https://api.shop.test
paths:
  /products:
    get:
      operationId: listProducts
      tags: [products]
      responses:
        "200": { description: ok }
`;

const EVENTS_SPEC = `asyncapi: 2.6.0
info:
  title: Shop Events
  version: 1.0.0
servers:
  production: { url: "wss://events.shop.test", protocol: wss }
channels:
  product.created:
    publish:
      message:
        name: ProductCreated
        payload:
          type: object
          properties:
            productId: { type: string }
`;

describe('multi-source platform emission', () => {
  const dir = join(tmpdir(), `contractful-platform-${Date.now()}`);

  function fixture(path: string, content: string): string {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    return full;
  }

  it('emits platform.ts + CLIENT_METADATA when both transports exist', async () => {
    const rest = fixture('specs/rest.yaml', REST_SPEC);
    const events = fixture('specs/events.yaml', EVENTS_SPEC);

    const bundle = await runCodegen({
      output: join(dir, 'generated'),
      clientName: 'shop-web',
      sources: [
        { path: rest, namespace: 'rest' },
        { path: events, namespace: 'events' },
      ],
    });

    const platform = bundle.files.find((f) => f.path === 'platform.ts');
    expect(platform).toBeDefined();
    expect(platform!.content).toContain("import { productsApi } from './rest/index.js';");
    expect(platform!.content).toContain("import { shopEventsEvents } from './events/index.js';");
    expect(platform!.content).toContain('authProviderResolver');
    expect(platform!.content).toContain('products: new productsApi(http),');
    expect(platform!.content).toContain(
      'events: new shopEventsEvents({ ...options.events, authProvider: options.events?.authProvider ?? auth }),',
    );
    expect(platform!.content).toContain("'X-Client-Name'");
    expect(platform!.content).toContain('dispose: async () => {');

    const index = bundle.files.find((f) => f.path === 'index.ts')!;
    expect(index.content).toContain("export * from './platform.js';");
    expect(index.content).toContain('export const CLIENT_METADATA = {');
    expect(index.content).toContain(`generatorVersion: ${JSON.stringify(generatorVersion())},`);
    expect(index.content).toContain(`hash: ${JSON.stringify(hashSource(REST_SPEC))}`);
    expect(index.content).toContain(`hash: ${JSON.stringify(hashSource(EVENTS_SPEC))}`);

    // Per-namespace indexes carry their own CLIENT_METADATA too.
    const restIndex = bundle.files.find((f) => f.path === 'rest/index.ts')!;
    expect(restIndex.content).toContain('export const CLIENT_METADATA = {');

    rmSync(dir, { recursive: true, force: true });
  });

  it('skips platform.ts when only HTTP sources exist', async () => {
    const rest = fixture('specs/rest-only.yaml', REST_SPEC);
    const bundle = await runCodegen({
      output: join(dir, 'generated'),
      sources: [{ path: rest, namespace: 'rest' }],
    });
    expect(bundle.files.find((f) => f.path === 'platform.ts')).toBeUndefined();
    expect(bundle.files.find((f) => f.path === 'index.ts')!.content).not.toContain("export * from './platform.js'");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('generated platform client compiles', () => {
  it('type-checks against the runtime', async () => {
    // Same directory depth as examples/multi-format/generated so the
    // contractful-ts paths mapping resolves to the project dist.
    const dir = join(process.cwd(), 'tests', '.tmp-platform-check');
    rmSync(dir, { recursive: true, force: true });
    const rest = join(dir, 'rest.yaml');
    const events = join(dir, 'events.yaml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(rest, REST_SPEC);
    writeFileSync(events, EVENTS_SPEC);

    const bundle = await runCodegen({
      output: join(dir, 'generated'),
      sources: [
        { path: rest, namespace: 'rest' },
        { path: events, namespace: 'events' },
      ],
    });
    const out = join(dir, 'generated');
    for (const file of bundle.files) {
      const full = join(out, file.path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, file.content);
    }
    writeFileSync(
      join(out, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            skipLibCheck: true,
            baseUrl: '.',
            paths: {
              'contractful-ts': ['../../../dist/index.d.ts'],
              'contractful-ts/events': ['../../../dist/events/index.d.ts'],
            },
          },
          include: ['**/*.ts'],
        },
        null,
        2,
      ),
    );

    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('npx', ['tsc', '-p', join(out, 'tsconfig.json')], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
