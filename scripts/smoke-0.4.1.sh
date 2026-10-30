#!/usr/bin/env bash
# Fresh-consumer smoke test for the published contractful-ts@0.4.1
set -euo pipefail

SMOKE=/home/z/my-project/tool-results/smoke-0.4.1
rm -rf "$SMOKE"
mkdir -p "$SMOKE"
cd "$SMOKE"

echo "== 1. fresh install from registry =="
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund contractful-ts@0.4.1 typescript@5 2>&1 | tail -1
node -p "'installed: contractful-ts@' + require('./node_modules/contractful-ts/package.json').version"

echo "== 2. runtime imports =="
node --input-type=module -e "
import { contract, defineApi, P, returns } from 'contractful-ts';
const Api = defineApi({
  name: 'smoke',
  base: 'https://api.example.com',
  contracts: {
    getUser: contract('GET /users/:id', {
      params: { id: P.integer() },
      responds: returns([{ status: 200, type: 'hash' }]),
    }),
  },
});
const client = new Api({});
console.log('defineApi + new Api({}): OK —', typeof client.getUser === 'function' ? 'contract mounted' : 'MISSING');
"

echo "== 3. CLI from node_modules/.bin =="
./node_modules/.bin/contractful-gen --help 2>&1 | head -4

echo "== 4. strict tsc against shipped .d.ts =="
cat > consumer.ts <<'EOF'
import { contract, defineApi, P, returns } from 'contractful-ts';
const Api = defineApi({
  name: 'smoke',
  base: 'https://api.example.com',
  contracts: {
    getUser: contract('GET /users/:id', {
      params: { id: P.integer() },
      responds: returns<{ id: number; name: string }>([{ status: 200, type: 'hash' }]),
    }),
  },
});
export async function main(): Promise<{ id: number; name: string } | null> {
  const client = new Api({});
  const res = await client.getUser({ id: 7 }).catch(() => null);
  return res.ok ? res.body : null;
}
EOF
./node_modules/.bin/tsc --strict --module nodenext --moduleResolution nodenext --target es2022 --noEmit consumer.ts && echo "strict tsc: OK"

echo "== ALL SMOKE CHECKS PASSED =="
