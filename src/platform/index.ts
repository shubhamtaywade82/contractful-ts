/**
 * The platform layer: unified facades over separate HTTP + event transports.
 */

export {
  createPlatformClient,
  type PlatformClientOptions,
  type PlatformClient,
  type ClientIdentity,
} from './facade.js';
export {
  createEventsCacheInvalidator,
  type EventInvalidationRule,
  type EventsCacheInvalidator,
  type InvalidationEventsSource,
} from './cache.js';
