/**
 * tools/eval/spineEvidence.ts — Fase 1 — evidence aggregator (report-only,
 * zero mutation). Data source: the session spine JSONL
 * (`<root>/.zelari/sessions/<sessionId>/events.jsonl`, override
 * `ZELARI_SESSIONS_DIR`); one line = one envelope per ADR-0016/0021, closed
 * vocabulary in packages/core/src/session/types.ts.
 *
 * Pure aggregation over raw spine lines: no I/O, no Date.now/random →
 * deterministic. FAIL-CLOSED everywhere: a malformed line is counted and
 * skipped; an unknown kind is counted (unknown-kind) and never treated as
 * failure; a verification verdict that is absent or unrecognized is
 * `unknown ≠ pass` but also `unknown ≠ failure` (ADR-0023). This module
 * only DESCRIBES evidence patterns — it never decides, repairs or mutates.
 */

/** One parsed spine line. `knownKind:false` ⇒ counted as unknown-kind, never a failure. */
export type ParsedLine =
  | { malformed: true; reason: string }
  | { malformed: false; kind: string; knownKind: boolean; data: Record<string, unknown> };

/** Closed spine vocabulary — frozen copy of SESSION_EVENT_KINDS (type-only; no packages/core import). */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'session.started', 'session.resumed', 'session.ended', 'session.forked',
  'session.harness_manifest', 'user.message', 'assistant.message',
  'tool.call', 'tool.result', 'tool.interrupted', 'session.compacted',
  'task.created', 'task.updated', 'task.contract', 'task.contract_updated',
  'council.member', 'mission.phase', 'mission.replan', 'mission.progress',
  'verification.run', 'verification.evidence',
  'resource.epoch_started', 'resource.snapshot', 'resource.limit_reached',
  'resource.reserve_entered', 'resource.overrun',
  'graph.node_started', 'graph.node_ended', 'note',
]);

/** Tolerant single-line parser: invalid JSON → malformed; missing/non-string kind → unknown-kind. */
export function parseSpineLine(line: string): ParsedLine {
  if (typeof line !== 'string') return { malformed: true, reason: 'not-a-string' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { malformed: true, reason: 'invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { malformed: true, reason: 'not-an-object' };
  }
  const rec = parsed as Record<string, unknown>;
  const kind = typeof rec.kind === 'string' ? rec.kind : '(missing-kind)';
  const data =
    rec.data !== null && typeof rec.data === 'object' && !Array.isArray(rec.data)
      ? (rec.data as Record<string, unknown>)
      : {};
  return { malformed: false, kind, knownKind: KNOWN_KINDS.has(kind), data };
}

export type FindingSeverity = 'high' | 'warn';

export interface EvidenceFinding {
  id: string;
  kind: string;
  severity: FindingSeverity;
  count: number;
  /** Sorted, unique session ids the evidence came from. */
  sessions: string[];
  detail: string;
  hint: string;
}

/** Deterministic finding order: severity high>warn, then count desc, then id asc. */
export function compareFindings(a: EvidenceFinding, b: EvidenceFinding): number {
  const rank = (s: FindingSeverity): number => (s === 'high' ? 0 : 1);
  return (
    rank(a.severity) - rank(b.severity) ||
    b.count - a.count ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export interface SpineSessionInput {
  sessionId: string;
  lines: string[];
}

export interface SpineEvidenceReport {
  sessionsScanned: number;
  eventsScanned: number;
  malformedLines: number;
  unknownKindEvents: number;
  findings: EvidenceFinding[];
}

export interface SpineEvidenceOpts {
  /** Minimum count for a finding to be emitted (default 3, clamped to >= 1). */
  minCount?: number;
}

export const DEFAULT_MIN_COUNT = 3;

interface Counter {
  count: number;
  sessions: Set<string>;
}

function bump(map: Map<string, Counter>, key: string, sessionId: string): Counter {
  let c = map.get(key);
  if (!c) {
    c = { count: 0, sessions: new Set() };
    map.set(key, c);
  }
  c.count += 1;
  c.sessions.add(sessionId);
  return c;
}

function note(c: Counter, sessionId: string): void {
  c.count += 1;
  c.sessions.add(sessionId);
}

/** lowercase → collapse whitespace → first 120 chars. */
export function normalizeErrorKey(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** errorKey source: data.error ?? String(data.output ?? ''); never throws on odd types. */
function errorKeyOf(data: Record<string, unknown>): string {
  const err = data.error;
  if (typeof err === 'string' && err.length > 0) return normalizeErrorKey(err);
  const out = data.output;
  if (out === undefined || out === null) return '';
  try {
    return normalizeErrorKey(String(out));
  } catch {
    return '';
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Threshold filter + severity escalation (count ≥ 2×minCount → high) + sorted unique sessions. */
function pushFinding(
  out: EvidenceFinding[],
  id: string,
  kind: string,
  c: Counter,
  detail: string,
  hint: string,
  minCount: number,
): void {
  if (c.count < minCount) return;
  out.push({
    id,
    kind,
    severity: c.count >= 2 * minCount ? 'high' : 'warn',
    count: c.count,
    sessions: [...c.sessions].sort(),
    detail,
    hint,
  });
}

const HINTS = {
  toolMisuse: 'Repeated ok=false from one tool usually means a fixed bad input — check the tool argument schema before reusing the same call shape.',
  repeatedToolError: 'Identical normalized error repeated — fix the root cause instead of retrying the same call.',
  resourcePressure: 'Context/budget pressure in this session — consider compacting earlier or trimming tool outputs.',
  compactionPressure: 'History is being truncated often — consider a smaller scope per session or earlier checkpoints.',
  verificationFailures: 'REPAIR_REQUIRED/BLOCKED verdicts (ADR-0023) block promotion — inspect what verification observed.',
  verificationUnknown: 'Verification ran without a recognizable verdict — made visible here; unknown is not a failure, but it is not a pass either.',
  graphNodeFailures: 'Graph nodes ending ok=false for this agent — inspect node inputs and agent configuration.',
  toolInterrupted: 'Interrupted tool calls (dangling) — check cancellation and timeout handling around the tool boundary.',
} as const;

/**
 * Aggregate evidence patterns across sessions. Emits a finding ONLY when its
 * count reaches `minCount` (default 3). Never throws on missing/malformed data.
 */
export function aggregateSpineEvidence(
  sessions: SpineSessionInput[],
  opts?: SpineEvidenceOpts,
): SpineEvidenceReport {
  const minCount = Math.max(1, Math.floor(opts?.minCount ?? DEFAULT_MIN_COUNT));
  let eventsScanned = 0;
  let malformedLines = 0;
  let unknownKindEvents = 0;

  const toolFailures = new Map<string, Counter>();
  const toolErrors = new Map<string, Counter & { tool: string; errorKey: string }>();
  const resourceBySession = new Map<string, Counter>();
  const compaction: Counter = { count: 0, sessions: new Set() };
  const verificationFail: Counter = { count: 0, sessions: new Set() };
  const verificationUnknown: Counter = { count: 0, sessions: new Set() };
  const graphFailures = new Map<string, Counter>();
  const interrupted: Counter = { count: 0, sessions: new Set() };

  for (const session of sessions) {
    const sid = asString(session.sessionId) ?? 'unknown-session';
    for (const line of session.lines) {
      if (typeof line !== 'string' || line.trim() === '') continue; // blank separators are not events
      const parsed = parseSpineLine(line);
      if (parsed.malformed) {
        malformedLines += 1;
        continue;
      }
      eventsScanned += 1;
      if (!parsed.knownKind) {
        unknownKindEvents += 1;
        continue; // unknown kind is not a failure — just made visible
      }
      const { kind, data } = parsed;
      switch (kind) {
        case 'tool.result': {
          if (data.ok !== false) break; // ok:true (or absent) is never a failure
          const tool = asString(data.tool) ?? 'unknown';
          bump(toolFailures, tool, sid);
          const errorKey = errorKeyOf(data);
          const bucketKey = `${tool}\u0000${errorKey}`;
          let bucket = toolErrors.get(bucketKey);
          if (!bucket) {
            bucket = { count: 0, sessions: new Set(), tool, errorKey };
            toolErrors.set(bucketKey, bucket);
          }
          bucket.count += 1;
          bucket.sessions.add(sid);
          break;
        }
        case 'tool.interrupted':
          note(interrupted, sid);
          break;
        case 'session.compacted':
          note(compaction, sid);
          break;
        case 'verification.run': {
          const verdict = asString(data.verdict);
          if (verdict === 'REPAIR_REQUIRED' || verdict === 'BLOCKED') {
            note(verificationFail, sid);
          } else if (verdict !== 'PASS') {
            // absent or unrecognized verdict: unknown ≠ pass, unknown ≠ failure
            note(verificationUnknown, sid);
          }
          break;
        }
        case 'graph.node_ended': {
          if (data.ok !== false) break; // ok missing or cancelled-only is not a failure claim
          bump(graphFailures, asString(data.agent) ?? 'unknown', sid);
          break;
        }
        case 'resource.limit_reached':
        case 'resource.overrun':
        case 'resource.reserve_entered':
          bump(resourceBySession, sid, sid);
          break;
        default:
          break; // known kind without an evidence pattern
      }
    }
  }

  const findings: EvidenceFinding[] = [];
  for (const [tool, c] of toolFailures) {
    pushFinding(findings, `tool-misuse:${tool}`, 'tool-misuse', c, `tool "${tool}" returned ok=false ${c.count} time(s)`, HINTS.toolMisuse, minCount);
  }
  for (const b of toolErrors.values()) {
    pushFinding(
      findings,
      `repeated-tool-error:${b.tool}:${b.errorKey.replace(/[^a-z0-9._-]+/g, '-') || '-'}`,
      'repeated-tool-error',
      b,
      `tool "${b.tool}" failed ${b.count} time(s) with: ${b.errorKey === '' ? '(no error detail)' : `"${b.errorKey}"`}`,
      HINTS.repeatedToolError,
      minCount,
    );
  }
  for (const [sid, c] of resourceBySession) {
    pushFinding(findings, `resource-pressure:${sid}`, 'resource-pressure', c, `session "${sid}" hit resource limits (limit_reached/overrun/reserve_entered) ${c.count} time(s)`, HINTS.resourcePressure, minCount);
  }
  pushFinding(findings, 'compaction-pressure', 'compaction-pressure', compaction, `session.compacted fired ${compaction.count} time(s) across ${compaction.sessions.size} session(s)`, HINTS.compactionPressure, minCount);
  pushFinding(findings, 'verification-failures', 'verification-failures', verificationFail, `verification.run verdict REPAIR_REQUIRED/BLOCKED ${verificationFail.count} time(s)`, HINTS.verificationFailures, minCount);
  pushFinding(findings, 'verification-unknown', 'verification-unknown', verificationUnknown, `verification.run with absent/unknown verdict ${verificationUnknown.count} time(s)`, HINTS.verificationUnknown, minCount);
  for (const [agent, c] of graphFailures) {
    pushFinding(findings, `graph-node-failures:${agent}`, 'graph-node-failures', c, `graph nodes of agent "${agent}" ended ok=false ${c.count} time(s)`, HINTS.graphNodeFailures, minCount);
  }
  pushFinding(findings, 'tool-interrupted', 'tool-interrupted', interrupted, `tool.interrupted fired ${interrupted.count} time(s)`, HINTS.toolInterrupted, minCount);

  findings.sort(compareFindings);
  return {
    sessionsScanned: sessions.length,
    eventsScanned,
    malformedLines,
    unknownKindEvents,
    findings,
  };
}
