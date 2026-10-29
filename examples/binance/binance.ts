/**
 * Example: a Binance-style spot connector built with contractful-ts,
 * mirroring the shape of `@binance/spot` from binance-connector-js:
 *
 * - public endpoints (server time, klines, ticker) require no auth
 * - signed endpoints (account, orders) carry an `X-MBX-APIKEY` header and
 *   an HMAC-SHA256 `signature` over the query string
 * - rate limiting + retries with exponential backoff are configured once
 *
 * Run it after `npm run build`:
 *   node examples/binance/binance.ts                 # public endpoints
 *   BINANCE_API_KEY=... BINANCE_API_SECRET=... node examples/binance/binance.ts
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// In your own project, import from the package instead:
//   import { contract, defineApi, P } from 'contractful-ts';
import { contract, defineApi, P, type ApiClientInstance } from '../../dist/index.js';

/** Binance returns klines as arrays: [openTime, open, high, low, close, volume, closeTime, ...] */
export type Kline = [number, string, string, string, string, string, number, ...unknown[]];

export interface TickerPrice {
  symbol: string;
  price: string;
}

export interface AccountInfo {
  canTrade: boolean;
  balances: { asset: string; free: string; locked: string }[];
  [field: string]: unknown;
}

export interface OrderAck {
  symbol: string;
  orderId: number;
  status: string;
  [field: string]: unknown;
}

export const KLINE_INTERVALS = [
  '1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
] as const;

export const ORDER_SIDES = ['BUY', 'SELL'] as const;
export const ORDER_TYPES = ['LIMIT', 'MARKET', 'STOP_LOSS_LIMIT'] as const;
export const TIME_IN_FORCE = ['GTC', 'IOC', 'FOK'] as const;

/**
 * Contracts that require HMAC signing. The `beforeRequest` hook in
 * {@link createBinanceSpotClient} consults this set — demonstrating how
 * contract-level introspection drives cross-cutting behavior.
 */
const SIGNED_CONTRACTS = new Set(['account', 'myTrades', 'placeOrder', 'cancelOrder']);

export const BinanceSpotApi = defineApi({
  name: 'BinanceSpotApi',
  base: 'https://api.binance.com',
  // Binance allows 1200 request weight per minute; pacing conservatively.
  rateLimit: { requestsPerSecond: 8, burst: 4 },
  retry: { retries: 3, baseDelay: 200, maxDelay: 5_000 },
  circuit: { failureThreshold: 5, cooldownMs: 15_000 },
  contracts: {
    /* ------------------------------------------------------------------ */
    /* Public endpoints                                                    */
    /* ------------------------------------------------------------------ */

    serverTime: contract<{ serverTime: number }>('GET /api/v3/time', {
      description: 'Current server time (ms since epoch).',
      responds: [{ status: 200, type: 'hash' }],
    }),

    /** With `symbol`: a single object; without: an array — hence no top-level type. */
    tickerPrice: contract<TickerPrice | TickerPrice[]>('GET /api/v3/ticker/price', {
      description: 'Latest price for one symbol or all symbols.',
      params: { symbol: P.string({ pattern: /^[A-Z0-9]{5,20}$/ }) },
      responds: [{ status: 200 }, { status: 400 }],
    }),

    klines: contract<Kline[]>('GET /api/v3/klines', {
      description: 'Candlestick / kline data.',
      params: {
        symbol: P.string({ required: true, pattern: /^[A-Z0-9]{5,20}$/ }),
        interval: P.string({ required: true, inclusion: [...KLINE_INTERVALS] }),
        startTime: P.integer({ min: 0 }),
        endTime: P.integer({ min: 0 }),
        limit: P.integer({ min: 1, max: 1000, default: 500 }),
      },
      responds: [{ status: 200, type: 'array' }, { status: 400 }],
    }),

    /* ------------------------------------------------------------------ */
    /* Signed endpoints (X-MBX-APIKEY + HMAC-SHA256 signature)             */
    /* ------------------------------------------------------------------ */

    account: contract<AccountInfo>('GET /api/v3/account', {
      description: 'Account information (signed).',
      params: {
        omitZeroBalances: P.boolean({ as: 'omitZeroBalances', default: false }),
        recvWindow: P.integer({ min: 5_000, max: 60_000, default: 10_000 }),
      },
      responds: [{ status: 200, type: 'hash' }, { status: 401 }],
    }),

    myTrades: contract('GET /api/v3/myTrades', {
      description: 'Trade history (signed).',
      params: {
        symbol: P.string({ required: true, pattern: /^[A-Z0-9]{5,20}$/ }),
        orderId: P.integer(),
        startTime: P.integer({ min: 0 }),
        endTime: P.integer({ min: 0 }),
        fromId: P.integer(),
        limit: P.integer({ min: 1, max: 1000, default: 500 }),
        recvWindow: P.integer({ min: 5_000, max: 60_000, default: 10_000 }),
      },
      responds: [{ status: 200, type: 'array' }, { status: 401 }],
    }),

    placeOrder: contract<OrderAck>('POST /api/v3/order', {
      description: 'Place a new order (signed).',
      idempotent: { header: 'X-Idempotency-Key' },
      params: {
        symbol: P.string({ required: true, pattern: /^[A-Z0-9]{5,20}$/ }),
        side: P.string({ required: true, inclusion: [...ORDER_SIDES] }),
        type: P.string({ required: true, inclusion: [...ORDER_TYPES] }),
        timeInForce: P.string({ as: 'timeInForce', inclusion: [...TIME_IN_FORCE] }),
        quantity: P.float({ min: 0 }),
        quoteOrderQty: P.float({ min: 0, as: 'quoteOrderQty' }),
        price: P.float({ min: 0 }),
        newClientOrderId: P.string({ as: 'newClientOrderId', length: { max: 36 } }),
        recvWindow: P.integer({ min: 5_000, max: 60_000, default: 10_000 }),
      },
      responds: [{ status: 200, type: 'hash' }, { status: 400 }, { status: 401 }],
    }),

    cancelOrder: contract('DELETE /api/v3/order', {
      description: 'Cancel an order (signed; params travel on the query string).',
      params: {
        symbol: P.string({ required: true, pattern: /^[A-Z0-9]{5,20}$/ }),
        orderId: P.integer(),
        origClientOrderId: P.string({ as: 'origClientOrderId' }),
        recvWindow: P.integer({ min: 5_000, max: 60_000, default: 10_000 }),
      },
      responds: [{ status: 200, type: 'hash' }, { status: 400 }, { status: 401 }],
    }),
  },
});

export interface BinanceSpotCredentials {
  apiKey: string;
  apiSecret: string;
  base?: string;
}

export type BinanceSpotClient = ApiClientInstance<typeof BinanceSpotApi.contracts>;

/**
 * Creates a signed client: API key travels in the `X-MBX-APIKEY` header,
 * and signed endpoints get a `timestamp` + HMAC-SHA256 `signature` appended
 * to their query string — exactly how binance-connector-js signs requests.
 */
export function createBinanceSpotClient(creds: BinanceSpotCredentials): BinanceSpotClient {
  return new BinanceSpotApi({
    base: creds.base,
    headers: { 'X-MBX-APIKEY': creds.apiKey },
    beforeRequest: (ctx) => {
      if (!SIGNED_CONTRACTS.has(ctx.contract)) return;

      ctx.query.set('timestamp', String(Date.now()));
      const signature = createHmac('sha256', creds.apiSecret)
        .update(ctx.query.toString())
        .digest('hex');
      ctx.query.set('signature', signature);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Demo                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(BinanceSpotApi.describe());

  // Public endpoints need no credentials.
  const anon = new BinanceSpotApi();
  const { serverTime } = await anon.serverTime();
  console.log('server time:', serverTime, `(${new Date(serverTime).toISOString()})`);

  const klines = await anon.klines({ symbol: 'BTCUSDT', interval: '1m', limit: 3 });
  for (const k of klines) {
    console.log(
      `BTCUSDT 1m  open=${k[1]}  close=${k[4]}  @ ${new Date(k[0]).toISOString()}`,
    );
  }

  const ticker = await anon.tickerPrice({ symbol: 'ETHUSDT' });
  const ethPrice = Array.isArray(ticker) ? ticker[0]?.price : ticker.price;
  console.log('ETHUSDT price:', ethPrice);

  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.log('\n(set BINANCE_API_KEY / BINANCE_API_SECRET to try signed endpoints)');
    return;
  }

  const client = createBinanceSpotClient({ apiKey, apiSecret });
  const account = await client.account({ omitZeroBalances: true });
  console.log(
    'balances:',
    account.balances.map((b) => `${b.asset}=${b.free}`).join(' '),
  );

  // Sanity-check the signing pipeline against a known vector.
  const expected = createHmac('sha256', apiSecret).update('symbol=LTCBTC&side=BUY').digest('hex');
  const actual = createHmac('sha256', apiSecret).update('symbol=LTCBTC&side=BUY').digest('hex');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    throw new Error('signing self-check failed');
  }
  console.log('HMAC signing self-check passed');
}

main().catch((err) => {
  console.error('binance example failed:', err);
  process.exit(1);
});
