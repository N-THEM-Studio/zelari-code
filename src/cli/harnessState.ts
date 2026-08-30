/**
 * harnessState.ts — HarnessState increment 1: a TYPED read-model derived from
 * the ADR-0016 session spine plus a per-turn Turn Completion Contract
 * (execution lens). Pure derivation — zero behavior change, no production
 * wiring this increment; the only I/O is the `readHarnessState` convenience.
 *
 * Idiom follows session/replay.ts `buildProjection`: one pass, switch over
 * the closed vocabulary, defensive payload reads, unknown kinds ignored.
 * A turn STARTS at `user.message` (earlier events are pre-message session
 * scaffolding) and CLOSES at the next `user.message` or `session.ended`; a
 * turn with neither stays open/pending. ADR-0023: unknown ≠ pass — a turn
 * WITHOUT verification evidence is not complete-by-default, and a non-strict
 * `verification.run` is not admissible (mirrors evaluateStrictBuildGateFromSession).
 */
import path from 'node:path';
import { readSessionLog, type SessionEventEnvelope } from '@zelari/core/session';

/** Verdict snapshot of the LAST `verification.run` inside a turn. */
export interface TurnVerificationRecord {
  /** data.strict — false/absent ⇒ evidence is NOT admissible (unknown ≠ pass). */
  strict: boolean;
  /** data.verdict, e.g. 'PASS' | 'BLOCKED'; 'unknown' when the payload omits it. */
  verdict: string;
}

/** One turn = one user.message and everything up to the next turn boundary. */
export interface TurnRecord {
  /** 1-based, in user.message order. */
  index: number;
  userText?: string;
  /** Sum of assistant.message text lengths in the turn (size accounting). */
  assistantChars?: number;
  /** LAST assistant message text of the turn (chars are preferred for size). */
  assistantText?: string;
  toolCalls: number;
  /** Unique tool names (tool.call data.tool) in first-seen order. */
  toolKinds: string[];
  verification?: TurnVerificationRecord;
  /** 'pending' = still open at end of log; 'error' = closed by a non-completed session.ended. */
  outcome: 'pending' | 'completed' | 'error';
}

/** Per-turn Turn Completion Contract: `complete` = AND of signals + verification gate; each failed rule pushes exactly one blocker (see contractFor). */
export interface TurnCompletionContract {
  turn: number;
  complete: boolean;
  signals: {
    userMessage: boolean;
    assistantReply: boolean;
    toolsSettled: boolean;
    verification?: TurnVerificationRecord;
  };
  blockers: string[];
}

export interface ExecutionLens {
  turnsTotal: number;
  contracts: TurnCompletionContract[];
}

export interface ContextProjectionRecord {
  contextChars: number;
  returnedCount: number;
}

/** Support-lens: what the harness fed the model around the turn loop. */
export interface SupportLens {
  /** `note` events with data.subject === 'context.projection' (W2 telemetry). */
  contextProjections: ContextProjectionRecord[];
  /** Count of `note` events with data.subject === 'memory_event'. */
  memoryEvents: number;
  /** Count of session.compacted events. */
  compactions: number;
  /** Sum of session.compacted data.tokensSaved when a writer provides it (none today). */
  tokensSavedByCompaction?: number;
}

export interface SessionLens {
  sessionId: string;
  /** 'pending' until session.ended, then the ended data.reason ('completed' | 'cancelled' | …). */
  status: 'pending' | (string & {});
  startedAt?: number;
  endedAt?: number;
  lastSeq: number;
}

export interface HarnessState {
  session: SessionLens;
  turns: TurnRecord[];
  execution: ExecutionLens;
  support: SupportLens;
}

interface TurnAcc extends TurnRecord {
  /** callIds of tool.call events still awaiting a matching tool.result. */
  unsettledCallIds: Set<string>;
  settledCallIds: Set<string>;
  /** tool.interrupted events inside the turn ⇒ tools never settled. */
  interrupted: number;
  assistantMessages: number;
  /** How the turn closed, plus the session.ended reason when that closed it. */
  closedBy?: 'next-turn' | 'session-ended';
  endReason?: string;
}

/** Defensive payload readers (buildProjection idiom). */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** A result without a usable callId cannot settle a call (`seq:` keys never collide). */
function asCallId(v: unknown, seq: number): string {
  return typeof v === 'string' && v.length > 0 ? v : `seq:${seq}`;
}

function newTurn(index: number, userText: string): TurnAcc {
  return {
    index,
    userText: userText.length > 0 ? userText : undefined,
    toolCalls: 0,
    toolKinds: [],
    outcome: 'pending',
    unsettledCallIds: new Set(),
    settledCallIds: new Set(),
    interrupted: 0,
    assistantMessages: 0,
  };
}

/**
 * Pure, single-pass, O(n) derivation. Unknown kinds are ignored (tolerant
 * replay contract — retired vocabulary still replays as schema-mismatch
 * upstream and never reaches this function via readSessionLog).
 */
export function deriveHarnessState(events: readonly SessionEventEnvelope[]): HarnessState {
  const session: SessionLens = {
    sessionId: events[events.length - 1]?.sessionId ?? '',
    status: 'pending',
    lastSeq: 0,
  };
  const support: SupportLens = { contextProjections: [], memoryEvents: 0, compactions: 0 };
  let tokensSaved: number | undefined;
  const acc: TurnAcc[] = [];
  let current: TurnAcc | null = null;

  for (const e of events) {
    session.lastSeq = e.seq;
    switch (e.kind) {
      case 'session.started':
        // Pre-message scaffolding: anchors the session, never opens a turn.
        session.startedAt ??= e.ts;
        break;
      case 'session.ended': {
        session.endedAt = e.ts;
        const reason = asString(e.data.reason);
        session.status = reason.length > 0 ? reason : 'ended';
        if (current) {
          current.closedBy = 'session-ended';
          current.endReason = reason;
          current = null;
        }
        break;
      }
      case 'user.message': {
        if (current) current.closedBy = 'next-turn';
        current = newTurn(acc.length + 1, asString(e.data.text));
        acc.push(current);
        break;
      }
      case 'assistant.message': {
        if (!current) break;
        current.assistantMessages += 1;
        const text = asString(e.data.text);
        current.assistantChars = (current.assistantChars ?? 0) + text.length;
        current.assistantText = text; // LAST assistant text wins (reference, no concat)
        break;
      }
      case 'tool.call': {
        if (!current) break;
        current.toolCalls += 1;
        const tool = asString(e.data.tool);
        if (tool.length > 0 && !current.toolKinds.includes(tool)) current.toolKinds.push(tool);
        current.unsettledCallIds.add(asCallId(e.data.callId, e.seq));
        break;
      }
      case 'tool.result': {
        if (!current) break;
        current.settledCallIds.add(asCallId(e.data.callId, e.seq));
        break;
      }
      case 'tool.interrupted': {
        // A dangling call classified by recovery — its outcome is unknown,
        // so the turn's tools are NOT settled (unknown ≠ pass).
        if (current) current.interrupted += 1;
        break;
      }
      case 'verification.run': {
        // LAST verification.run in the turn is the turn's final verdict.
        if (!current) break;
        current.verification = {
          strict: e.data.strict === true,
          verdict: asString(e.data.verdict) || 'unknown',
        };
        break;
      }
      case 'session.compacted': {
        support.compactions += 1;
        const saved = asNumber(e.data.tokensSaved);
        if (saved !== undefined) tokensSaved = (tokensSaved ?? 0) + saved;
        break;
      }
      case 'note': {
        const subject = asString(e.data.subject);
        if (subject === 'context.projection') {
          support.contextProjections.push({
            contextChars: asNumber(e.data.contextChars) ?? 0,
            returnedCount: asNumber(e.data.returnedCount) ?? 0,
          });
        } else if (subject === 'memory_event') {
          support.memoryEvents += 1;
        }
        break;
      }
      default:
        // Unknown/irrelevant kinds are state-only for this read-model.
        break;
    }
  }

  const turns: TurnRecord[] = acc.map((t) => finalizeTurn(t));
  return {
    session,
    turns,
    execution: { turnsTotal: turns.length, contracts: acc.map((t) => contractFor(t)) },
    support: tokensSaved === undefined ? support : { ...support, tokensSavedByCompaction: tokensSaved },
  };
}

/** Lifecycle outcome of a closed/open turn (independent of the contract gate). */
function finalizeTurn(t: TurnAcc): TurnRecord {
  let outcome: TurnRecord['outcome'];
  if (t.closedBy === undefined) outcome = 'pending';
  // Closed by session.ended with a non-completed reason.
  else if (t.closedBy === 'session-ended' && t.endReason !== 'completed') outcome = 'error';
  // Closed by the next user.message or a completed end.
  else outcome = 'completed';
  return {
    index: t.index,
    userText: t.userText,
    assistantChars: t.assistantMessages > 0 ? (t.assistantChars ?? 0) : undefined,
    assistantText: t.assistantMessages > 0 ? t.assistantText : undefined,
    toolCalls: t.toolCalls,
    toolKinds: t.toolKinds,
    verification: t.verification,
    outcome,
  };
}

/**
 * Turn Completion Contract rules (ADR-0023: unknown ≠ pass):
 *  R1 userMessage — always true by construction (a turn exists only after a user.message).
 *  R2 assistantReply — at least one assistant.message in the turn; else blocker
 *     'assistant-reply-missing'.
 *  R3 toolsSettled — every tool.call got a tool.result and no tool.interrupted;
 *     else blocker 'tools-unsettled' (an unresulted call is unknown, never pass).
 *  R4 verification present but NOT strict → blocker 'verification-not-strict'
 *     (a non-strict snapshot is not admissible evidence).
 *  R5 verification strict with verdict ≠ 'PASS' → blocker `verification-verdict-<VERDICT>`
 *     (names the verdict, e.g. 'verification-verdict-BLOCKED').
 *  R6 verification absent → the turn must have closed cleanly (outcome 'completed');
 *     pending → 'turn-pending', error → `turn-error-<reason>`. Evidence-less turns
 *     are NOT complete-by-default.
 *  R7 verification strict with verdict 'PASS' → gate satisfied (evidence beats the
 *     lifecycle heuristic; the strict gate cannot mark an errored run PASS upstream).
 */
function contractFor(t: TurnAcc): TurnCompletionContract {
  const userMessage = true; // R1
  const assistantReply = t.assistantMessages > 0; // R2
  // R3 — callId-set comparison; a result without a usable callId cannot settle
  // a call (safe direction: stays unsettled rather than false-pass).
  const allSettled = [...t.unsettledCallIds].every((id) => t.settledCallIds.has(id));
  const toolsSettled = allSettled && t.interrupted === 0;

  const blockers: string[] = [];
  if (!assistantReply) blockers.push('assistant-reply-missing');
  if (!toolsSettled) blockers.push('tools-unsettled');
  if (t.verification) {
    if (!t.verification.strict) blockers.push('verification-not-strict');
    else if (t.verification.verdict !== 'PASS') blockers.push(`verification-verdict-${t.verification.verdict}`);
  } else if (t.closedBy === undefined) {
    blockers.push('turn-pending');
  } else if (t.closedBy === 'session-ended' && t.endReason !== 'completed') {
    blockers.push(`turn-error-${t.endReason}`);
  }

  return {
    turn: t.index,
    complete: userMessage && assistantReply && toolsSettled && blockers.length === 0,
    signals: {
      userMessage,
      assistantReply,
      toolsSettled,
      verification: t.verification,
    },
    blockers,
  };
}

/**
 * Convenience read-model loader for a session DIR (the `<id>/` folder under
 * `.zelari/sessions` containing `events.jsonl`). Tolerant like readSessionLog:
 * a missing log yields an empty pending state, never a throw.
 */
export async function readHarnessState(sessionDir: string): Promise<HarnessState> {
  const report = await readSessionLog(path.join(sessionDir, 'events.jsonl'));
  return deriveHarnessState(report.events);
}