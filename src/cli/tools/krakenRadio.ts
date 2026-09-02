/**
 * krakenRadio — lightweight parent↔tentacle progress bus (Fractal-inspired).
 *
 * File-backed JSONL under `.zelari/radio/<sessionId>.jsonl`.
 * No SQLite. Best-effort; never throws to callers of append.
 *
 * @since Kraken v1.x slice 2
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export type KrakenRadioKind =
  | 'spawn'
  | 'progress'
  | 'done'
  | 'error'
  | 'verify_hint'
  // Graph engine (F3+) events - one node's lifecycle within a Kraken graph run.
  | 'node_start'
  | 'node_end'
  | 'node_retry'
  | 'node_fix'
  | 'node_deferred'
  // P2.C worktree scheduling: a writer arbitration would have deferred was
  // admitted in parallel under git worktree isolation (low scope overlap,
  // ZELARI_KRAKEN_WORKTREE=auto).
  | 'node_worktree_scheduled'
  // P2.B semantic ownership: a writer arbitration would have deferred was
  // admitted because BOTH sides declare disjoint ownedSymbols for the
  // contested file (admission-time symbol disjointness — see
  // kraken/semanticOwnership.ts for the honest v1 limits).
  | 'node_semantic_admitted'
  // P2.D transactional writers: a writer node failed and its partial work
  // was rolled back to the pre-run checkpoint (ZELARI_KRAKEN_TRANSACTIONAL).
  | 'node_rolled_back'
  // P2.F spawn-ROI gate: an admitted node scored below its expected-value
  // threshold and was sent back the deferred path (stays READY, never
  // failed) — deterministic score in kraken/spawnRoi.ts, vetoed at the
  // executor's tentacle spawn site.
  | 'node_roi_vetoed'
  | 'graph_converged'
  | 'graph_failed'
  // Bennett's Razor weakness-meter refinement (Slice L/N+3 wiring).
  // Emitted after a verify / spec / conformance verdict lands; the
  // detail carries the LLM meter payload so the desktop can surface a
  // "tightly asserted" vs "loosely claimed" distinction.
  | 'node_meter'
  // t58 declared-vs-observed guard: a completed task's declared file was
  // written by a LATER session (sessionStartedAt > completedAt) — the task
  // got effectively reopened without task_update. contestedFile carries the
  // touched path; agent is 'task-guard' (taskTouchGuard.ts).
  | 'task_reopened';

export interface KrakenRadioEvent {
  ts: string;
  kind: KrakenRadioKind;
  agent: string;
  thoroughness?: string;
  description: string;
  /** Short summary / result excerpt */
  detail?: string;
  model?: string;
  worktree?: string | null;
  durationMs?: number;
  ok?: boolean;
  /** Graph node id (node_* graph-engine events). */
  nodeId?: string;
  /** P2.C: scope-overlap score (0..1) behind a node_worktree_scheduled event. */
  overlapScore?: number;
  /** P2.C: machine-readable why behind a node_worktree_scheduled event. */
  rationaleCode?: string;
  /** P2.C: id of the running writer the scheduled node was scored against. */
  runningNode?: string;
  /** P2.B: file both semantically-admitted writers declared claims on. */
  contestedFile?: string;
  /** P2.F: ROI spawn score behind a node_roi_vetoed event. */
  spawnScore?: number;
  /** P2.F: the ROI threshold the score was vetoed against. */
  threshold?: number;
  /** P2.B: the racing writer's declared symbol claims (verbatim specs). */
  symbolsA?: string[];
  /** P2.B: the admitted node's declared symbol claims (verbatim specs). */
  symbolsB?: string[];
}

function radioDir(cwd: string): string {
  return path.join(cwd, '.zelari', 'radio');
}

function radioPath(cwd: string, sessionId: string): string {
  const safe = (sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return path.join(radioDir(cwd), `${safe}.jsonl`);
}

/** Append one radio event (best-effort, sync — sub-agent exit path). */
export function appendKrakenRadio(
  cwd: string,
  sessionId: string,
  event: Omit<KrakenRadioEvent, 'ts'> & { ts?: string },
): void {
  try {
    const dir = radioDir(cwd);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const row: KrakenRadioEvent = {
      ts: event.ts ?? new Date().toISOString(),
      kind: event.kind,
      agent: event.agent,
      description: event.description,
      ...(event.thoroughness !== undefined ? { thoroughness: event.thoroughness } : {}),
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(event.worktree !== undefined ? { worktree: event.worktree } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.ok !== undefined ? { ok: event.ok } : {}),
      ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
      ...(event.overlapScore !== undefined ? { overlapScore: event.overlapScore } : {}),
      ...(event.rationaleCode !== undefined ? { rationaleCode: event.rationaleCode } : {}),
      ...(event.runningNode !== undefined ? { runningNode: event.runningNode } : {}),
      ...(event.contestedFile !== undefined ? { contestedFile: event.contestedFile } : {}),
      ...(event.spawnScore !== undefined ? { spawnScore: event.spawnScore } : {}),
      ...(event.threshold !== undefined ? { threshold: event.threshold } : {}),
      ...(event.symbolsA !== undefined ? { symbolsA: event.symbolsA } : {}),
      ...(event.symbolsB !== undefined ? { symbolsB: event.symbolsB } : {}),
    };
    appendFileSync(radioPath(cwd, sessionId), `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // never break the agent loop for telemetry
  }
}

/** Read recent radio events (newest last). */
export function readKrakenRadio(
  cwd: string,
  sessionId: string,
  limit = 50,
): KrakenRadioEvent[] {
  try {
    const file = radioPath(cwd, sessionId);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-Math.max(1, limit));
    const out: KrakenRadioEvent[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as KrakenRadioEvent);
      } catch {
        // skip bad lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** List session radio files under .zelari/radio. */
export function listKrakenRadioSessions(cwd: string): string[] {
  try {
    const dir = radioDir(cwd);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}

/** Human-readable status block for slash / doctor. */
export function formatKrakenRadioStatus(
  cwd: string,
  sessionId: string,
  limit = 12,
): string {
  const events = readKrakenRadio(cwd, sessionId, limit);
  if (events.length === 0) {
    return `Kraken radio: no events yet for session "${sessionId}" (path .zelari/radio/).`;
  }
  const lines = events.map((e) => {
    const flag = e.ok === false ? '✗' : e.ok === true ? '✓' : '·';
    const ms = e.durationMs != null ? ` ${e.durationMs}ms` : '';
    const model = e.model ? ` [${e.model}]` : '';
    const wt = e.worktree ? ` wt=${path.basename(e.worktree)}` : '';
    const detail = e.detail ? ` — ${e.detail.slice(0, 120)}` : '';
    return `${flag} ${e.ts.slice(11, 19)} ${e.kind} ${e.agent} "${e.description}"${model}${wt}${ms}${detail}`;
  });
  return [`Kraken radio (last ${events.length}) session=${sessionId}:`, ...lines].join('\n');
}
