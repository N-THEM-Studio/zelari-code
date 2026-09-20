/**
 * session/replay.ts — tolerant log reader + projection.
 *
 * Replay never throws on a damaged log: corrupt lines, seq gaps, duplicates
 * and schema mismatches are reported as ReplayIssue so the trajectory can be
 * audited (replay reconstructs the trajectory, not model-output determinism).
 */

import { promises as fs } from 'node:fs';
import {
  SessionEventEnvelopeSchema,
  type SessionEventEnvelope,
} from './types.js';
import { deriveMessages, pairToolCalls, type DerivedMessage } from './modelSurface.js';
import { classifyInterruptedTools, type ToolInterrupted } from './recovery.js';
import { parseDecisionEvent, type DecisionEventSummary } from './decisionEvents.js';
import { projectVerifyDebts, type VerifyDebtSummary } from './verifyDebt.js';

export type ReplayIssueType =
  | 'corrupt-line'
  | 'schema-mismatch'
  | 'seq-duplicate'
  | 'seq-gap'
  | 'seq-nonmonotonic';

export interface ReplayIssue {
  type: ReplayIssueType;
  /** 1-based line number in the JSONL file. */
  line: number;
  seq?: number;
  detail?: string;
}

export interface ReplayReport {
  path: string;
  events: SessionEventEnvelope[];
  issues: ReplayIssue[];
  /** True when every line parsed and seq is 1..n gap-free. */
  ok: boolean;
}

export async function readSessionLog(filePath: string): Promise<ReplayReport> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: filePath, events: [], issues: [], ok: true };
    }
    throw err;
  }
  return parseSessionLogText(filePath, content);
}

/** Whole-file text → ReplayReport (shared with the incremental reader, Int4a). */
export function parseSessionLogText(filePath: string, content: string): ReplayReport {
  const { events, issues } = parseSessionLogLines(content.split('\n'));
  return { path: filePath, events, issues, ok: issues.length === 0 };
}

/**
 * Parse ONE batch of raw JSONL lines (as produced by `split('\n')`), carrying
 * the running `expected` seq and the 0-based index of the batch's first line.
 * The full reader above and the incremental byte-append reader (replayCache.ts)
 * share this, so both report the SAME events/issues for the same log — that
 * equivalence is the replay-cache contract.
 */
export function parseSessionLogLines(
  lines: readonly string[],
  opts: { expected?: number; linesConsumed?: number } = {},
): { events: SessionEventEnvelope[]; issues: ReplayIssue[]; expected: number; linesConsumed: number } {
  const events: SessionEventEnvelope[] = [];
  const issues: ReplayIssue[] = [];
  const base = opts.linesConsumed ?? 0;
  let expected = opts.expected ?? 1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const lineNo = base + i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      issues.push({ type: 'corrupt-line', line: lineNo });
      continue;
    }
    const result = SessionEventEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      issues.push({
        type: 'schema-mismatch',
        line: lineNo,
        detail: result.error.issues[0]?.message ?? 'schema validation failed',
      });
      continue;
    }
    const envelope = result.data;
    if (envelope.seq === expected) {
      events.push(envelope);
      expected += 1;
    } else if (envelope.seq < expected) {
      issues.push({ type: 'seq-duplicate', line: lineNo, seq: envelope.seq });
    } else {
      issues.push({
        type: 'seq-gap',
        line: lineNo,
        seq: envelope.seq,
        detail: `missing seq ${expected}..${envelope.seq - 1}`,
      });
      events.push(envelope);
      expected = envelope.seq + 1;
    }
  }
  return { events, issues, expected, linesConsumed: base + lines.length };
}

/** Loose summary of a verification.run event (defensive reads). */
export interface VerificationRunSummary {
  seq: number;
  at: number;
  results: Array<{ criterionId: string; status: string; evidenceCount: number }>;
  complete?: boolean;
}

export interface SessionProjection {
  sessionId: string;
  lastSeq: number;
  eventCount: number;
  startedAt?: number;
  endedAt?: number;
  fork?: { parentSessionId: string; parentSeq: number };
  resumedCount: number;
  messages: DerivedMessage[];
  toolCalls: number;
  toolResults: number;
  verifications: VerificationRunSummary[];
  missionPhases: Array<{ seq: number; phase: string }>;
  /** F4: advisory continuation advice records (mission.progress events). */
  missionAdvice: Array<{ seq: number; recommendation: string; rationale: string }>;
  replans: number;
  issues: ReplayIssue[];
  /** Dangling tool.call events classified for crash recovery (2.x B). */
  interruptedTools: ToolInterrupted[];
  /** WS1 (t133): pre-dispatch permission denials, in log order. */
  permissionDenials: PermissionDenialSummary[];
  /**
   * WS7 slice 2 (t140): every decision point on this spine, in log order —
   * the five new decision kinds plus `permission.denied` (see
   * decisionEvents.ts for why the two lists are one aggregate).
   */
  decisionEvents: DecisionEventSummary[];
  /** K1.5/F5 (t78): verify-debt slots, open + cleared, in first-open order. */
  verifyDebts: VerifyDebtSummary[];
  /** Per-tool tally over `tool.call` / `tool.result` (row order = first call). */
  toolCallBreakdown: ToolCallTally[];
}

/** One tool's call/result counters, as replay shows them. */
export interface ToolCallTally {
  tool: string;
  calls: number;
  results: number;
}

/**
 * Per-tool tally. A `tool.result` on a REAL spine carries only
 * `{callId, output, ok, durationMs}` — NOT the tool name (verified on a live
 * 938-event session log) — so results are attributed through `pairToolCalls`
 * (the same callId rule the model surface and recovery use). A result whose
 * call is not on this spine (a resumed log can start mid-turn) cannot be
 * attributed and is not counted here; the aggregate `toolCalls`/`toolResults`
 * counters still count it. Rows are ordered by calls desc, then name.
 */
function tallyToolCalls(events: readonly SessionEventEnvelope[]): ToolCallTally[] {
  const byTool = new Map<string, ToolCallTally>();
  const slot = (tool: string): ToolCallTally => {
    const found = byTool.get(tool) ?? { tool, calls: 0, results: 0 };
    byTool.set(tool, found);
    return found;
  };
  for (const pair of pairToolCalls(events)) {
    const tool = typeof pair.call.data.tool === 'string' ? pair.call.data.tool : '';
    if (tool.length === 0) continue;
    slot(tool).calls += 1;
    if (pair.result !== undefined) slot(tool).results += 1;
  }
  return [...byTool.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

/**
 * WS1 (t133): a `permission.denied` event, replayed. Defensive reads: an
 * older writer (or a hand-edited log) with a missing field yields '' rather
 * than throwing — replay must never die on telemetry.
 */
export interface PermissionDenialSummary {
  seq: number;
  at: number;
  tool: string;
  matchedRuleId: string;
  source: string;
  reason: string;
}

function parsePermissionDenial(e: SessionEventEnvelope): PermissionDenialSummary {
  return {
    seq: e.seq,
    at: e.ts,
    tool: String(e.data.tool ?? ''),
    matchedRuleId: String(e.data.matchedRuleId ?? ''),
    source: String(e.data.source ?? ''),
    reason: String(e.data.reason ?? ''),
  };
}

function parseVerification(e: SessionEventEnvelope): VerificationRunSummary {
  const raw = Array.isArray(e.data.results) ? e.data.results : [];
  const results = raw
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      criterionId: String(r.criterionId ?? 'unknown'),
      status: String(r.status ?? 'unknown'),
      evidenceCount: Array.isArray(r.evidence) ? r.evidence.length : 0,
    }));
  return {
    seq: e.seq,
    at: e.ts,
    results,
    complete: typeof e.data.complete === 'boolean' ? e.data.complete : undefined,
  };
}

/** Build the materialized view of a session from its (valid) events. */
export function buildProjection(events: readonly SessionEventEnvelope[], issues: ReplayIssue[] = []): SessionProjection {
  const last = events[events.length - 1];
  const projection: SessionProjection = {
    sessionId: last?.sessionId ?? '',
    lastSeq: last?.seq ?? 0,
    eventCount: events.length,
    resumedCount: 0,
    messages: deriveMessages(events),
    toolCalls: 0,
    toolResults: 0,
    verifications: [],
    missionPhases: [],
    missionAdvice: [],
    replans: 0,
    issues,
    interruptedTools: classifyInterruptedTools(events),
    permissionDenials: [],
    decisionEvents: [],
    verifyDebts: projectVerifyDebts(events),
    toolCallBreakdown: tallyToolCalls(events),
  };
  for (const e of events) {
    switch (e.kind) {
      case 'session.started':
        projection.startedAt = e.ts;
        break;
      case 'session.ended':
        projection.endedAt = e.ts;
        break;
      case 'session.resumed':
        projection.resumedCount += 1;
        break;
      case 'session.forked':
        projection.fork = {
          parentSessionId: String(e.data.parentSessionId ?? ''),
          parentSeq: Number(e.data.parentSeq ?? 0),
        };
        break;
      case 'tool.call':
        projection.toolCalls += 1;
        break;
      case 'tool.result':
        projection.toolResults += 1;
        break;
      case 'verification.run':
        projection.verifications.push(parseVerification(e));
        break;
      case 'mission.phase':
        projection.missionPhases.push({ seq: e.seq, phase: String(e.data.phase ?? '') });
        break;
      case 'mission.replan':
        projection.replans += 1;
        break;
      case 'mission.progress':
        projection.missionAdvice.push({
          seq: e.seq,
          recommendation: String(e.data.recommendation ?? ''),
          rationale: String(e.data.rationale ?? ''),
        });
        break;
      case 'permission.denied':
        projection.permissionDenials.push(parsePermissionDenial(e));
        // …and it IS a decision point: the WS1 denial joins the aggregate too
        // (its dedicated field stays for back-compat consumers — see
        // DECISION_PROJECTION_KINDS).
        projection.decisionEvents.push(parseDecisionEvent(e));
        break;
      // WS7 slice 2 (t140): decision points. Listed explicitly (not a `default`
      // guard) so "who replays ask_user.fired?" answers itself by grep.
      case 'permission.asked':
      case 'auto_approve.granted':
      case 'jail.blocked':
      case 'ask_user.fired':
      case 'verify.requested':
        projection.decisionEvents.push(parseDecisionEvent(e));
        break;
    }
  }
  return projection;
}
