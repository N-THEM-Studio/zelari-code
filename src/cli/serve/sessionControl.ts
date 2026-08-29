/**
 * Session-scoped control plane for the harness App Server (t32, Pilastro B
 * residuo).
 *
 * In `--serve-harness` mode the NDJSON transport owns stdin, so the headless
 * stdin control plane (controlBridge.ts) cannot serve per-session
 * steer/cancel. Instead:
 *   - the server's `run.turn` dispatch carries the harness sessionId down the
 *     turn's async call-chain via AsyncLocalStorage (no new HeadlessOptions
 *     field, CLI/protocol surface unchanged, concurrent sessions isolated);
 *   - runOneTurn (serve mode ONLY) registers its per-turn RuntimeControlQueue
 *     + cooperative cancel hook under that session id;
 *   - the server answers `session.steer` / `session.cancel` NDJSON methods by
 *     targeting the live registration, with protocol-v2 acks (§24:
 *     accepted ≠ applied — `control_applied` still fires from the queue drain
 *     / the cancel hook, never fabricated by this module).
 *
 * Plain `--headless` never dispatches through runWithSession, so
 * registerLiveTurnControl returns undefined there and behavior is unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeControlQueue } from '@zelari/core/runtime';

/** What a running turn exposes to its session's NDJSON control methods. */
export interface LiveTurnControl {
  /** Per-turn queue; SteeringObserver drains steers at turn boundaries. */
  readonly queue: RuntimeControlQueue;
  /**
   * Cooperative cancel — wired to the harness cancel handle once the agent
   * loop exists. Returns false when the turn has no cancelable harness yet;
   * the caller surfaces `delivered: false` instead of faking application.
   */
  cancel(): boolean;
}

/** Registration bookkeeping: control + the dispatch generation it came from. */
interface RegisteredTurn extends LiveTurnControl {
  token: object;
}

const dispatchContext = new AsyncLocalStorage<{ sessionId: string; token: object }>();

/** Live registry: harness sessionId → its running turn control (if any). */
const liveTurns = new Map<string, RegisteredTurn>();

/** Run `fn` inside a session dispatch context (server → runOneTurn). */
export function runWithSession<T>(sessionId: string, fn: () => T): T {
  return dispatchContext.run({ sessionId, token: {} as object }, fn);
}

/**
 * runOneTurn (serve mode) registers the per-turn control surface. Returns
 * the unregister fn (identity-guarded, safe across back-to-back turns on
 * the same session), or undefined when NOT dispatched by the harness server
 * — plain `--headless` keeps its stdin control plane, zero behavior change.
 */
export function registerLiveTurnControl(
  control: LiveTurnControl,
): (() => void) | undefined {
  const store = dispatchContext.getStore();
  if (!store) return undefined;
  const registered: RegisteredTurn = { ...control, token: store.token };
  liveTurns.set(store.sessionId, registered);
  return () => {
    if (liveTurns.get(store.sessionId) === registered) {
      liveTurns.delete(store.sessionId);
    }
  };
}

/** The live turn control for a session, when one is running. */
export function getLiveTurnControl(
  sessionId: string,
): LiveTurnControl | undefined {
  return liveTurns.get(sessionId);
}

/**
 * Server-side settlement cleanup (called inside runWithSession, after the
 * turn promise settles). Drops the registration of THIS dispatch only —
 * token-matched, so a concurrent newer turn on the same session survives.
 * Covers the crash path where the turn impl never unregistered, keeping the
 * `already_finished` noop honest instead of steering a dead queue.
 */
export function clearSessionTurnControl(sessionId: string): void {
  const store = dispatchContext.getStore();
  if (!store || store.sessionId !== sessionId) return;
  const registered = liveTurns.get(sessionId);
  if (registered && registered.token === store.token) {
    liveTurns.delete(sessionId);
  }
}
