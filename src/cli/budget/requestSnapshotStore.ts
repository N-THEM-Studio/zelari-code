/**
 * requestSnapshotStore — in-memory per-session store of routed request
 * snapshots (v1.36.0 context/cache upgrade).
 *
 * Keeps the LAST snapshot per session (that's all cache-aware compaction
 * needs: the most recent routed request = the warmest provider prefix)
 * plus the provider-reported usage that answered it.
 *
 * Usage flow:
 *   - AgentHarness `onRequestSnapshot` → `recordRequestSnapshot(sessionId, s)`
 *   - `message_end` usage in useChatTurn → `recordRequestUsage(sessionId, usage)`
 *     (associated to the snapshot that is currently pending for that session)
 *   - `applyBudgetPolicyAsync` → `getRequestSnapshot(sessionId)` → replay base
 *   - `/clear` | `/new` → `clearRequestSnapshots(sessionId)` /
 *     `clearAllRequestSnapshots()` (CLI is single-session per process).
 *
 * @since v1.36.0
 */

import type { RoutedRequestSnapshot } from '@zelari/core/harness';

export interface StoredRequestUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
}

interface SessionEntry {
  /** Last routed snapshot (deep-cloned by the snapshot factory). */
  snapshot: RoutedRequestSnapshot;
  /** Usage of the response that answered `snapshot`, if it arrived yet. */
  usage?: StoredRequestUsage;
}

const store = new Map<string, SessionEntry>();

/** Track the most recently routed request for a session. */
export function recordRequestSnapshot(
  sessionId: string,
  snapshot: RoutedRequestSnapshot,
): void {
  // Keep the pending slot: usage recorded next will bind to this snapshot.
  store.set(sessionId, { snapshot });
}

/**
 * Attach provider-reported usage to the session's latest snapshot.
 * Called when the `message_end` usage delta lands — after the snapshot.
 */
export function recordRequestUsage(
  sessionId: string,
  usage: StoredRequestUsage,
): void {
  const entry = store.get(sessionId);
  if (!entry) return;
  entry.usage = usage;
}

/** Last routed snapshot (+ usage, when reported). Null when none yet. */
export function getRequestSnapshot(sessionId: string): RoutedRequestSnapshot | null {
  return store.get(sessionId)?.snapshot ?? null;
}

/** Last snapshot together with its provider-reported usage. */
export function getRequestSnapshotWithUsage(
  sessionId: string,
): { snapshot: RoutedRequestSnapshot; usage?: StoredRequestUsage } | null {
  return store.get(sessionId) ?? null;
}

/** Drop one session's snapshot (session switch). */
export function clearRequestSnapshots(sessionId: string): void {
  store.delete(sessionId);
}

/** Drop everything (/clear, /new — the CLI is mono-session per process). */
export function clearAllRequestSnapshots(): void {
  store.clear();
}

/** Test-only reset. */
export function _resetRequestSnapshotStoreForTests(): void {
  store.clear();
}
