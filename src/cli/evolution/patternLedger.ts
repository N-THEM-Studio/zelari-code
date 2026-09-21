/**
 * patternLedger — S1 failure-pattern ledger (ADR-0036). Clusters findings by
 * failure mechanism (tool|errorClass|termination) and emits a cluster ONLY when
 * the same mechanism repeats across ≥2 DISTINCT tasks — never one task retried
 * N times. P1: this clusters, it never promotes/applies. taskKey is INSTANCE
 * data, not identity. Empty input ⇒ honest zero, never a throw. Runners under
 * tools/eval READ src/cli/evolution — never the reverse.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Mirror of EVOLUTION_PATHS.patternLedger (kept local: a runtime ledger.js
 *  import breaks `node --experimental-strip-types`; a test keeps it in sync). */
export const PATTERN_LEDGER_REL = path.join('.zelari', 'evolution', 'pattern-ledger.jsonl');

export type PatternCategory = 'harness-repair' | 'model-accommodation';
/** Loose structural view of a finding (accepts the ledger Finding + evidence). */
export interface ClusterFinding {
  kind?: string;
  operator?: string;
  surface?: string;
  signal?: string;
  count?: number;
  sessions?: string[];
  taskKey?: string;
  taskClass?: string;
  firstAt?: string;
  lastAt?: string;
  evidence?: Record<string, unknown>;
}

export interface ClusterEntry {
  id: string; // 'c-NNNN' — sequential within one clusterFailures call
  key: string; // tool|errorClass|termination — the mechanism key
  category: PatternCategory;
  tool: string;
  errorClass: string;
  termination: string;
  count: number; // sum of finding.count (default 1 each)
  sessions: string[];
  taskKeys: string[];
  distinctTasks: number;
  taskClasses: string[]; // task-class dimension (NOT the key)
  firstAt: string;
  lastAt: string;
}
export const DEFAULT_MIN_DISTINCT_TASKS = 2;
function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
/** missionTaskId → sha256(normalized taskText) → sessionId. Stable across sessions. */
export function makeTaskKey(input: { missionTaskId?: string; taskText?: string; sessionId: string }): string {
  const mission = input.missionTaskId?.trim();
  if (mission) return mission;
  const normalized = (input.taskText ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized) return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return input.sessionId;
}
/** `tool|errorClass|termination` with 'unknown' fallbacks (kind backs termination). */
export function clusterKeyFor(input: { tool?: string; errorClass?: string; termination?: string; kind?: string }): string {
  const tool = nonEmpty(input.tool) ?? 'unknown';
  const errorClass = nonEmpty(input.errorClass) ?? 'unknown';
  const termination = nonEmpty(input.termination) ?? nonEmpty(input.kind) ?? 'unknown';
  return `${tool}|${errorClass}|${termination}`;
}
/** harness-repair (DEFAULT) vs model-accommodation. Accommodation requires a
 *  skill/prompt change touching NEITHER tool, verification nor observation. */
export function categorizeCluster(input: { kind?: string; operator?: string; patchHint?: string }): PatternCategory {
  const operator = nonEmpty(input.operator) ?? '';
  const haystack = `${input.kind ?? ''} ${operator} ${input.patchHint ?? ''}`.toLowerCase();
  const touchesHarness =
    /tool|verif|observ|compact|resource|budget|boundary|interrupt|loop|context/.test(haystack);
  if (operator === 'revise_skill' && !touchesHarness) return 'model-accommodation';
  return 'harness-repair';
}
interface Bucket {
  tool: string;
  errorClass: string;
  termination: string;
  operator?: string;
  patchHint?: string;
  count: number;
  findings: number;
  sessions: Set<string>;
  taskKeys: Set<string>;
  taskClasses: Set<string>;
  firstAt?: string;
  lastAt?: string;
}
function deriveTool(f: ClusterFinding): string {
  const ev = f.evidence ?? {};
  const explicit = nonEmpty(ev.toolName) ?? nonEmpty(ev.tool);
  if (explicit) return explicit;
  const signal = nonEmpty(f.signal);
  return signal && signal.includes(':') ? signal.slice(0, signal.indexOf(':')) : 'unknown';
}
/**
 * Group findings by mechanism; keep only clusters spanning ≥minDistinctTasks
 * distinct tasks. `unmapped` counts findings that produced no cluster (missing
 * taskKey, or a below-threshold cluster). Deterministic: sorted by mechanism
 * key; ids 'c-0001'… in that order.
 */
export function clusterFailures(
  findings: ReadonlyArray<ClusterFinding>,
  opts?: { minDistinctTasks?: number },
): { clusters: ClusterEntry[]; unmapped: number } {
  const minDistinct = Math.max(1, Math.floor(opts?.minDistinctTasks ?? DEFAULT_MIN_DISTINCT_TASKS));
  const buckets = new Map<string, Bucket>();
  let unmapped = 0;
  for (const f of findings) {
    const sessions = f.sessions ?? [];
    const taskKey = nonEmpty(f.taskKey) ?? nonEmpty(sessions[0]);
    if (!taskKey) {
      unmapped += 1; // no instance origin → not attributable to a task
      continue;
    }
    const tool = deriveTool(f);
    const errorClass = nonEmpty(f.evidence?.errorClass) ?? 'unknown';
    const termination = nonEmpty(f.evidence?.termination) ?? nonEmpty(f.kind) ?? 'unknown';
    const key = clusterKeyFor({ tool, errorClass, termination, kind: f.kind });
    let b = buckets.get(key);
    if (!b) {
      b = { tool, errorClass, termination, count: 0, findings: 0, sessions: new Set(), taskKeys: new Set(), taskClasses: new Set() };
      buckets.set(key, b);
    }
    b.findings += 1;
    b.count += typeof f.count === 'number' ? f.count : 1;
    for (const s of sessions) b.sessions.add(s);
    b.taskKeys.add(taskKey);
    if (!b.operator) b.operator = nonEmpty(f.operator);
    if (!b.patchHint) b.patchHint = nonEmpty(f.surface);
    const taskClass = nonEmpty(f.taskClass);
    if (taskClass) b.taskClasses.add(taskClass);
    if (f.firstAt && (!b.firstAt || f.firstAt < b.firstAt)) b.firstAt = f.firstAt;
    if (f.lastAt && (!b.lastAt || f.lastAt > b.lastAt)) b.lastAt = f.lastAt;
  }
  const clusters: ClusterEntry[] = [];
  for (const [key, b] of [...buckets.entries()].sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))) {
    if (b.taskKeys.size < minDistinct) {
      unmapped += b.findings; // below threshold — honest zero cluster
      continue;
    }
    clusters.push({
      id: `c-${String(clusters.length + 1).padStart(4, '0')}`,
      key,
      category: categorizeCluster({ kind: b.termination, operator: b.operator, patchHint: b.patchHint ?? key }),
      tool: b.tool,
      errorClass: b.errorClass,
      termination: b.termination,
      count: b.count,
      sessions: [...b.sessions].sort(),
      taskKeys: [...b.taskKeys].sort(),
      distinctTasks: b.taskKeys.size,
      taskClasses: [...b.taskClasses].sort(),
      firstAt: b.firstAt ?? '',
      lastAt: b.lastAt ?? '',
    });
  }
  return { clusters, unmapped };
}
export function patternLedgerPath(cwd: string = process.cwd()): string {
  return path.join(cwd, PATTERN_LEDGER_REL);
}
/** Append clusters as JSONL (mkdir -p; empty batch is a no-op). Never throws. */
export async function appendClusters(clusters: ClusterEntry[], cwd: string = process.cwd()): Promise<void> {
  if (clusters.length === 0) return;
  try {
    const file = patternLedgerPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${clusters.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf8');
  } catch {
    // fail-open telemetry — a ledger write must never break a run
  }
}
/** Tolerant replay: parse every line, skip corrupt ones. Missing file ⇒ []. */
export async function readClusters(cwd: string = process.cwd()): Promise<ClusterEntry[]> {
  const file = patternLedgerPath(cwd);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ClusterEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ClusterEntry;
      if (parsed && typeof parsed === 'object' && typeof parsed.key === 'string') out.push(parsed);
    } catch {
      // corrupt line — skip (tolerant replay)
    }
  }
  return out;
}
