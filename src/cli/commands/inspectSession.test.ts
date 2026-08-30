/**
 * inspectSession.test.ts — `zelari-code inspect <session-id>` (v0.10).
 *
 * Unit side: renderInspectReport pinned on a HAND-BUILT HarnessState (real
 * types from harnessState.ts) — header, per-turn verdict + blocker count,
 * support-lens counts.
 * Runner side: runInspectSession against a REAL events.jsonl fixture in a
 * temp sessions dir (ZELARI_SESSIONS_DIR override) — found (human + --json)
 * and not-found (clear stderr path, exit 1, no stack trace).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionActor, SessionEventEnvelope } from '@zelari/core/session';
import { renderInspectReport, runInspectSession } from './inspectSession.js';
import type { HarnessState } from '../harnessState.js';

// ---------------------------------------------------------------------------
// Hand-built fixture — exactly the shapes harnessState.ts derives.
// ---------------------------------------------------------------------------
const FIXTURE: HarnessState = {
  session: { sessionId: 'sess-fixture', status: 'completed', startedAt: 1, endedAt: 9, lastSeq: 12 },
  turns: [
    {
      index: 1,
      userText: 'fix the bug',
      assistantChars: 120,
      assistantText: 'done',
      toolCalls: 2,
      toolKinds: ['read_file', 'apply_diff'],
      verification: { strict: true, verdict: 'PASS' },
      outcome: 'completed',
    },
    {
      index: 2,
      toolCalls: 1,
      toolKinds: ['apply_diff'],
      verification: { strict: true, verdict: 'BLOCKED' },
      outcome: 'completed',
    },
    {
      index: 3,
      toolCalls: 0,
      toolKinds: [],
      outcome: 'pending',
    },
  ],
  execution: {
    turnsTotal: 3,
    contracts: [
      {
        turn: 1,
        complete: true,
        signals: { userMessage: true, assistantReply: true, toolsSettled: true, verification: { strict: true, verdict: 'PASS' } },
        blockers: [],
      },
      {
        turn: 2,
        complete: false,
        signals: { userMessage: true, assistantReply: true, toolsSettled: false, verification: { strict: true, verdict: 'BLOCKED' } },
        blockers: ['tools-unsettled', 'verification-verdict-BLOCKED'],
      },
      {
        turn: 3,
        complete: false,
        signals: { userMessage: true, assistantReply: false, toolsSettled: true },
        blockers: ['assistant-reply-missing', 'turn-pending'],
      },
    ],
  },
  support: {
    contextProjections: [
      { contextChars: 1024, returnedCount: 3 },
      { contextChars: 4096, returnedCount: 7 },
    ],
    memoryEvents: 5,
    compactions: 1,
    tokensSavedByCompaction: 4200,
  },
};

describe('renderInspectReport — pure renderer', () => {
  it('header carries session id and turnsTotal', () => {
    const out = renderInspectReport(FIXTURE);
    expect(out).toContain('session sess-fixture');
    expect(out).toContain('status=completed');
    expect(out).toContain('turns=3');
  });

  it('per-turn verdict + completion contract with blocker count', () => {
    const out = renderInspectReport(FIXTURE);
    expect(out).toContain('turn 1  [completed]  verification: PASS  contract: complete');
    // "3 unknown checks" analog: the named contract blockers, counted.
    expect(out).toContain('2 blockers: tools-unsettled, verification-verdict-BLOCKED');
    // ADR-0023: evidence-less turn ⇒ unknown verdict, never pass.
    expect(out).toContain('turn 3  [pending]  verification: unknown');
    expect(out).toContain('assistant-reply-missing');
  });

  it('support lens: contextProjections (last chars/items), memoryEvents, compactions', () => {
    const out = renderInspectReport(FIXTURE);
    expect(out).toContain('support lens:');
    expect(out).toContain('context projections: 2  (last: 4096 chars → 7 items)');
    expect(out).toContain('memory events: 5');
    expect(out).toContain('compactions: 1 (4200 tokens saved)');
  });

  it('empty support lens degrades to zero counts, no "(last: …)" tail', () => {
    const out = renderInspectReport({
      ...FIXTURE,
      support: { contextProjections: [], memoryEvents: 0, compactions: 0 },
    });
    expect(out).toContain('context projections: 0\n');
    expect(out).not.toContain('(last:');
    expect(out).toContain('memory events: 0');
    expect(out).toContain('compactions: 0');
  });
});

// ---------------------------------------------------------------------------
// Runner — real events.jsonl fixture in a temp sessions dir.
// ---------------------------------------------------------------------------
let seq = 0;
function ev(
  kind: SessionEventEnvelope['kind'],
  data: Record<string, unknown> = {},
  actor: SessionActor = { type: 'system' },
): SessionEventEnvelope {
  seq += 1;
  return { schemaVersion: 1, sessionId: 'sess-live', seq, ts: 1755000000000 + seq, kind, actor, data };
}

/** Two-turn session: PASS turn, BLOCKED turn (interrupted tool), support noise. */
function liveEvents(): SessionEventEnvelope[] {
  seq = 0;
  return [
    ev('session.started'),
    ev('user.message', { text: 'fix the bug' }),
    ev('assistant.message', { text: 'on it' }),
    ev('tool.call', { tool: 'read_file', callId: 'c1' }),
    ev('tool.result', { callId: 'c1' }),
    ev('verification.run', { strict: true, verdict: 'PASS' }),
    ev('note', { subject: 'context.projection', contextChars: 1024, returnedCount: 3 }),
    ev('note', { subject: 'memory_event' }),
    ev('user.message', { text: 'again' }),
    ev('assistant.message', { text: 'retrying' }),
    ev('tool.call', { tool: 'apply_diff', callId: 'c2' }),
    ev('tool.interrupted'),
    ev('verification.run', { strict: true, verdict: 'BLOCKED' }),
    ev('session.compacted', { tokensSaved: 4200 }),
    ev('note', { subject: 'context.projection', contextChars: 4096, returnedCount: 7 }),
    ev('session.ended', { reason: 'completed' }),
  ];
}

describe('runInspectSession — sessions dir resolution (ADR-0016)', () => {
  let sessionsDir: string;
  let prevEnv: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-inspect-'));
    prevEnv = process.env.ZELARI_SESSIONS_DIR;
    process.env.ZELARI_SESSIONS_DIR = sessionsDir;
    const sessionDir = path.join(sessionsDir, 'sess-live');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'events.jsonl'),
      liveEvents().map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ZELARI_SESSIONS_DIR;
    else process.env.ZELARI_SESSIONS_DIR = prevEnv;
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('found session → exit 0, human report from the real derivation', async () => {
    const code = await runInspectSession({ sessionId: 'sess-live', cwd: sessionsDir });
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = logSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain('session sess-live  status=completed  turns=2');
    expect(out).toContain('turn 1  [completed]  verification: PASS  contract: complete');
    expect(out).toContain('2 blockers: tools-unsettled, verification-verdict-BLOCKED');
    expect(out).toContain('context projections: 2  (last: 4096 chars → 7 items)');
    expect(out).toContain('memory events: 1');
    expect(out).toContain('compactions: 1 (4200 tokens saved)');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('--json → exit 0, parseable HarnessState (the harness_state payload)', async () => {
    const code = await runInspectSession({ sessionId: 'sess-live', json: true, cwd: sessionsDir });
    expect(code).toBe(0);
    const state = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as HarnessState;
    expect(state.session.sessionId).toBe('sess-live');
    expect(state.session.status).toBe('completed');
    expect(state.execution.turnsTotal).toBe(2);
    expect(state.support.contextProjections).toEqual([
      { contextChars: 1024, returnedCount: 3 },
      { contextChars: 4096, returnedCount: 7 },
    ]);
    expect(state.support.compactions).toBe(1);
  });

  it('unknown session id → exit 1, clear stderr with the guarded path, no stack', async () => {
    const code = await runInspectSession({ sessionId: 'nope', cwd: sessionsDir });
    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = errSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('no session directory at');
    expect(msg).toContain(path.join(sessionsDir, 'nope'));
    expect(msg.split('\n').length).toBe(1); // single line — no stack trace
  });
});
