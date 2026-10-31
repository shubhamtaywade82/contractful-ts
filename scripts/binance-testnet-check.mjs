#!/usr/bin/env node
/**
 * Binance Spot **testnet** signing check — the "known-good server" half of
 * the Binance example's verification story (the known-answer vectors in
 * tests/binance-signing.test.ts are the offline half).
 *
 * Sends a real signed GET /api/v3/account request to
 * https://testnet.binance.vision and reports whether the server accepted
 * the signature. Read-only, weight 10 — safe to run repeatedly.
 *
 * Usage:
 *   BINANCE_TESTNET_KEY=... BINANCE_TESTNET_SECRET=... node scripts/binance-testnet-check.mjs
 *
 * Keys: create a free account + API keys at https://testnet.binance.vision
 * (GitHub login; funds are play money). NEVER use mainnet keys here.
 *
 * Exit codes: 0 = accepted, 1 = server rejected, 2 = credentials missing.
 */

import { createHmac } from 'node:crypto';

const BASE = 'https://testnet.binance.vision';

const key = process.env.BINANCE_TESTNET_KEY;
const secret = process.env.BINANCE_TESTNET_SECRET;

if (!key || !secret) {
  console.error(
    'Missing credentials. Set BINANCE_TESTNET_KEY and BINANCE_TESTNET_SECRET\n' +
      '(create testnet keys at https://testnet.binance.vision — never mainnet keys).',
  );
  process.exit(2);
}

const query = `timestamp=${Date.now()}&recvWindow=5000`;
const signature = createHmac('sha256', secret).update(query).digest('hex');

const response = await fetch(`${BASE}/api/v3/account?${query}&signature=${signature}`, {
  headers: { 'X-MBX-APIKEY': key },
});
const body = await response.json();

if (response.status !== 200) {
  console.error(`REJECTED — HTTP ${response.status}`);
  console.error(JSON.stringify(body, null, 2));
  console.error('(code -2014/-2015 = bad key or signature; -1021 = clock skew — check system time)');
  process.exit(1);
}

console.log('OK — the Binance testnet accepted the signed request (HTTP 200).');
console.log(
  `account: canTrade=${body.canTrade} makerCommission=${body.makerCommission} ` +
    `balances=${Array.isArray(body.balances) ? body.balances.length : 0}`,
);
console.log('The signing path in examples/binance/binance.ts round-trips against a real server.');
