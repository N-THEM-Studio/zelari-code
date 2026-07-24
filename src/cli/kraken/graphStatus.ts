/**
 * Kraken graph engine — observability (F5).
 *
 * Two independent pieces:
 *   - `formatKrakenGraphAscii` — a pure renderer of a `TaskGraph`'s topology
 *     and current node statuses (`/kraken graph` status block).
 *   - a lightweight in-process "current graph" live tracker, mirroring
 *     `krakenLive.ts`'s per-tentacle tracker but at the whole-graph level
 *     (needed for accurate pending/skipped/merge-node counts that a
 *     per-tentacle view can't see), feeding a StatusBar chip
 *     ("graph 3/8 · 2↑") the same way `formatKrakenLiveSummary` does for
 *     individual tentacles.
 *
 * Complements the `graph_*`/`node_*` radio events emitted by the F3
 * executor (`src/cli/kraken/executor.ts`), which is also what drives this
 * tracker via start/update/end calls around its scheduling loop.
 *
 * @since v0.10.x — Kraken graph engine (F5)
 */

import {
  topoLevels,
  countByStatus,
  type TaskGraph,
  type TaskNodeStatus,
} from '@zelari/core';

const STATUS_ICON: Record<TaskNodeStatus, string> = {
  pending: '·',
  running: '…',
  done: '✓',
  error: '✗',
  skipped: '»',
};

/** Multi-line ASCII rendering of a graph's topology + current node statuses. */
export function formatKrakenGraphAscii(graph: TaskGraph): string {
  const counts = countByStatus(graph);
  const summaryParts = [`${counts.done}/${graph.nodes.size} done`];
  if (counts.running) summaryParts.push(`${counts.running} running`);
  if (counts.error) summaryParts.push(`${counts.error} failed`);
  if (counts.skipped) summaryParts.push(`${counts.skipped} skipped`);
  const summary = `Kraken graph "${graph.id}" — ${summaryParts.join(', ')}`;

  const levels = topoLevels(graph);
  const lines = levels.map((ids, i) => {
    const cells = ids.map((id) => {
      const n = graph.nodes.get(id);
      if (!n) return `[?] ${id}`;
      const icon = STATUS_ICON[n.status];
      const scope = n.scope && n.scope.length > 0 ? `(${n.scope.join(',')})` : '';
      return `[${icon}] ${n.id}${scope}`;
    });
    return `L${i}: ${cells.join('  ')}`;
  });

  if (lines.length === 0) return summary;
  return [summary, ...lines].join('\n');
}

// ─── Live graph-progress tracker (StatusBar / Desktop) ────────────────────

export interface LiveGraphSummary {
  graphId: string;
  total: number;
  pending: number;
  running: number;
  done: number;
  error: number;
  skipped: number;
  startedAt: number;
  endedAt?: number;
  converged?: boolean;
}

type G = { __zelariKrakenGraphLive?: LiveGraphSummary | null };

function state(): G {
  return globalThis as unknown as G;
}

/** Called by the executor when a graph run starts. */
export function startKrakenGraphLive(graph: TaskGraph): void {
  const counts = countByStatus(graph);
  state().__zelariKrakenGraphLive = {
    graphId: graph.id,
    total: graph.nodes.size,
    pending: counts.pending,
    running: counts.running,
    done: counts.done,
    error: counts.error,
    skipped: counts.skipped,
    startedAt: Date.now(),
  };
}

/** Called by the executor after each scheduling pass to refresh counts. */
export function updateKrakenGraphLive(graph: TaskGraph): void {
  const live = state().__zelariKrakenGraphLive;
  if (!live || live.graphId !== graph.id) return;
  const counts = countByStatus(graph);
  live.total = graph.nodes.size;
  live.pending = counts.pending;
  live.running = counts.running;
  live.done = counts.done;
  live.error = counts.error;
  live.skipped = counts.skipped;
}

/** Called by the executor once the graph settles. */
export function endKrakenGraphLive(graph: TaskGraph, converged: boolean): void {
  updateKrakenGraphLive(graph);
  const live = state().__zelariKrakenGraphLive;
  if (!live || live.graphId !== graph.id) return;
  live.endedAt = Date.now();
  live.converged = converged;
}

/** Clear the tracked graph (e.g. before starting a new one, or in tests). */
export function resetKrakenGraphLive(): void {
  state().__zelariKrakenGraphLive = null;
}

/** The currently (or most recently) tracked graph's live summary, if any. */
export function getKrakenGraphLive(): LiveGraphSummary | null {
  return state().__zelariKrakenGraphLive ?? null;
}

/** One-line chip for StatusBar: "graph 3/8 · 2↑" or null if no graph tracked. */
export function formatKrakenGraphSummary(): string | null {
  const live = getKrakenGraphLive();
  if (!live) return null;
  const parts: string[] = [`${live.done}/${live.total}`];
  if (live.running) parts.push(`${live.running}↑`);
  if (live.error) parts.push(`${live.error}✗`);
  return `graph ${parts.join(' · ')}`;
}
