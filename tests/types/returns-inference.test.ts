/**
 * P1 regression suite: response-type pinning must not widen argument
 * inference.
 *
 * Supplying an explicit type argument to `contract<T>(...)` makes TypeScript
 * skip inference for every remaining type parameter, so the params generic
 * collapsed to its default and argument types widened to an open index
 * signature. The fix: `returns<R>(decls)` stamps a phantom on the `responds`
 * list, so BOTH the argument object (from `params`) and the return type
 * (from `responds`) are inferred in the same call — no explicit type
 * arguments anywhere.
 *
 * The `expectTypeOf` assertions are compile-time checks, enforced by
 * `npm run typecheck` (tests/types/tsconfig.json) in CI. The runtime parts
 * run under vitest like any other test.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  contract,
  defineApi,
  returns,
  P,
  type ContractArgs,
  type ContractReturn,
  type MetaOptions,
} from '../../src/index.js';

interface User {
  id: number;
  login: string;
}

describe('returns<T>() — pinning the return type keeps argument inference', () => {
  const listUsers = contract('GET /users', {
    params: {
      since: P.integer(),
      perPage: P.integer({ as: 'per_page', required: true, min: 1, max: 100 }),
    },
    responds: returns<User[]>([{ status: 200, type: 'array' }]),
  });

  it('infers the strict argument type (required keys stay required)', () => {
    expectTypeOf<ContractArgs<typeof listUsers>>().toEqualTypeOf<{
      since?: number;
      perPage: number;
    }>();
  });

  it('infers the pinned return type', () => {
    expectTypeOf<ContractReturn<typeof listUsers>>().toEqualTypeOf<User[]>();
  });

  it('flows through defineApi into fully typed client methods', () => {
    const Api = defineApi({
      name: 'UsersApi',
      base: 'https://api.test',
      contracts: { listUsers },
    });
    const client = new Api();
    expectTypeOf(client.listUsers)
      .parameter(0)
      .toEqualTypeOf<{ since?: number; perPage: number } & MetaOptions>();
    expectTypeOf(client.listUsers).returns.toEqualTypeOf<Promise<User[]>>();
  });
});

describe('returns<T>() — runtime behavior is unchanged', () => {
  it('is an identity: the responds entries validate exactly as before', async () => {
    const Api = defineApi({
      name: 'EchoApi',
      base: 'https://echo.test',
      contracts: {
        echo: contract('POST /echo', {
          params: { body: P.string({ required: true, in: 'body', raw: true }) },
          responds: returns<string>([{ status: 200, type: 'string' }]),
        }),
      },
    });
    const transport = {
      send: async () => ({ status: 200, headers: {}, body: 'pong' }),
    };
    const client = new Api({ transport });
    const result = await client.echo({ body: 'ping' });
    expect(result).toBe('pong');
    expectTypeOf(result).toEqualTypeOf<string>();

    // Shape gate still applies (declared type: string).
    const badTransport = {
      send: async () => ({ status: 200, headers: {}, body: { not: 'a string' } }),
    };
    const badClient = new Api({ transport: badTransport });
    await expect(badClient.echo({ body: 'ping' })).rejects.toThrow(/expected top-level string/);
  });
});

describe('contract<T>() — legacy pinning still works for simple contracts', () => {
  it('pins the return type; params inference is documented as relaxed there', () => {
    const serverTime = contract<{ serverTime: number }>('GET /time', {
      responds: [{ status: 200, type: 'hash' }],
    });
    expectTypeOf<ContractReturn<typeof serverTime>>().toEqualTypeOf<{ serverTime: number }>();
  });
});
