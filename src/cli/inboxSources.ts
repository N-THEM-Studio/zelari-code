/**
 * inboxSources — the WS2 sources of `/inbox`, derived from the spine.
 *
 * DERIVE-ONLY (ADR-0016/0024): these functions READ recorded events and never
 * write, cache or inject anything. The two sources added on top of the t125
 * `question` source (unanswered `ask_user`, see inbox.ts) are:
 *
 *  - `tentacle-finished` — the HOST-written envelope pair of a kraken-graph node
 *    (ADR-0024 v1.1: `graph.node_started` / `graph.node_ended`, written by
 *    `nodeSpineEnvelopeRun` in runHeadless.ts — `{nodeId, agent, graphId?}` then
 *    `{ok, cancelled?, durationMs}`). A tentacle that finished while you were
 *    away is news only until you come back to the keyboard, so a row is dropped
 *    as soon as the SAME session records a later `user.message`; a later
 *    `graph.node_started` for the same nodeId (a retry) drops the attempt you
 *    would otherwise be reading about.
 *
 *  - `needs-input` — the "the run cannot move without you" markers already on the
 *    spine:
 *      * `verify.debt_open` without a later `verify.debt_cleared` for the same
 *        `taskId` (K1.5/F5: a general tentacle finished without a passing verify
 *        — someone must run the verify or waive it);
 *      * `permission.denied` (WS1/t133: a pre-dispatch permission rule blocked a
 *        tool call — it needs an allow rule, or a steered alternative).
 *    Both close on the same reply boundary; the debt pair additionally closes on
 *    its `verify.debt_cleared`.
 *
 * HONESTY (ADR-0023: unknown ≠ pass): a `graph.node_ended` without a non-empty
 * `nodeId` is skipped — it could never be attributed to a tentacle — and
 * `permission.denied` without a tool is skipped too. An absent `ok` is NOT read
 * as success. Nothing is inferred from silence.
 */

/** Structural event view (a SessionEventEnvelope is assignable to it). */
export interface InboxSpineEvent {
  kind: string;
  seq: number;
  ts: number;
  data?: Record<string, unknown>;
}

/** The three things `/inbox` can be waiting on. */
export type InboxSource = 'question' | 'tentacle-finished' | 'needs-input';

/** One finished (or failed/cancelled) tentacle run, from its spine envelope. */
export interface InboxTentacleRow {
  source: 'tentacle-finished';
  nodeId: string;
  /** Agent that ran the node (`general` / `explore` / …), or `unknown`. */
  agent: string;
  graphId?: string;
  ok: boolean;
  cancelled: boolean;
  durationMs?: number;
  /** 1-based attempt of this nodeId within the session (2+ = a retry). */
  attempt: number;
  seq: number;
  ts: number;
}

/** One open need: unverified work, or a denied tool call. */
export interface InboxNeedRow {
  source: 'needs-input';
  need: 'unverified' | 'denied';
  /** Human, already-collapsed summary of the need. */
  text: string;
  /** `unverified`: the debt slot id. */
  taskId?: string;
  /** `denied`: the tool the rule blocked + the rule that did it. */
  tool?: string;
  matchedRuleId?: string;
  seq: number;
  ts: number;
}

export type InboxSourceRow = InboxTentacleRow | InboxNeedRow;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Collapse to one short line — inbox rows stay readable. */
function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * seq of the LAST operator reply (`user.message`) in the session, or null when
 * the operator has not spoken yet. This is the acknowledgement boundary of the
 * WS2 sources: anything recorded before your latest message belongs to the turn
 * you typed it in; anything after it arrived while you were away.
 */
export function lastOperatorReplySeq(events: readonly InboxSpineEvent[]): number | null {
  let last: number | null = null;
  for (const ev of events) {
    if (ev.kind !== 'user.message') continue;
    if (str(asRecord(ev.data)?.text).length === 0) continue; // a marker, not a reply
    if (typeof ev.seq === 'number') last = ev.seq;
  }
  return last;
}

/**
 * Tentacle completions of ONE session that you have not spoken past yet. Pure:
 * no I/O, no clock. Only the FINAL attempt of a nodeId is reported, and only
 * when it is newer than your last reply.
 */
export function deriveFinishedTentacles(events: readonly InboxSpineEvent[]): InboxTentacleRow[] {
  const acknowledgedSeq = lastOperatorReplySeq(events) ?? 0;
  const attempts = new Map<string, number>();
  const latest = new Map<string, InboxTentacleRow>();
  for (const ev of events) {
    const data = asRecord(ev.data);
    if (!data) continue;
    const nodeId = str(data.nodeId);
    if (nodeId.length === 0) continue; // unattributable: never claimed as a tentacle
    if (ev.kind === 'graph.node_started') {
      attempts.set(nodeId, (attempts.get(nodeId) ?? 0) + 1);
      latest.delete(nodeId); // the previous attempt is superseded, never reported
      continue;
    }
    if (ev.kind !== 'graph.node_ended') continue;
    const duration = data.durationMs;
    latest.set(nodeId, {
      source: 'tentacle-finished',
      nodeId,
      agent: str(data.agent) || 'unknown',
      ...(str(data.graphId) ? { graphId: str(data.graphId) } : {}),
      ok: data.ok === true, // absent `ok` is not a success claim
      cancelled: data.cancelled === true,
      ...(typeof duration === 'number' && Number.isFinite(duration) ? { durationMs: duration } : {}),
      attempt: attempts.get(nodeId) ?? 1,
      seq: ev.seq,
      ts: ev.ts,
    });
  }
  return [...latest.values()].filter((row) => row.seq > acknowledgedSeq);
}

/**
 * Open needs of ONE session: un-cleared verify debt + permission denials, both
 * filtered by the shared acknowledgement boundary. Pure: no I/O, no clock.
 */
export function deriveOpenNeeds(events: readonly InboxSpineEvent[]): InboxNeedRow[] {
  const acknowledgedSeq = lastOperatorReplySeq(events) ?? 0;
  const debts = new Map<string, { description: string; detail?: string; seq: number; ts: number }>();
  const denials: InboxNeedRow[] = [];
  for (const ev of events) {
    const data = asRecord(ev.data) ?? {};
    if (ev.kind === 'verify.debt_open') {
      const taskId = str(data.taskId);
      if (taskId.length === 0) continue;
      const detail = str(data.detail);
      debts.set(taskId, {
        description: str(data.description),
        ...(detail ? { detail } : {}),
        seq: ev.seq,
        ts: ev.ts,
      });
      continue;
    }
    if (ev.kind === 'verify.debt_cleared') {
      const taskId = str(data.taskId);
      if (taskId.length > 0) debts.delete(taskId);
      continue;
    }
    if (ev.kind !== 'permission.denied') continue;
    const tool = str(data.tool);
    if (tool.length === 0) continue; // nothing to name: not a claimable need
    const rule = str(data.matchedRuleId);
    const reason = str(data.reason);
    denials.push({
      source: 'needs-input',
      need: 'denied',
      text: `tool "${tool}" was denied by ${rule || 'a permission rule'}${reason ? ` (${oneLine(reason, 60)})` : ''} — allow it or steer another way`,
      tool,
      ...(rule ? { matchedRuleId: rule } : {}),
      seq: ev.seq,
      ts: ev.ts,
    });
  }
  const rows: InboxNeedRow[] = [];
  for (const [taskId, debt] of debts) {
    if (debt.seq <= acknowledgedSeq) continue; // you already replied after it
    rows.push({
      source: 'needs-input',
      need: 'unverified',
      text: `task general "${oneLine(debt.description, 60)}" finished without a passing verify (${oneLine(debt.detail ?? 'unverified work', 60)})`,
      taskId,
      seq: debt.seq,
      ts: debt.ts,
    });
  }
  rows.push(...denials.filter((d) => d.seq > acknowledgedSeq));
  return rows;
}

/** Every WS2 source row of ONE session (`question` rows live in inbox.ts). */
export function deriveInboxSourceRows(events: readonly InboxSpineEvent[]): InboxSourceRow[] {
  return [...deriveFinishedTentacles(events), ...deriveOpenNeeds(events)];
}

/** A tentacle row as ONE line, with the attempt suffix when it was a retry. */
export function formatTentacleRow(row: InboxTentacleRow): string {
  const what = row.cancelled ? 'tentacle cancelled' : row.ok ? 'tentacle finished' : 'tentacle FAILED';
  const attempt = row.attempt > 1 ? ` · attempt ${row.attempt}` : '';
  const took = typeof row.durationMs === 'number' ? ` · ${(row.durationMs / 1000).toFixed(1)}s` : '';
  return `${what}: ${row.nodeId} (${row.agent})${attempt}${took}`;
}
