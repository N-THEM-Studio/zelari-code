/**
 * verdictFeed — the `verdict` status-line item, derived from the session spine.
 *
 * DERIVE-ONLY (ADR-0016/0024): this module READS the `verification.*` events of
 * the CURRENT run. It never writes, never caches and never injects anything into
 * the model context (that path is gated by ADR-0031 context.projection).
 *
 * THE EVENTS IT ACTUALLY READS (grounded in
 * packages/core/src/verification/engine.ts + src/cli/kraken/verificationBridge.ts):
 *   - `verification.evidence` — one executed observation (command/fs check, exit
 *     code, digest). It carries NO criterionId, so it can only be COUNTED,
 *     never attributed to a criterion (record-first: no invented attribution).
 *   - `verification.run` — the machine-readable record. Fields used, when
 *     present: `verdict` (PASS | REPAIR_REQUIRED | BLOCKED), `strict`,
 *     `summary`, `legacy{total,passed}`, `evidence{satisfied,
 *     unsatisfied[{id,status,reason}],complete}`, and — when the deterministic
 *     engine ran — `native` / `compiled` `{criteria[{id,required}],
 *     results[{criterionId,status}]}`. The LAST one on the log wins.
 *
 * PHASES: a criterion id is `<phase>.<name>` (criteriaPack.v1 taxonomy:
 * `correctness.*`, `quality.*`, `evidence.*`), so the phase name is the id
 * prefix. A record that carries no criterion ids has NO phases — an empty
 * array, never a fabricated grouping.
 *
 * HONESTY (ADR-0023, unknown ≠ pass): no record at all ⇒ `ready: null`, no item text; no
 * recorded denominator ⇒ the item shows the verdict word alone. Kill switch:
 * `ZELARI_VERDICT_FEED=0` ⇒ `verdictFeedEnabled()` false and
 * `verdictFeedText()` null, i.e. the item renders nothing (same default-ON /
 * read-time kill-switch discipline as spineEnabled / strictDoneEnabled).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSessionLogText, resolveSessionsDir } from '@zelari/core/session';
import { getCurrentSessionId } from '../sessionManager.js';

/** Structural event view (a SessionEventEnvelope is assignable to it). */
export interface VerdictEventLike {
  kind: string;
  seq: number;
  ts: number;
  data?: Record<string, unknown>;
}

export type VerdictWord = 'PASS' | 'REPAIR_REQUIRED' | 'BLOCKED' | 'unknown';

/** A phase = an id prefix. `unknown` covers "not evaluated yet" AND "no deterministic check" — never pass. */
export type VerdictPhaseStatus = 'pass' | 'fail' | 'unknown';

export interface VerdictPhase {
  name: string;
  passed: number;
  total: number;
  status: VerdictPhaseStatus;
}

export interface VerdictFeed {
  /** true = a recorded PASS, false = a recorded non-pass, null = nothing recorded / unreadable. */
  ready: boolean | null;
  /** Recorded verdict word, or null when no record exists. */
  verdict: VerdictWord | null;
  strict: boolean;
  summary: string;
  passed: number;
  total: number;
  /** `verification.evidence` observations recorded after the last run record (an in-flight check). */
  observations: number;
  phases: VerdictPhase[];
  /** seq of the record the counts came from; null ⇒ nothing recorded yet. */
  seq: number | null;
}

const VERDICTS = new Set<string>(['PASS', 'REPAIR_REQUIRED', 'BLOCKED']);

/** Default-ON kill switch: only the exact `0` disables the item. */
export function verdictFeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZELARI_VERDICT_FEED !== '0';
}

/** The honest "nothing recorded" feed (EMPTY ≠ absent). */
export function emptyVerdictFeed(): VerdictFeed {
  return {
    ready: null,
    verdict: null,
    strict: false,
    summary: '',
    passed: 0,
    total: 0,
    observations: 0,
    phases: [],
    seq: null,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** `correctness.error-signals` → `correctness`; a prefix-less id stays itself. */
export function verdictPhaseName(criterionId: string): string {
  const dot = criterionId.indexOf('.');
  return dot > 0 ? criterionId.slice(0, dot) : criterionId;
}

/** One recorded run: per-criterion statuses + the totals the payload carried. */
interface RunRecord {
  seq: number;
  verdict: VerdictWord;
  strict: boolean;
  summary: string;
  /** criterionId → raw status ('pass' | 'fail' | 'missing' | 'unknown' | …). */
  statuses: Map<string, string>;
  /** First-seen criterion order (drives the phase order). */
  order: string[];
  legacyTotal?: number;
  legacyPassed?: number;
}

/** Add a criterion status once — the first source that mentions an id wins. */
function addStatus(rec: RunRecord, id: string, status: string): void {
  if (rec.statuses.has(id)) return;
  rec.statuses.set(id, status);
  rec.order.push(id);
}

/**
 * Fold the criteria/results blocks of one payload section (`native`, `compiled`,
 * or the engine's flat `results`). Results are read FIRST so a real status wins
 * over the `unknown` placeholder; criteria that never got a result are recorded
 * as `unknown` — listed but not evaluated is not a pass.
 */
function foldSection(rec: RunRecord, section: Record<string, unknown> | null): void {
  if (!section) return;
  for (const r of Array.isArray(section.results) ? section.results : []) {
    const row = asRecord(r);
    const id = typeof row?.criterionId === 'string' ? row.criterionId : null;
    if (id) addStatus(rec, id, typeof row?.status === 'string' ? row.status : 'unknown');
  }
  for (const c of Array.isArray(section.criteria) ? section.criteria : []) {
    const id = asRecord(c)?.id;
    if (typeof id === 'string' && id.length > 0) addStatus(rec, id, 'unknown');
  }
}

/** Parse one `verification.run` payload defensively (null when unusable). */
function parseRunRecord(ev: VerdictEventLike): RunRecord | null {
  const data = asRecord(ev.data);
  if (!data) return null;
  const verdictRaw = typeof data.verdict === 'string' ? data.verdict : '';
  const rec: RunRecord = {
    seq: ev.seq,
    verdict: VERDICTS.has(verdictRaw) ? (verdictRaw as VerdictWord) : 'unknown',
    strict: data.strict === true,
    summary: typeof data.summary === 'string' ? data.summary : '',
    statuses: new Map(),
    order: [],
  };
  const evidence = asRecord(data.evidence);
  for (const id of asStringArray(evidence?.satisfied)) addStatus(rec, id, 'pass');
  for (const u of Array.isArray(evidence?.unsatisfied) ? evidence.unsatisfied : []) {
    const row = asRecord(u);
    const id = typeof row?.id === 'string' ? row.id : null;
    if (id) addStatus(rec, id, typeof row?.status === 'string' ? row.status : 'unknown');
  }
  // Per-criterion detail, when the deterministic engine was the source: the
  // engine's flat `results` first (most specific), then the pack sections.
  foldSection(rec, { criteria: [], results: data.results });
  foldSection(rec, asRecord(data.native));
  foldSection(rec, asRecord(data.compiled));
  const legacy = asRecord(data.legacy);
  if (typeof legacy?.total === 'number') rec.legacyTotal = legacy.total;
  if (typeof legacy?.passed === 'number') rec.legacyPassed = legacy.passed;
  return rec;
}

/** passed/total from recorded fields only: per-criterion statuses, else the legacy counters. */
function countRun(rec: RunRecord): { passed: number; total: number } {
  if (rec.statuses.size > 0) {
    let passed = 0;
    for (const status of rec.statuses.values()) if (status === 'pass') passed += 1;
    return { passed, total: rec.statuses.size };
  }
  const total = rec.legacyTotal ?? 0;
  return { passed: Math.min(rec.legacyPassed ?? 0, total), total };
}

/** One record per id prefix, in first-seen order; unresolved ⇒ `unknown`. */
interface PhaseAcc extends VerdictPhase {
  statuses: string[];
}

function buildPhases(rec: RunRecord): VerdictPhase[] {
  const byName = new Map<string, PhaseAcc>();
  for (const id of rec.order) {
    const name = verdictPhaseName(id);
    const phase: PhaseAcc = byName.get(name) ?? { name, passed: 0, total: 0, status: 'pass', statuses: [] };
    const status = rec.statuses.get(id) ?? 'unknown';
    phase.total += 1;
    if (status === 'pass') phase.passed += 1;
    phase.statuses.push(status);
    byName.set(name, phase);
  }
  return [...byName.values()].map(({ name, passed, total, statuses }) => ({
    name,
    passed,
    total,
    status: statuses.some((s) => s === 'fail' || s === 'missing')
      ? 'fail'
      : statuses.every((s) => s === 'pass')
        ? 'pass'
        : 'unknown',
  }));
}

/**
 * Project the verification events of ONE run into a verdict snapshot. Pure:
 * no I/O, no clock. The LAST recognizable `verification.run` wins; evidence
 * observations recorded after it are the in-flight counter.
 */
export function deriveVerdictFeed(events: readonly VerdictEventLike[]): VerdictFeed {
  let rec: RunRecord | null = null;
  let observations = 0;
  for (const ev of events) {
    if (ev.kind === 'verification.evidence') {
      observations += 1;
      continue;
    }
    if (ev.kind !== 'verification.run') continue;
    const parsed = parseRunRecord(ev);
    if (!parsed) continue;
    rec = parsed;
    observations = 0; // the observations before this record are its own evidence
  }
  if (!rec) return { ...emptyVerdictFeed(), observations };
  const { passed, total } = countRun(rec);
  return {
    ready: rec.verdict === 'PASS' ? true : rec.verdict === 'unknown' ? null : false,
    verdict: rec.verdict,
    strict: rec.strict,
    summary: rec.summary,
    passed,
    total,
    observations,
    phases: buildPhases(rec),
    seq: rec.seq,
  };
}

/**
 * Item text for the `verdict` statusline item, or null when there is nothing
 * honest to say (kill switch off, no record and no observation).
 */
export function verdictFeedText(feed: VerdictFeed | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!verdictFeedEnabled(env)) return null;
  if (!feed || feed.seq === null) {
    return feed && feed.observations > 0 ? `verify… ${feed.observations} obs` : null;
  }
  const counts = feed.total > 0 ? `${feed.passed}/${feed.total} · checks` : null;
  if (feed.ready === true) return counts ? `PASS ${counts}` : 'PASS';
  if (feed.verdict === 'BLOCKED') return counts ? `BLOCKED ${counts}` : 'BLOCKED';
  if (feed.verdict === 'REPAIR_REQUIRED') return counts ? `REPAIR ${counts}` : 'REPAIR';
  return counts; // verdict recorded but not recognized: counts only, never a word
}

export interface VerdictFeedReadOptions {
  /** Spine session id; defaults to the current-session marker. */
  sessionId?: string;
  /** Sessions dir override (tests); defaults to resolveSessionsDir({workspaceRoot, env}). */
  sessionsDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Read the verdict snapshot of the CURRENT run from its spine log. Tolerant by
 * contract: a missing marker/file, a corrupt log or a kill-switched feed all
 * return the empty feed — an unreadable spine is UNKNOWN, never a verdict.
 */
export function readVerdictFeed(opts: VerdictFeedReadOptions = {}): VerdictFeed {
  const env = opts.env ?? process.env;
  if (!verdictFeedEnabled(env)) return emptyVerdictFeed();
  const sessionId = opts.sessionId ?? getCurrentSessionId();
  if (!sessionId) return emptyVerdictFeed();
  const dir = opts.sessionsDir ?? resolveSessionsDir({ workspaceRoot: opts.cwd, env });
  const file = path.join(dir, sessionId, 'events.jsonl');
  try {
    if (!existsSync(file)) return emptyVerdictFeed();
    return deriveVerdictFeed(parseSessionLogText(file, readFileSync(file, 'utf-8')).events);
  } catch {
    return emptyVerdictFeed();
  }
}

/** Convenience for the renderer: the exact string the `verdict` item shows now. */
export function readVerdictFeedText(opts: VerdictFeedReadOptions = {}): string | null {
  return verdictFeedText(readVerdictFeed(opts), opts.env ?? process.env);
}
