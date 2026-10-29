/**
 * The unified platform facade and the events-driven cache invalidator.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  contract,
  createEventsCacheInvalidator,
  createPlatformClient,
  defineApi,
  defineEvents,
  P,
  publish,
  subscribe,
  authProviderResolver,
  type AuthProvider,
} from '../src/index.js';
import { jsonResponse, MockTransport } from './helpers.js';
import { FakeSocket } from './events-helpers.js';

const ProductsApi = defineApi({
  name: 'ProductsApi',
  contracts: {
    getProduct: contract('GET /products/:id', {
      params: { id: P.string({ required: true }) },
      responds: [{ status: 200, type: 'hash' }],
    }),
  },
});

const ShopEvents = defineEvents({
  name: 'ShopEvents',
  url: 'wss://api.example.com/shop',
  channels: {
    onProductCreated: subscribe<{ id: string }>('product.created', {}),
    createProduct: publish<{ title: string }>('product.create', {}),
  },
});

describe('createPlatformClient', () => {
  it('wires the shared auth provider into both transports and disposes', async () => {
    const transport = new MockTransport(() => jsonResponse(200, { id: 'p1' }));
    const getAuthCalls: string[] = [];

    const authProvider: AuthProvider = {
      async getAuth(context) {
        getAuthCalls.push(context.transport);
        return context.transport === 'http'
          ? { headers: { Authorization: 'Bearer tok' } }
          : { query: { access_token: 'tok' } };
      },
    };

    const sockets: FakeSocket[] = [];
    const platform = createPlatformClient({
      authProvider,
      rest: ({ auth }) => new ProductsApi({ transport, auth }),
      events: ({ authProvider: provider }) =>
        new ShopEvents({
          authProvider: provider,
          socketFactory: (url, protocols) => {
            const socket = new FakeSocket(url, protocols);
            sockets.push(socket);
            setTimeout(() => socket.serverOpen(), 0);
            return socket;
          },
        }),
    });

    await platform.events.connect();
    const product = await platform.rest.getProduct({ id: 'p1' });
    expect(product).toEqual({ id: 'p1' });
    expect(transport.lastRequest.headers['Authorization']).toBe('Bearer tok');
    expect(sockets[0]!.url).toContain('access_token=tok');
    expect(getAuthCalls).toContain('http');
    expect(getAuthCalls).toContain('websocket');
    expect(platform.authProvider).toBe(authProvider);

    await platform.dispose();
    expect(platform.events.state).toBe('closed');
  });

  it('accepts pre-built instances and derives identity headers', () => {
    const transport = new MockTransport(() => jsonResponse(200, { id: 'x' }));
    const events = new ShopEvents({
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    const platform = createPlatformClient({
      rest: new ProductsApi({ transport }),
      events,
      identity: { clientName: 'shop-web', clientVersion: '1.2.3' },
    });

    expect(platform.rest).toBeInstanceOf(ProductsApi);
    expect(platform.events).toBe(events);
    expect(platform.identityHeaders).toEqual({
      'X-Client-Name': 'shop-web',
      'X-Client-Version': '1.2.3',
    });
  });

  it('auto-connects the events client when requested', async () => {
    const sockets: FakeSocket[] = [];
    const events = new ShopEvents({
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    createPlatformClient({
      rest: new ProductsApi({ transport: new MockTransport(() => jsonResponse(200, {})) }),
      events,
      autoConnectEvents: true,
    });
    // The connect() call was issued eagerly; the socket opens asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.state).toBe('open');
    await events.disconnect();
  });

  it('passes a bridging resolver when only a provider is given (factory form)', async () => {
    const transport = new MockTransport(() => jsonResponse(200, { id: 'p2' }));
    const authProvider: AuthProvider = {
      async getAuth() {
        return { headers: { Authorization: 'Bearer tok' } };
      },
    };
    // Simulate what a generated platform client does internally.
    const rest = new ProductsApi({ transport, auth: authProviderResolver(authProvider) });
    const platform = createPlatformClient({ rest, events: null as never });
    expect(platform.rest).toBe(rest);
  });
});

describe('createEventsCacheInvalidator', () => {
  it('invalidates caches per rule and stops on dispose', async () => {
    const sockets: FakeSocket[] = [];
    const events = new ShopEvents({
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        setTimeout(() => socket.serverOpen(), 0);
        return socket;
      },
    });
    await events.connect();

    const onCreated = vi.fn();
    const invalidateOrders = vi.fn();
    const invalidator = createEventsCacheInvalidator(events.raw, [
      { event: 'product.created', invalidate: onCreated },
      { event: 'order.created', invalidate: invalidateOrders },
    ]);

    sockets[0]!.serverMessage({ topic: 'product.created', payload: { id: 'p1' } });
    expect(onCreated).toHaveBeenCalledWith({ id: 'p1' });
    expect(invalidateOrders).not.toHaveBeenCalled();

    invalidator.dispose();
    sockets[0]!.serverMessage({ topic: 'product.created', payload: { id: 'p2' } });
    expect(onCreated).toHaveBeenCalledTimes(1);

    await events.disconnect();
  });
});
