/**
 * Authentication: the injectable {@link AuthProvider} contract, the
 * single-flight {@link createTokenManager}, and provider adapters.
 */

export type {
  AuthTransport,
  AuthContext,
  AuthMaterial,
  AuthProvider,
} from './provider.js';
export {
  staticAuthProvider,
  bearerAuthProvider,
  apiKeyAuthProvider,
  authProviderFromTokenManager,
  wsTicketAuthProvider,
  appendAuthQuery,
  authProviderResolver,
} from './provider.js';
export type { Token, TokenManagerOptions, TokenManager } from './token-manager.js';
export { createTokenManager } from './token-manager.js';
