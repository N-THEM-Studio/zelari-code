/**
 * src/cli/inboxSources.test.ts — WS2: `/inbox` as the notification bus.
 *
 * Red-if-reopens: the WS2 sources are DERIVED from events the spine already
 * records, never from new persistence:
 *   - `graph.node_ended` (ADR-0024 v1.1 host envelope) = a tentacle finished;
 *   - `verify.debt_open` without `verify.debt_cleared` = unverified work;
 *   - `permission.denied` (WS1/t133) = a blocked tool call.
 * The suite pins the two honesty rules that make the list trustworthy: a RETRY
 * supersedes the attempt you would otherwise read about, and a later
 * `user.message` (you are back at the keyboard) acknowledges everything before
 * it — while an absent `ok` is never read as success.
 *
 * The integration probe at the bottom walks the whole delivery path on a REAL
 * v1 spine on disk (parsed by the core reader): event → `/inbox` row → slash
 * command, plus the untouched t125 kill switch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deriveFinishedTentacles,
  deriveInboxSourceRows,
  deriveOpenNeeds,
  formatTentacleRow,
  lastOperatorReplySeq,
  type InboxSpineEvent,
} from './inboxSources.js';
import { formatInbox, renderInbox, scanInbox } from './inbox.js';
import { handleSlashCommand } from './slashCommands.js';

const BASE_TS = 1_755_000_000_000;

const ev = (seq: number, kind: string, data: Record<string, unknown> = {}): InboxSpineEvent => ({
  kind,
  seq,
  ts: BASE_TS + seq * 1000,
  data,
});

const reply = (seq: number, text = 'keep going'): InboxSpineEvent => ev(seq, 'user.message', { text });
const nodeStart = (seq: number, nodeId = 'n1', agent = 'general'): InboxSpineEvent =>
  ev(seq, 'graph.node_started', { nodeId, agent, graphId: 'g1' });
const nodeEnd = (seq: number, extra: Record<string, unknown> = {}): InboxSpineEvent =>
  ev(seq, 'graph.node_ended', { nodeId: 'n1', agent: 'general', graphId: 'g1', durationMs: 1500, ...extra });

describe('deriveFinishedTentacles — a finished tentacle, from the host envelope', () => {
  it('reports a completion you have not spoken past yet', () => {
    const rows = deriveFinishedTentacles([
      reply(1, 'ship ws2'),
      nodeStart(2),
      nodeEnd(3, { ok: true }),
    ]);
    expect(rows).toEqual([
      {
        source: 'tentacle-finished',
        nodeId: 'n1',
        agent: 'general',
        graphId: 'g1',
        ok: true,
        cancelled: false,
        durationMs: 1500,
        attempt: 1,
        seq: 3,
        ts: BASE_TS + 3000,
      },
    ]);
  });

  it('distinguishes failed and cancelled runs, and never reads an absent `ok` as success', () => {
    const failed = deriveFinishedTentacles([nodeStart(1), nodeEnd(2, { ok: false })])[0];
    const cancelled = deriveFinishedTentacles([nodeStart(1), nodeEnd(2, { ok: false, cancelled: true })])[0];
    const noClaim = deriveFinishedTentacles([nodeStart(1), nodeEnd(2, {})])[0];
    expect(failed).toMatchObject({ ok: false, cancelled: false });
    expect(cancelled).toMatchObject({ ok: false, cancelled: true });
    expect(noClaim.ok).toBe(false); // unknown ≠ pass
  });

  it('lets your next message acknowledge the completions before it', () => {
    expect(deriveFinishedTentacles([nodeStart(1), nodeEnd(2, { ok: true }), reply(3)])).toEqual([]);
    // …but only the ones BEFORE it: a later completion is still news.
    const later = deriveFinishedTentacles([
      nodeStart(1),
      nodeEnd(2, { ok: true }),
      reply(3),
      nodeStart(4), // retry after your reply
      nodeEnd(5, { ok: true }),
    ]);
    expect(later.map((r) => `${r.nodeId}#${r.attempt}`)).toEqual(['n1#2']);
  });

  it('drops a superseded attempt: a retry replaces what you were reading about', () => {
    const rows = deriveFinishedTentacles([
      nodeStart(1),
      nodeEnd(2, { ok: false }),
      nodeStart(3), // retry of the SAME node
      nodeEnd(4, { ok: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempt: 2, ok: true, seq: 4 });
  });

  it('skips an envelope with no nodeId (unattributable, never a claim)', () => {
    expect(deriveFinishedTentacles([ev(1, 'graph.node_ended', { ok: false })])).toEqual([]);
  });

  it('formats one line with the attempt suffix on a retry', () => {
    expect(formatTentacleRow(deriveFinishedTentacles([nodeStart(1), nodeEnd(2, { ok: true })])[0])).toBe(
      'tentacle finished: n1 (general) · 1.5s',
    );
    const retried = deriveFinishedTentacles([nodeStart(1), nodeEnd(2, { ok: false }), nodeStart(3), nodeEnd(4, { ok: false, cancelled: true })])[0];
    expect(formatTentacleRow(retried)).toContain('attempt 2');
    expect(formatTentacleRow(retried)).toContain('cancelled');
  });
});

describe('deriveOpenNeeds — unverified work and denied calls', () => {
  it('keeps an open verify debt and drops it when it is cleared', () => {
    const open = deriveOpenNeeds([
      ev(1, 'verify.debt_open', { taskId: 't1', description: 'add the bridge', timestamp: BASE_TS }),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ source: 'needs-input', need: 'unverified', taskId: 't1' });
    expect(open[0].text).toContain('finished without a passing verify');

    const cleared = deriveOpenNeeds([
      ev(1, 'verify.debt_open', { taskId: 't1', description: 'add the bridge' }),
      ev(2, 'verify.debt_cleared', { taskId: 't1' }),
    ]);
    expect(cleared).toEqual([]);
  });

  it('reports a denied tool call with its rule, and skips one with no tool', () => {
    const rows = deriveOpenNeeds([
      ev(1, 'permission.denied', { tool: 'bash', matchedRuleId: 'r1', source: 'session', reason: 'no rm -rf here' }),
      ev(2, 'permission.denied', { matchedRuleId: 'r2' }), // no tool: nothing to name
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ need: 'denied', tool: 'bash', matchedRuleId: 'r1' });
    expect(rows[0].text).toContain('denied by r1');
  });

  it('acknowledges both need kinds once you reply', () => {
    const rows = deriveOpenNeeds([
      ev(1, 'verify.debt_open', { taskId: 't1', description: 'x' }),
      ev(2, 'permission.denied', { tool: 'bash', matchedRuleId: 'r1' }),
      reply(3),
    ]);
    expect(rows).toEqual([]);
  });

  it('lastOperatorReplySeq ignores an empty user.message (a marker, not a reply)', () => {
    expect(lastOperatorReplySeq([reply(1), ev(2, 'user.message', { text: '   ' })])).toBe(1);
    expect(lastOperatorReplySeq([ev(1, 'note', { text: 'x' })])).toBeNull();
  });
});

describe('/inbox — event → row (integration probe on a real spine)', () => {
  let dir: string;
  let sessionsDir: string;
  let savedEnv: { sessionsDir?: string; inbox?: string };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zelari-ws2-'));
    sessionsDir = path.join(dir, '.zelari', 'sessions');
    savedEnv = { sessionsDir: process.env.ZELARI_SESSIONS_DIR, inbox: process.env.ZELARI_INBOX };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv.sessionsDir === undefined) delete process.env.ZELARI_SESSIONS_DIR;
    else process.env.ZELARI_SESSIONS_DIR = savedEnv.sessionsDir;
    if (savedEnv.inbox === undefined) delete process.env.ZELARI_INBOX;
    else process.env.ZELARI_INBOX = savedEnv.inbox;
  });

  /** REAL v1 envelopes (gap-free seq), parsed by the core reader. */
  function writeSpine(sessionId: string, lines: readonly string[]): void {
    const target = path.join(sessionsDir, sessionId);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf-8');
  }

  const envelope = (sessionId: string, seq: number, kind: string, data: Record<string, unknown>): string =>
    JSON.stringify({
      schemaVersion: 1,
      sessionId,
      seq,
      ts: BASE_TS + seq * 1000,
      kind,
      actor: { type: 'system' },
      data,
    });

  const WS2_LINES = (sessionId: string): string[] => [
    envelope(sessionId, 1, 'user.message', { text: 'ship ws2' }),
    envelope(sessionId, 2, 'graph.node_started', { nodeId: 'n1', agent: 'general', graphId: 'g1' }),
    envelope(sessionId, 3, 'graph.node_ended', { nodeId: 'n1', agent: 'general', ok: true, durationMs: 1500 }),
    envelope(sessionId, 4, 'verify.debt_open', { taskId: 't1', description: 'add the bridge', timestamp: BASE_TS }),
    envelope(sessionId, 5, 'permission.denied', { tool: 'bash', matchedRuleId: 'r1', source: 'session', reason: 'no' }),
    envelope(sessionId, 6, 'tool.call', { tool: 'ask_user', callId: 'c1', args: { question: 'cap at 20?' } }),
  ];

  it('lists all three sources from one spine, with the destination and the way back', () => {
    writeSpine('s-ws2', WS2_LINES('s-ws2'));
    const scan = scanInbox({ sessionsDir });
    expect(scan.entries).toHaveLength(1); // the t125 question
    // Most recent first: denial (seq 5), debt (4), tentacle completion (3).
    expect(scan.sourceRows.map((r) => r.source)).toEqual(['needs-input', 'needs-input', 'tentacle-finished']);
    const text = formatInbox(scan);
    expect(text).toContain('[inbox] 4 waiting on you (1 session(s) scanned): 1 question(s), 2 needs input, 1 tentacle(s) finished');
    expect(text).toContain('Q: cap at 20?');
    expect(text).toContain('tentacle finished: n1 (general) · 1.5s');
    expect(text).toContain('finished without a passing verify');
    expect(text).toContain('tool "bash" was denied by r1');
    expect(text).toContain('"ship ws2"');
    expect(text).toContain('→ /resume s-ws2');
  });

  it('the questions-only surface is byte-identical to t125 (no source rows ⇒ old header)', () => {
    writeSpine('s-q', [envelope('s-q', 1, 'tool.call', { tool: 'ask_user', callId: 'c1', args: { question: 'pending?' } })]);
    const text = formatInbox(scanInbox({ sessionsDir }));
    expect(text).toContain('[inbox] 1 question(s) waiting on you (1 session(s) scanned)');
    expect(text).not.toContain('waiting on you (1 session(s) scanned):');
  });

  it('a reply after the completions leaves only the unanswered question', () => {
    writeSpine('s-ws2', [...WS2_LINES('s-ws2'), envelope('s-ws2', 7, 'user.message', { text: 'back' })]);
    const text = formatInbox(scanInbox({ sessionsDir }));
    expect(text).toContain('[inbox] 1 question(s) waiting on you (1 session(s) scanned)');
    expect(text).not.toContain('tentacle finished');
    expect(text).not.toContain('denied by r1');
  });

  it('the t125 kill switch still answers "disabled" (and reads nothing)', () => {
    writeSpine('s-ws2', WS2_LINES('s-ws2'));
    const text = renderInbox({ env: { ZELARI_INBOX: '0' }, sessionsDir });
    expect(text).toContain('[inbox] disabled — ZELARI_INBOX=0');
    expect(text).not.toContain('tentacle finished');
  });

  it('the slash command prints the WS2 rows too', () => {
    process.env.ZELARI_SESSIONS_DIR = sessionsDir;
    writeSpine('s-ws2', WS2_LINES('s-ws2'));
    const result = handleSlashCommand('/inbox', []);
    expect(result).toMatchObject({ handled: true, kind: 'inbox' });
    expect(result.message).toContain('tentacle finished: n1');
    expect(result.message).toContain('needs input');
    expect(result.message).toContain('/resume s-ws2');
  });

  it('deriveInboxSourceRows is the sum of the two projections', () => {
    writeSpine('s-empty', [envelope('s-empty', 1, 'note', { text: 'nothing to do' })]);
    const scan = scanInbox({ sessionsDir });
    expect(scan.sourceRows).toEqual([]);
    expect(deriveInboxSourceRows([ev(1, 'note', {})])).toEqual([]);
  });
});
