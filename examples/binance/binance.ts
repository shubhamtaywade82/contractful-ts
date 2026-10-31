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
import { pathToFileURL } from 'node:url';

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
      // Binance spot has no server-side idempotency key: an ambiguous
      // failure (timeout / dropped connection / 5xx) may have placed the
      // order, so the client must NOT auto-retry — surface the error and
      // reconcile via `newClientOrderId` (Binance's client-side dedup key)
      // before resubmitting. This mirrors the library's method-aware retry
      // safety, made explicit.
      retry: 'never',
      params: {
        // Binance signed endpoints take their parameters on the query
        // string (that is what gets HMAC-signed) — not a JSON body.
        symbol: P.string({ required: true, pattern: /^[A-Z0-9]{5,20}$/, in: 'query' }),
        side: P.string({ required: true, inclusion: [...ORDER_SIDES], in: 'query' }),
        type: P.string({ required: true, inclusion: [...ORDER_TYPES], in: 'query' }),
        timeInForce: P.string({ as: 'timeInForce', inclusion: [...TIME_IN_FORCE], in: 'query' }),
        quantity: P.float({ min: 0, in: 'query' }),
        quoteOrderQty: P.float({ min: 0, as: 'quoteOrderQty', in: 'query' }),
        price: P.float({ min: 0, in: 'query' }),
        newClientOrderId: P.string({ as: 'newClientOrderId', length: { max: 36 }, in: 'query' }),
        recvWindow: P.integer({ min: 5_000, max: 60_000, default: 10_000, in: 'query' }),
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
 * Signs a Binance query string: HMAC-SHA256 over the exact bytes that go on
 * the wire, hex-encoded — appended as `signature` by the client hook and
 * verified by the server. Exported so tests can exercise the real function.
 */
export function signQuery(apiSecret: string, queryString: string): string {
  return createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

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
      ctx.query.set('signature', signQuery(creds.apiSecret, ctx.query.toString()));
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Known-answer tests (KAT) — independent verification of the signing          */
/* -------------------------------------------------------------------------- */

/** Fixed vectors: HMAC-SHA256(secret, message) === digest. Not derived from
 *  the implementation under test at runtime — precomputed externally. */
const KAT_SECRET = 'contractful-ts-kat-secret';
const KAT_VECTORS: ReadonlyArray<{ query: string; digest: string }> = [
  {
    query: 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&timestamp=1463165436000',
    digest: '2e98553aec10088262c3ce82d668bffcffd0e6ed219334cb623225436aab9423',
  },
  {
    query: 'symbol=BTCUSDT&orderId=123456&timestamp=1499827319559',
    digest: 'dc4ea73064f2a7e6223e1ffea93153a8b8b7056e61219837ff5f09b2d2e24512',
  },
];

/** Runs the known-answer checks; throws on any mismatch. */
export function verifySigningVectors(): void {
  for (const { query, digest } of KAT_VECTORS) {
    const actual = Buffer.from(signQuery(KAT_SECRET, query), 'hex');
    const expected = Buffer.from(digest, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error(
        `signing known-answer test failed for ${JSON.stringify(query)}: got ${actual.toString('hex')}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Demo                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  // Known-answer tests first: the signing primitive must match externally
  // precomputed HMAC-SHA256 vectors before anything touches the network.
  verifySigningVectors();
  console.log('HMAC signing known-answer tests passed (2 vectors)');

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
}

// Run the demo only when executed directly (node examples/binance/binance.ts),
// so tests can import this module without hitting the network.
const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('binance example failed:', err);
    process.exit(1);
  });
}
