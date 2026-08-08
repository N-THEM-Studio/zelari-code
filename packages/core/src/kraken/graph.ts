/**
 * Kraken graph engine — pure DAG model & validation (no CLI dependencies).
 *
 * This module is intentionally dependency-free so it lives in @zelari/core
 * and is unit-testable without the CLI. Orchestration (LLM planner, executor,
 * worktree/world-model wiring) lives in the CLI (`src/cli/kraken/`) and imports
 * these primitives. See `.zelari/docs/kraken-graph-engine-plan.md` (CORREZIONE-1).
 *
 * @since v0.10.x — Kraken graph engine (F1)
 */

/** What a graph node does. Mirrors taskTool kinds plus graph-only kinds.
 *  `spec` and `conformance` are the Pillar-2 spec-council personas: they
 *  run as `verify` agents under the hood but with persona-specific
 *  system prompts and verdict schemas. */
export type TaskNodeKind = 'explore' | 'general' | 'verify' | 'fix' | 'merge' | 'spec' | 'conformance';

/** Lifecycle state of a node within an executing graph. */
export type TaskNodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped';

/** States that mean "this node will not run (again)". */
export const TERMINAL_STATUSES: readonly TaskNodeStatus[] = [
  'done',
  'error',
  'skipped',
];

/** A single unit of work in a Kraken task graph. */
export interface TaskNode {
  /** Unique id within the graph (e.g. `e1`, `g2`, `fix-g1-1`). */
  id: string;
  kind: TaskNodeKind;
  /** Short human label (for radio / status UI). */
  label: string;
  /** Full self-contained prompt handed to the sub-agent. */
  prompt: string;
  /** Optional path/glob allowlist (contract). Required for parallel general/fix. */
  scope?: string[];
  /** Optional acceptance checklist (contract). */
  acceptance?: string[];
  /** Ids of predecessor nodes that must be `done` before this one may start. */
  deps: string[];
  status: TaskNodeStatus;
  /** How many times this node has been retried after a failure. */
  retryCount: number;
  /** Max retries before a fix-node is spawned (or permanent failure). */
  maxRetries: number;
  /** Final sub-agent conclusion (set when `done`). */
  result?: string;
  /** Last error message (set when `error`). */
  error?: string;
}

/** A directed acyclic graph of task nodes, keyed by node id. */
export interface TaskGraph {
  id: string;
  nodes: Map<string, TaskNode>;
}

/** Result of {@link validateGraph}. */
export type GraphValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

export interface ValidateGraphOptions {
  /** Anti-explosion bound on node count. Default 24 (ZELARI_KRAKEN_MAX_NODES). */
  maxNodes?: number;
}

/** Default anti-explosion bound for graph size. */
export const DEFAULT_MAX_NODES = 24;

/** Build a graph from a flat list of nodes (indexing by id). */
export function createGraph(id: string, nodes: TaskNode[]): TaskGraph {
  const map = new Map<string, TaskNode>();
  for (const n of nodes) map.set(n.id, n);
  return { id, nodes: map };
}

/**
 * Validate structural integrity of a graph:
 *  - node ids are unique and non-empty
 *  - every dep references an existing node
 *  - no dependency cycles (the graph is a DAG)
 *  - node count within `maxNodes`
 *
 * Pure and side-effect free. Returns all detected errors (not just the first).
 */
export function validateGraph(
  graph: TaskGraph,
  opts: ValidateGraphOptions = {},
): GraphValidation {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const errors: string[] = [];
  const nodes = graph.nodes;

  if (nodes.size === 0) {
    errors.push('graph is empty (no nodes)');
  }
  if (nodes.size > maxNodes) {
    errors.push(`graph has ${nodes.size} nodes, exceeding maxNodes=${maxNodes}`);
  }

  for (const [id, node] of nodes) {
    if (!id || id.trim() === '') {
      errors.push('node with empty id');
      continue;
    }
    if (node.id !== id) {
      errors.push(`node keyed "${id}" has mismatching node.id "${node.id}"`);
    }
    for (const dep of node.deps) {
      if (!nodes.has(dep)) {
        errors.push(`node "${id}" depends on unknown node "${dep}"`);
      }
      if (dep === id) {
        errors.push(`node "${id}" depends on itself`);
      }
    }
  }

  const cycle = findCycle(nodes);
  if (cycle) {
    errors.push(`dependency cycle detected: ${cycle.join(' -> ')}`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Detect a dependency cycle via iterative DFS with white/gray/black coloring.
 * Returns one cycle as an id path (e.g. ['a','b','a']) or null if acyclic.
 */
function findCycle(nodes: Map<string, TaskNode>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodes.keys()) color.set(id, WHITE);

  for (const start of nodes.keys()) {
    if (color.get(start) !== WHITE) continue;
    // Stack of [nodeId, nextDepIndex]; path tracks the current DFS chain.
    const stack: Array<[string, number]> = [[start, 0]];
    const path: string[] = [];
    color.set(start, GRAY);
    path.push(start);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const [id, idx] = top;
      const node = nodes.get(id);
      const deps = node ? node.deps : [];

      if (idx < deps.length) {
        top[1] = idx + 1;
        const dep = deps[idx];
        if (!nodes.has(dep)) continue; // unknown dep — reported by validateGraph
        const c = color.get(dep);
        if (c === GRAY) {
          // Back edge → cycle. Slice the path from the first occurrence of dep.
          const at = path.indexOf(dep);
          return [...path.slice(at), dep];
        }
        if (c === WHITE) {
          color.set(dep, GRAY);
          path.push(dep);
          stack.push([dep, 0]);
        }
      } else {
        color.set(id, BLACK);
        path.pop();
        stack.pop();
      }
    }
  }
  return null;
}

/**
 * Nodes that may start now: status `pending` with every dep already `done`.
 * (Deps in `error`/`skipped` do NOT satisfy readiness — the executor decides
 * whether to skip downstream nodes.)
 */
export function getReadyNodes(graph: TaskGraph): TaskNode[] {
  const ready: TaskNode[] = [];
  for (const node of graph.nodes.values()) {
    if (node.status !== 'pending') continue;
    const depsReady = node.deps.every((d) => graph.nodes.get(d)?.status === 'done');
    if (depsReady) ready.push(node);
  }
  return ready;
}

/**
 * Group node ids into topological levels (Kahn's algorithm). Level 0 has no
 * deps; level N depends only on levels < N. Useful for ASCII rendering and
 * coarse scheduling. Nodes in a cycle are omitted (validateGraph rejects them).
 */
export function topoLevels(graph: TaskGraph): string[][] {
  const nodes = graph.nodes;
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [id, node] of nodes) {
    indegree.set(id, node.deps.filter((d) => nodes.has(d)).length);
    for (const dep of node.deps) {
      if (!nodes.has(dep)) continue;
      const arr = dependents.get(dep) ?? [];
      arr.push(id);
      dependents.set(dep, arr);
    }
  }

  const levels: string[][] = [];
  let frontier = [...nodes.keys()].filter((id) => (indegree.get(id) ?? 0) === 0);
  const visited = new Set<string>();

  while (frontier.length > 0) {
    levels.push([...frontier].sort());
    const next: string[] = [];
    for (const id of frontier) {
      visited.add(id);
      for (const child of dependents.get(id) ?? []) {
        const d = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, d);
        if (d === 0) next.push(child);
      }
    }
    frontier = next;
  }
  return levels;
}

/** True when no node is `pending` or `running` (execution has settled). */
export function isSettled(graph: TaskGraph): boolean {
  for (const node of graph.nodes.values()) {
    if (node.status === 'pending' || node.status === 'running') return false;
  }
  return true;
}

/** True when every node finished successfully (`done` or `skipped`). */
export function isConverged(graph: TaskGraph): boolean {
  if (graph.nodes.size === 0) return false;
  for (const node of graph.nodes.values()) {
    if (node.status !== 'done' && node.status !== 'skipped') return false;
  }
  return true;
}

/** Ids of nodes in a terminal failure state. */
export function failedNodeIds(graph: TaskGraph): string[] {
  const out: string[] = [];
  for (const node of graph.nodes.values()) {
    if (node.status === 'error') out.push(node.id);
  }
  return out;
}

/** Count nodes by status (for status UI: "graph 3/8 · 2↑"). */
export function countByStatus(graph: TaskGraph): Record<TaskNodeStatus, number> {
  const counts: Record<TaskNodeStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    error: 0,
    skipped: 0,
  };
  for (const node of graph.nodes.values()) counts[node.status] += 1;
  return counts;
}
