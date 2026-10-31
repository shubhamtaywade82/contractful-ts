/**
 * Live Binance Spot **testnet** verification — the audit's "validate signed
 * requests against a controlled test environment", wired so CI stays
 * hermetic: the suite is skipped unless BINANCE_TESTNET_KEY /
 * BINANCE_TESTNET_SECRET are present in the environment.
 *
 *   BINANCE_TESTNET_KEY=... BINANCE_TESTNET_SECRET=... npx vitest run tests/binance-testnet.test.ts
 *
 * (Offline known-answer vectors live in tests/binance-signing.test.ts and
 * always run; this file proves the same signing path against the real
 * testnet server.)
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const KEY = process.env.BINANCE_TESTNET_KEY;
const SECRET = process.env.BINANCE_TESTNET_SECRET;
const BASE = 'https://testnet.binance.vision';

const maybe = KEY && SECRET ? describe : describe.skip;

maybe('Binance testnet (live, opt-in via env)', () => {
  it(
    'accepts a signed GET /api/v3/account request',
    { timeout: 20_000 },
    async () => {
      const query = `timestamp=${Date.now()}&recvWindow=5000`;
      const signature = createHmac('sha256', SECRET).update(query).digest('hex');

      const response = await fetch(`${BASE}/api/v3/account?${query}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': KEY },
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toHaveProperty('canTrade');
      expect(Array.isArray(body.balances)).toBe(true);
    },
  );

  it(
    'rejects a tampered signature (the check has teeth server-side)',
    { timeout: 20_000 },
    async () => {
      const query = `timestamp=${Date.now()}&recvWindow=5000`;
      const signature = createHmac('sha256', SECRET).update(query).digest('hex');
      const tampered = `${signature.slice(0, -1)}${signature.slice(-1) === '0' ? '1' : '0'}`;

      const response = await fetch(`${BASE}/api/v3/account?${query}&signature=${tampered}`, {
        headers: { 'X-MBX-APIKEY': KEY },
      });
      expect(response.status).toBe(401);
    },
  );
});
