/**
 * Cache invalidation driven by WebSocket events — the UI-integration half of
 * the platform design. Kept out of the core clients: transports stay generic,
 * applications compose rules.
 *
 * ```ts
 * const stop = createEventsCacheInvalidator(events, [
 *   { event: 'order.created', invalidate: () => queryClient.invalidateQueries({ queryKey: ['orders'] }) },
 *   { event: 'order.updated', invalidate: (msg) => patchOrderCache(msg) },
 * ]);
 * ```
 */

import type { EventsClient } from '../events/client.js';

/** Minimal events surface the invalidator needs. */
export interface InvalidationEventsSource {
  subscribe(
    pattern: string,
    handler: (message: unknown, ctx: unknown) => void,
  ): () => void;
}

export interface EventInvalidationRule {
  /** Topic (or `:param` pattern) that triggers the invalidation. */
  event: string;
  /** Called with the (already routed) message payload. */
  invalidate: (message: unknown) => void;
}

export interface EventsCacheInvalidator {
  /** Stops all invalidation subscriptions. */
  dispose(): void;
}

/**
 * Subscribes one handler per rule on the events client and returns a
 * disposer. Works with {@link EventsClient} or any `defineEvents` instance.
 */
export function createEventsCacheInvalidator(
  events: InvalidationEventsSource,
  rules: EventInvalidationRule[],
): EventsCacheInvalidator {
  const unsubscribers = rules.map((rule) =>
    events.subscribe(rule.event, (message) => rule.invalidate(message)),
  );
  return {
    dispose(): void {
      for (const off of unsubscribers) off();
    },
  };
}
