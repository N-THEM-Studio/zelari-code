/**
 * Kraken workbench writer (Slice E / Pillar 3, F3.1).
 *
 * Writes a single Markdown file at `.zelari/radio/workbench-<id>.md` that
 * reflects the live state of a running graph. The format is intentionally
 * plain Markdown so a developer can `tail -f` the file (or open it in a
 * Markdown viewer that auto-refreshes) and see what the run is doing
 * without touching the TUI.
 *
 * The file is rewritten atomically on every `snapshot()` (write to `.tmp`,
 * rename) so a `tail` never sees a partial state. Updates are debounced:
 * 500ms after the last `markX` call, the writer flushes the buffer to
 * disk. This keeps the file fresh without thrashing on bursty event
 * streams (e.g. a 100-tentacle parallel wave emits 100 `node_start` events
 * in a single tick).
 *
 * Format (one Markdown file):
 *   # Kraken workbench
 *   **Goal:** <goal>
 *   **Graph id:** <id>
 *   **Started:** <iso> · **Elapsed:** <hh:mm:ss>
 *
 *   ## Progress: <done>/<total> · <running>↑ · <errored>✗
 *
 *   ## Wave
 *   | id | label | kind | scope | status | verdict | weakness | model | duration |
 *   |----|-------|------|-------|--------|---------|----------|-------|----------|
 *   | t0001 | map auth | explore | src/auth | ✓ done | pass | 0.83 | grok-3-mini | 4s |
 *   ...
 *
 *   ## Events (latest 30)
 *   - 11:00:01 graph_plan plan=plan.ts (4 nodes)
 *   - 11:00:02 node_start t0001 map auth
 *   ...
 *
 * **v1.31.x**: each completed verify/spec/conformance node surfaces two
 * extra columns — `verdict` (pass / fail / unknown) and `weakness`
 * (Bennett-style score in `[0, 1]`, where 1.0 = maximally general
 * claim, 0.0 = maximally specific claim). The weakness column is
 * metadata, not a gate: a PASS with weakness 0.92 is "loosely
 * asserted" (a reviewer that said little), a PASS with weakness 0.31
 * is "tightly asserted" (a reviewer that pinned many specifics). The
 * workbench now lets you see which you got, per node, in the same
 * Markdown file you already `tail -f`.
 *
 * @since Kraken v1.30.x — workflow script runtime (Pillar 3)
 * @since Kraken v1.31.x — verdict + weakness surfaced in workbench
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePersonaVerdict } from '@zelari/core';

export type NodeStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
export type VerdictLabel = 'pass' | 'fail' | 'unknown';

export interface WorkbenchNode {
  id: string;
  kind: string;
  label: string;
  status: NodeStatus;
  scope?: string[];
  model?: string;
  durationMs?: number;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  /**
   * Reviewer verdict for verify / spec / conformance nodes. Set when the
   * node's `findings` is parsed via `parsePersonaVerdict` on `markEnd`.
   *
   * @since v1.31.x
   */
  verdict?: VerdictLabel;
  /**
   * Bennett-style weakness score in `[0, 1]`. 1.0 = maximally general
   * (the reviewer asserted nothing specific), 0.0 = maximally specific
   * (pinned paths, versions, line numbers, etc.). Surfaced in the
   * workbench so a user can see whether a PASS was earned by a tightly
   * or loosely grounded reviewer.
   *
   * @since v1.31.x
   */
  weaknessScore?: number;
}

export interface WorkbenchEvent {
  ts: string;
  text: string;
}

export interface WorkbenchOptions {
  /** Repository root (the parent CWD of the run). */
  cwd: string;
  /** Stable id for this graph run. */
  graphId: string;
  /** The original goal text. */
  goal: string;
  /** Disable the writer entirely. Default: ON. */
  enabled?: boolean;
  /** Flush debounce (ms). Default: 500. */
  debounceMs?: number;
}

const DEBOUNCE_DEFAULT_MS = 500;
const MAX_EVENTS = 30;
const MAX_NODES_IN_TABLE = 200;

export function isWorkbenchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZELARI_KRAKEN_WORKBENCH ?? '1').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

function workbenchPath(cwd: string, graphId: string): string {
  return path.join(cwd, '.zelari', 'radio', `workbench-${graphId}.md`);
}

/** A workbench writer for one run. Cheap to construct. */
export class WorkbenchWriter {
  private readonly cwd: string;
  private readonly graphId: string;
  private readonly goal: string;
  private readonly enabled: boolean;
  private readonly debounceMs: number;
  private readonly startedAt: string;
  private readonly nodesById = new Map<string, WorkbenchNode>();
  private readonly events: WorkbenchEvent[] = [];
  private dirty = true;
  private timer: NodeJS.Timeout | null = null;
  private lastWrite: Promise<string | null> | null = null;

  constructor(opts: WorkbenchOptions) {
    this.cwd = opts.cwd;
    this.graphId = opts.graphId;
    this.goal = opts.goal;
    this.enabled = opts.enabled ?? isWorkbenchEnabled();
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_DEFAULT_MS;
    this.startedAt = new Date().toISOString();
  }

  /** Seed the writer with the planned nodes. Idempotent: later calls
   *  merge — a node's status is not reset to `pending` if it's already
   *  `running` / `done` / `error`. */
  setNodes(nodes: WorkbenchNode[]): void {
    if (!this.enabled) return;
    for (const n of nodes) {
      const existing = this.nodesById.get(n.id);
      if (!existing) this.nodesById.set(n.id, { ...n });
      // Preserve non-pending status.
      else if (existing.status !== 'pending') {
        this.nodesById.set(n.id, { ...existing, ...n, status: existing.status });
      } else {
        this.nodesById.set(n.id, { ...n });
      }
    }
    this.markDirty();
  }

  markStart(id: string, patch: Partial<WorkbenchNode> = {}): void {
    if (!this.enabled) return;
    const n = this.nodesById.get(id) ?? { id, kind: 'general', label: id, status: 'pending' };
    this.nodesById.set(id, {
      ...n,
      ...patch,
      id,
      status: 'running',
      startedAt: patch.startedAt ?? new Date().toISOString(),
    });
    this.events.push({ ts: new Date().toISOString(), text: `node_start ${id} ${patch.kind ?? n.kind}` });
    this.markDirty();
  }

  markEnd(id: string, patch: { status: NodeStatus; durationMs?: number; error?: string; findings?: string }): void {
    if (!this.enabled) return;
    const n = this.nodesById.get(id);
    if (!n) return;

    // Parse the persona verdict out of `findings` (if any) so the workbench
    // can surface the verdict + Bennett-style weakness score in the Wave
    // table. Cheap: heuristic scan, no LLM, no I/O. Falls back to "no
    // verdict" when findings are empty or non-persona text.
    let verdict: VerdictLabel | undefined;
    let weaknessScore: number | undefined;
    if (patch.findings && patch.findings.length > 0) {
      const parsed = parsePersonaVerdict(patch.findings);
      verdict = parsed.verdict;
      weaknessScore = parsed.weaknessScore;
    }

    this.nodesById.set(id, {
      ...n,
      status: patch.status,
      ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
      ...(patch.error ? { error: patch.error.slice(0, 200) } : {}),
      ...(verdict ? { verdict } : {}),
      ...(typeof weaknessScore === 'number' ? { weaknessScore } : {}),
      endedAt: new Date().toISOString(),
    });
    this.events.push({
      ts: new Date().toISOString(),
      text: `node_end ${id} ${patch.status}${patch.durationMs !== undefined ? ` (${patch.durationMs}ms)` : ''}${verdict ? ` · ${verdict}${typeof weaknessScore === 'number' ? ` w=${weaknessScore.toFixed(2)}` : ''}` : ''}${patch.error ? ` — ${patch.error.slice(0, 80)}` : ''}`,
    });
    this.markDirty();
  }

  logEvent(text: string): void {
    if (!this.enabled) return;
    this.events.push({ ts: new Date().toISOString(), text });
    this.markDirty();
  }

  /** Mark "this set of node ids is running in parallel right now". The
   *  workbench surfaces a "wave" line so a `tail -f` reader can see when
   *  a new parallel wave starts. */
  markWave(ids: string[]): void {
    if (!this.enabled) return;
    this.events.push({ ts: new Date().toISOString(), text: `wave: ${ids.join(', ')}` });
    this.markDirty();
  }

  /** Force a synchronous-style flush. Returns the path written, or null
   *  when the writer is disabled. */
  async flush(): Promise<string | null> {
    if (!this.enabled) return null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.writeNow();
  }

  /** Cancel any pending debounced write. The next `flush()` will write. */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // --- internals ------------------------------------------------------------

  private markDirty(): void {
    if (!this.enabled) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Fire-and-forget the write; the test suite and live tail should
      // never see this rejection. The atomic rename is the real
      // durability guarantee.
      void this.writeNow().catch(() => {
        /* ignore — best-effort telemetry */
      });
    }, this.debounceMs);
  }

  private async writeNow(): Promise<string | null> {
    if (!this.enabled) return null;
    if (!this.dirty && this.lastWrite) return this.lastWrite;
    const out = workbenchPath(this.cwd, this.graphId);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const body = this.render();
    const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, out);
    this.dirty = false;
    this.lastWrite = Promise.resolve(out);
    return out;
  }

  private render(): string {
    const counts = countByStatus([...this.nodesById.values()]);
    const elapsed = formatElapsed(Date.now() - Date.parse(this.startedAt));
    const lines: string[] = [
      `# Kraken workbench`,
      ``,
      `**Goal:** ${this.goal}`,
      `**Graph id:** \`${this.graphId}\``,
      `**Started:** ${this.startedAt} · **Elapsed:** ${elapsed}`,
      ``,
      `## Progress: ${counts.done + counts.skipped}/${this.nodesById.size} · ${counts.running}↑ · ${counts.error}✗`,
      ``,
    ];

    lines.push(`## Wave`);
    lines.push(``);
    lines.push(`| id | label | kind | scope | status | verdict | weakness | model | duration |`);
    lines.push(`|----|-------|------|-------|--------|---------|----------|-------|----------|`);
    const sorted = [...this.nodesById.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_NODES_IN_TABLE);
    for (const n of sorted) {
      const status = statusEmoji(n.status);
      const scope = n.scope ? n.scope.join(', ') : '';
      const dur = n.durationMs != null ? formatMs(n.durationMs) : '';
      const verdict = n.verdict ?? '';
      const weakness = typeof n.weaknessScore === 'number' ? n.weaknessScore.toFixed(2) : '';
      lines.push(`| ${n.id} | ${n.label} | ${n.kind} | ${scope} | ${status} | ${verdict} | ${weakness} | ${n.model ?? ''} | ${dur} |`);
    }
    lines.push(``);

    lines.push(`## Events (latest ${MAX_EVENTS})`);
    lines.push(``);
    const tail = this.events.slice(-MAX_EVENTS);
    if (tail.length === 0) {
      lines.push(`(no events yet)`);
    } else {
      for (const e of tail) lines.push(`- ${e.ts.slice(11, 19)} ${e.text}`);
    }
    lines.push(``);
    return lines.join('\n');
  }
}

// --- helpers -----------------------------------------------------------------

function countByStatus(nodes: WorkbenchNode[]): Record<NodeStatus, number> {
  const out: Record<NodeStatus, number> = { pending: 0, running: 0, done: 0, error: 0, skipped: 0 };
  for (const n of nodes) out[n.status] += 1;
  return out;
}

function statusEmoji(s: NodeStatus): string {
  switch (s) {
    case 'pending': return '○';
    case 'running': return '↑';
    case 'done': return '✓';
    case 'error': return '✗';
    case 'skipped': return '–';
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
