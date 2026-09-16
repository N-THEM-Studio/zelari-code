/**
 * inputDraft.ts — the TUI prompt draft lives in a store OUTSIDE React.
 *
 * Why (diagnosi 2026-09-15 `-diagnosi-lag-input-e-desync-modelli.md`, slice 5):
 * the draft used to be `useState` inside `App` (`src/cli/app.tsx`), so EVERY
 * keystroke reconciled the whole ink tree — `<Static>`, `<LiveRegion>`,
 * `<StatusBar>` (with its jail probe + todo/kraken/verify chip formatting) and
 * `<Sidebar>`. A keystroke is a LOCAL edit: it must re-render the input bar and
 * nothing else.
 *
 * The draft now lives here and only the components that actually DISPLAY it
 * subscribe (`InputBar` via `useInputDraft`). `App` keeps writing to the same
 * store (`setInput('')` after a slash command) so the send/clear flow — and
 * every slash command — behaves exactly as before.
 *
 * Subscribers are notified synchronously through `useSyncExternalStore`: a
 * string snapshot compares by value, so React never re-renders for an
 * unchanged draft.
 */
import { useSyncExternalStore } from 'react';

/** Minimal observable draft — `useSyncExternalStore`-shaped on purpose. */
export interface InputDraftStore {
  /** Current draft text (snapshot — never mutated in place). */
  get(): string;
  /** Replace the draft. Identical values notify nobody. */
  set(value: string): void;
  /** Reset to the empty prompt (the post-submit `/clear` path). */
  clear(): void;
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Create a draft store. One per `App` instance (`useState` lazy init), never a
 * module-level singleton: two mounted apps (or tests) must not share a draft.
 */
export function createInputDraftStore(initial = ''): InputDraftStore {
  let value = initial;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    get: () => value,
    set(next: string) {
      if (next === value) return; // no change → no notification → no render
      value = next;
      emit();
    },
    clear() {
      if (value === '') return;
      value = '';
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Read the draft. This is the ONLY hook that re-renders per keystroke —
 * everything else in the app tree is left alone.
 */
export function useInputDraft(store: InputDraftStore): string {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
