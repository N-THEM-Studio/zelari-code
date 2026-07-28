/**
 * Kraken graph engine — cross-run memory.
 *
 * The planner is a one-shot completion: it sees the goal text and nothing
 * else. So a follow-up like "continua" after a partially failed graph was
 * planned from scratch, with no knowledge of what had already been built or
 * what had failed — the model's best available move was to re-explore, which
 * produced a single read-only node that converged having changed nothing.
 *
 * This module persists a compact snapshot of the last graph next to the other
 * Kraken state (`.zelari/kraken/last-graph.json`) so the planner can be told
 * where the previous attempt stopped.
 *
 * Deliberately small: node ids, kinds, labels, scopes and terminal statuses.
 * Not prompts or results — those are large, and the sub-agent that picks the
 * work up reads the actual repository anyway.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskGraph, TaskNodeStatus, UnresolvedFinding } from '@zelari/core';

const SNAPSHOT_DIR = path.join('.zelari', 'kraken');
const SNAPSHOT_FILE = 'last-graph.json';

/** Compact record of how one node ended. */
export interface GraphSnapshotNode {
  id: string;
  kind: string;
  label: string;
  status: TaskNodeStatus;
  scope?: string[];
  error?: string;
}

export interface GraphSnapshot {
  graphId: string;
  goal: string;
  finishedAt: string;
  converged: boolean;
  nodes: GraphSnapshotNode[];
  /**
   * Verify verdicts the run accepted without resolving. A converged graph is
   * otherwise indistinguishable from a clean one, so the next planning pass
   * would file rejected work under "already completed — do NOT redo".
   */
  unresolvedFindings?: UnresolvedFinding[];
}

/** Cap on stored findings text — the snapshot is a briefing, not a transcript. */
const MAX_SNAPSHOT_FINDINGS_CHARS = 400;

function snapshotPath(cwd: string): string {
  return path.join(cwd, SNAPSHOT_DIR, SNAPSHOT_FILE);
}

/** Reduce a live graph to the snapshot shape. */
export function toGraphSnapshot(
  graph: TaskGraph,
  opts: {
    goal: string;
    converged: boolean;
    unresolvedFindings?: UnresolvedFinding[];
  },
): GraphSnapshot {
  const unresolved = (opts.unresolvedFindings ?? []).map((u) => ({
    ...u,
    findings: u.findings.slice(0, MAX_SNAPSHOT_FINDINGS_CHARS),
  }));
  return {
    graphId: graph.id,
    goal: opts.goal,
    finishedAt: new Date().toISOString(),
    converged: opts.converged,
    ...(unresolved.length > 0 ? { unresolvedFindings: unresolved } : {}),
    nodes: [...graph.nodes.values()].map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      status: n.status,
      ...(n.scope && n.scope.length > 0 ? { scope: n.scope } : {}),
      ...(n.error ? { error: n.error.slice(0, 300) } : {}),
    })),
  };
}

/** Best-effort persist; never throws (memory is an optimization, not state). */
export async function saveGraphSnapshot(cwd: string, snapshot: GraphSnapshot): Promise<void> {
  try {
    // Don't materialize a directory tree for a path that isn't a real project
    // (tests pass synthetic cwds).
    await fs.access(cwd);
    const file = snapshotPath(cwd);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  } catch {
    // ignore
  }
}

/** Best-effort load; returns null when absent or unreadable. */
export async function loadGraphSnapshot(cwd: string): Promise<GraphSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as GraphSnapshot;
    if (!parsed || !Array.isArray(parsed.nodes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Render a snapshot as the "previous attempt" briefing appended to the
 * planner prompt. Returns '' when there is nothing worth telling the model
 * (no snapshot, or the previous run finished cleanly with everything done).
 */
export function formatSnapshotForPlanner(snapshot: GraphSnapshot | null): string {
  if (!snapshot) return '';
  const done = snapshot.nodes.filter((n) => n.status === 'done');
  const failed = snapshot.nodes.filter((n) => n.status === 'error');
  const skipped = snapshot.nodes.filter((n) => n.status === 'skipped');
  const rejected = snapshot.unresolvedFindings ?? [];
  // Work a reviewer rejected is unfinished business even though every node
  // reached `done` — briefing the planner on a converged-but-rejected run is
  // exactly the case this section exists for.
  if (failed.length === 0 && skipped.length === 0 && rejected.length === 0) return '';

  const line = (n: GraphSnapshotNode): string =>
    `- ${n.label}${n.scope ? ` [${n.scope.join(', ')}]` : ''}${n.error ? ` — ${n.error}` : ''}`;

  // The previous goal is quoted verbatim: the stored snapshot is per-project,
  // not per-goal, so the last unfinished graph may belong to entirely
  // different work. Naming it lets the model decide whether this is a
  // continuation or an unrelated request, instead of being told that somebody
  // else's failed nodes belong to the goal it was just given.
  const rejectedIds = new Set(rejected.map((r) => r.nodeId));
  const outcome = [
    `${done.length} done`,
    `${failed.length} failed`,
    `${skipped.length} never ran`,
    ...(rejected.length > 0 ? [`${rejected.length} rejected by review`] : []),
  ].join(', ');

  const parts = [
    '',
    '## Previous unfinished task graph in this project',
    `Goal it was working on: "${snapshot.goal}"`,
    `It did NOT finish cleanly (${outcome}).`,
    '',
    'If that goal is unrelated to the one above, ignore this section entirely.',
    '',
  ];
  // A rejected node is listed under its own heading, never under "do NOT redo".
  const cleanlyDone = done.filter((n) => !rejectedIds.has(n.id));
  if (cleanlyDone.length > 0) {
    parts.push('Already completed — do NOT redo this work:', ...cleanlyDone.map(line), '');
  }
  if (rejected.length > 0) {
    parts.push(
      'Completed but REJECTED by review — the code exists, the defects do not fix themselves:',
      ...rejected.map(
        (r) => `- ${r.label} — ${r.findings.trim().split('\n')[0] ?? 'no detail'}`,
      ),
      '',
    );
  }
  if (failed.length > 0) {
    parts.push('Failed — needs to be finished or repaired:', ...failed.map(line), '');
  }
  if (skipped.length > 0) {
    parts.push('Never ran (blocked by the failures above):', ...skipped.map(line), '');
  }
  parts.push(
    'Plan only the remaining work. Inspect what is already on disk before rewriting it, ' +
      'and prefer wiring/finishing existing modules over recreating them.',
  );
  return parts.join('\n');
}
