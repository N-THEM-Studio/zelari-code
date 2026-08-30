/**
 * harness_state final-NDJSON emitter — ONE shared helper for all headless
 * hosts (H1 inc.3).
 *
 * The one-shot host wired this inline in H1 inc.2 (runOneTurn): with the
 * spine closed, a `--output json` host emits the derived ADR-0023 read-model
 * (session lens + per-turn Turn Completion Contract) as the FINAL NDJSON
 * line. Council / mission / kraken-graph call this same helper right after
 * their spine.close so every JSON host ends its stream identically (see
 * ADR-0023 R6 for the lifecycle-complete contract).
 *
 * Same dir resolution as the spine mirror (workspaceRoot +
 * ZELARI_SESSIONS_DIR) so the read matches what was written; best-effort by
 * contract — no-op unless output === 'json', and ANY resolution/read/
 * derivation failure degrades to ONE stderr line, never throws, and never
 * affects exit codes.
 */
import path from 'node:path';
import { resolveSessionsDir } from '@zelari/core/session';
import { readHarnessState } from '../harnessState.js';

export interface EmitHarnessStateEventOptions {
  /** Spine handle — only sessionId is needed (must be closed already). */
  spine: { sessionId: string };
  /** Workspace root for the sessions-dir resolution (same var the host opened the spine with). */
  workspaceRoot: string;
  /** NDJSON gate: emission happens only when this is exactly 'json'. */
  output: unknown;
  /** Host event sink (usually the headless emitEvent). */
  emitEvent: (event: Record<string, unknown>) => void;
}

/** Emit the final `harness_state` NDJSON event for a closed session (best-effort). */
export async function emitHarnessStateEvent(opts: EmitHarnessStateEventOptions): Promise<void> {
  if (opts.output !== 'json') return;
  try {
    const sessionsDir = resolveSessionsDir({ workspaceRoot: opts.workspaceRoot });
    const state = await readHarnessState(path.join(sessionsDir, opts.spine.sessionId));
    opts.emitEvent({ type: 'harness_state', ...state });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      process.stderr.write(`[zelari-code --headless] harness_state unavailable: ${msg}\n`);
    } catch { /* stderr gone — nothing more to do */ }
  }
}
