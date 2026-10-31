#!/usr/bin/env bash
# Tarball smoke test for contractful-ts — verifies the artifact consumers
# install: public exports, declaration files, subpath exports and the
# contractful-gen CLI binary. Run from the repo root after `npm run build`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="$(mktemp -d /tmp/contractful-smoke.XXXXXX)"
trap 'rm -rf "$SMOKE_DIR"' EXIT

echo "==> packing tarball"
mkdir -p "$SMOKE_DIR/pack"
cd "$SMOKE_DIR/pack"
npm pack "$REPO_ROOT" 2>&1 | grep -E '^npm notice (filename|total files)' || true
TARBALL="$(ls "$SMOKE_DIR/pack"/contractful-ts-*.tgz | head -1)"
if [ -z "$TARBALL" ]; then echo "pack produced no tarball" >&2; exit 1; fi

echo "==> creating consumer project"
mkdir -p "$SMOKE_DIR/consumer"
cd "$SMOKE_DIR/consumer"
cat > package.json <<'JSON'
{
  "name": "smoke-consumer",
  "private": true,
  "type": "module",
  "dependencies": { "contractful-ts": "file:../pack/contractful-ts-0.0.0.tgz" }
}
JSON
# Point the file: dependency at the actual tarball name.
TARBALL_BASENAME="$(basename "$TARBALL")"
sed -i "s|file:../pack/contractful-ts-0.0.0.tgz|file:../pack/$TARBALL_BASENAME|" package.json

echo "==> installing from tarball"
npm install --no-audit --no-fund --loglevel=error

echo "==> exercising public exports (runtime)"
cat > smoke.mjs <<'JS'
import {
  contract, defineApi, returns, P, auth, paginate, Contractful,
  createTokenManager, authProviderFromTokenManager, wsTicketAuthProvider,
  createPlatformClient, createEventsCacheInvalidator,
  defineEvents, subscribe, publish, createGraphQLWsClient,
  isRetryableError, IDEMPOTENT_METHODS, BODY_METHODS,
} from 'contractful-ts';
import { EventsClient, ReconnectingSocket } from 'contractful-ts';
import { runCodegen, detectSpecKind, generateFromOpenAPI } from 'contractful-ts/codegen';

// A tiny end-to-end contract through the mock-transport-free quick helper is
// network-bound; instead assert shapes and run a dispatch through a stub.
const Api = defineApi({
  name: 'SmokeApi',
  base: 'https://smoke.test',
  contracts: {
    listUsers: contract('GET /users', {
      params: { perPage: P.integer({ required: true, min: 1, max: 100 }) },
      responds: returns([{ status: 200, type: 'array' }]),
    }),
    createThing: contract('POST /things', {
      params: { name: P.string({ required: true }) },
      responds: [{ status: 201 }],
    }),
  },
});

// Inject a stub transport through ClientOptions.
const sent = [];
const client = new Api({
  transport: {
    send: async (req) => {
      sent.push(req);
      return { status: 200, headers: {}, body: [{ id: 1 }] };
    },
  },
});
const users = await client.listUsers({ perPage: 5 });
if (JSON.stringify(users) !== JSON.stringify([{ id: 1 }])) throw new Error('listUsers failed');
if (sent[0].query.get('perPage') !== '5') throw new Error('query serialization failed');

// retry-safety: POST must not retry on ambiguous failure
const post = new Api({
  transport: {
    send: async () => { throw new Error('network down'); },
  },
});
let attempts = 0;
const failing = new Api({
  name: 'Fail', base: 'https://fail.test',
  contracts: { create: contract('POST /x', { params: { n: P.integer({ required: true }) }, responds: [{ status: 201 }] }) },
});
failing.constructor; // class exists
try {
  await new (defineApi({
    name: 'Fail2', base: 'https://fail.test',
    contracts: { create: contract('POST /x', { params: { n: P.integer({ required: true }) } }) },
  }))({ transport: { send: async () => { attempts++; throw new Error('network down'); } } }).create({ n: 1 });
} catch { /* expected */ }
if (attempts !== 1) throw new Error(`POST retried ${attempts} times after ambiguous failure`);

if (!Array.isArray(IDEMPOTENT_METHODS) || !IDEMPOTENT_METHODS.includes('GET')) throw new Error('IDEMPOTENT_METHODS missing');
if (typeof returns !== 'function') throw new Error('returns not exported');
if (typeof paginate.cursor !== 'function') throw new Error('paginate broken');
if (typeof auth.bearer !== 'function') throw new Error('auth.bearer missing');
if (typeof Contractful.get !== 'function') throw new Error('quick helpers missing');
if (typeof EventsClient !== 'function' || typeof ReconnectingSocket !== 'function') throw new Error('events runtime missing');
if (typeof createGraphQLWsClient !== 'function') throw new Error('graphql-ws missing');
if (typeof runCodegen !== 'function' || typeof detectSpecKind !== 'function') throw new Error('codegen subpath broken');
if (typeof createTokenManager !== 'function' || typeof wsTicketAuthProvider !== 'function') throw new Error('token manager missing');
if (typeof createPlatformClient !== 'function') throw new Error('platform facade missing');
if (isRetryableError(new Error('x'))) throw new Error('isRetryableError misclassified');
console.log('runtime exports OK');
JS
node smoke.mjs

echo "==> declaration files resolve (tsc)"
cat > smoke.ts <<'TS'
import { contract, defineApi, returns, P, type ContractArgs, type ContractReturn } from 'contractful-ts';

const c = contract('GET /users', {
  params: { perPage: P.integer({ required: true }) },
  responds: returns<string[]>([{ status: 200, type: 'array' }]),
});

// Compile-time assertions: args stay strict, return type pinned.
export type Args = ContractArgs<typeof c>;
export type Ret = ContractReturn<typeof c>;
const _check: Ret = ['ok'];
const _args: Args = { perPage: 1 };
export const Api = defineApi({ name: 'A', base: 'https://a.test', contracts: { c } });
export { _check, _args };
TS
npm install --no-save --no-audit --no-fund --loglevel=error typescript@5.5 >/dev/null
./node_modules/.bin/tsc --strict --module nodenext --moduleResolution nodenext --target es2022 --noEmit smoke.ts
echo "declarations OK"

echo "==> contractful-gen CLI from installed package"
./node_modules/.bin/contractful-gen --spec "$REPO_ROOT/examples/openapi/petstore.yaml" --out ./generated --import-from contractful-ts

echo "==> generated output compiles strictly against the installed package"
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022",
    "skipLibCheck": true
  },
  "include": ["./generated/**/*.ts"]
}
JSON
./node_modules/.bin/tsc -p tsconfig.json
grep -q "defineApi" generated/pet.ts
grep -q "from \"contractful-ts\"" generated/pet.ts
echo "CLI + generated output OK ($(ls generated | wc -l) files)"

echo "==> SMOKE TEST PASSED"
