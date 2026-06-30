/**
 * EventBus — typed, in-memory pub/sub over the {@link BrainEvent} union.
 *
 * This is the transport-agnostic core for fanning agent events out to any
 * frontend (Electron renderer today, Ink CLI tomorrow). It deals only in
 * provider-neutral {@link BrainEvent}s and pulls in no Node- or Electron-
 * specific APIs, so it is safe to import from the renderer/browser too.
 *
 * Dispatch rules:
 *  - Typed subscribers (registered via {@link EventBus.subscribe}) fire first.
 *  - Wildcard subscribers (registered via {@link EventBus.subscribeAll}) fire
 *    afterwards, so type-specific handlers always see an event before the
 *    catch-all observers do.
 *  - A subscriber that throws — or returns a rejected Promise — is logged and
 *    isolated; it never blocks the remaining subscribers.
 *  - Async subscribers are fire-and-forget: the bus invokes the handler
 *    synchronously and does NOT await its returned Promise.
 *
 * @see docs/plans/2026-06-28-anathema-coder.md (Task 11.2)
 */

import type { BrainEvent, BrainEventType } from './events.js';

/** Async-capable subscriber. Receives an event, may return a Promise. */
export type Subscriber<T extends BrainEvent = BrainEvent> = (event: T) => void | Promise<void>;

/** Wildcard subscriber — receives every event regardless of type. */
export type AllEventsSubscriber = (event: BrainEvent) => void | Promise<void>;

/** Returned by subscribe/subscribeAll; call to remove that handler. */
export interface Unsubscribe {
  (): void;
}

export class EventBus {
  /** Per-type subscriber registry. */
  private subscribers: Map<BrainEventType, Set<Subscriber>>;
  /** Wildcard subscribers (receive every event). */
  private wildcardSubscribers: Set<AllEventsSubscriber>;

  constructor() {
    this.subscribers = new Map();
    this.wildcardSubscribers = new Set();
  }

  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  subscribe<T extends BrainEventType>(
    type: T,
    handler: Subscriber<Extract<BrainEvent, { type: T }>>,
  ): Unsubscribe {
    let set = this.subscribers.get(type);
    if (!set) {
      set = new Set();
      this.subscribers.set(type, set);
    }
    // The handler is narrowed to a single variant; emit() only ever dispatches
    // matching events to it, so widening the stored type is sound here.
    const stored = handler as Subscriber;
    set.add(stored);
    return () => {
      const current = this.subscribers.get(type);
      if (!current) return;
      current.delete(stored);
      if (current.size === 0) this.subscribers.delete(type);
    };
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribeAll(handler: AllEventsSubscriber): Unsubscribe {
    this.wildcardSubscribers.add(handler);
    return () => {
      this.wildcardSubscribers.delete(handler);
    };
  }

  /**
   * Emit an event to all matching subscribers (typed first, then wildcard).
   * Errors in individual subscribers are logged but do not prevent other
   * subscribers from receiving the event.
   */
  emit(event: BrainEvent): void {
    const set = this.subscribers.get(event.type);
    if (set) {
      for (const handler of set) this.dispatch(handler, event);
    }
    for (const handler of this.wildcardSubscribers) this.dispatch(handler, event);
  }

  /** Remove all subscribers (typed + wildcard). */
  clear(): void {
    this.subscribers.clear();
    this.wildcardSubscribers.clear();
  }

  /**
   * Number of subscribers. With a `type`, returns typed subscribers for that
   * type; without, returns the total across all types plus wildcard handlers.
   */
  listenerCount(type?: BrainEventType): number {
    if (type !== undefined) {
      return this.subscribers.get(type)?.size ?? 0;
    }
    let total = this.wildcardSubscribers.size;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }

  /** Invoke a single subscriber, isolating sync throws and async rejections. */
  private dispatch(handler: Subscriber, event: BrainEvent): void {
    try {
      const result = handler(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error('[eventBus] subscriber error:', err);
        });
      }
    } catch (err) {
      console.error('[eventBus] subscriber error:', err);
    }
  }
}
