/**
 * WS7 slice 2 (t140) — decision-event vocabulary + projection.
 *
 * Pins the three properties the slice rests on:
 *   1. the five new kinds are on the CLOSED spine vocabulary and OFF the model
 *      surface (P1: recording a decision must not feed the model loop);
 *   2. each kind has a payload contract that names its missing required field,
 *      while staying permissive about forward-compatible additions;
 *   3. a real spine written by the real writer replays them in log order, with
 *      seq/ts taken from the ENVELOPE — and a spine written BEFORE this slice
 *      (no new kinds at all) still parses byte-identically to what it did.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLogWriter } from './writer.js';
import { buildProjection, readSessionLog } from './replay.js';
import { MODEL_SURFACE_KINDS } from './modelSurface.js';
import { SESSION_EVENT_KINDS, type SessionEventInput } from './types.js';
import {
  DECISION_EVENT_KINDS,
  DECISION_PROJECTION_KINDS,
  decisionPayloadError,
  isDecisionProjectionKind,
  parseDecisionEvent,
  type DecisionEventKind,
} from './decisionEvents.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-decisions-'));
}

const TS = 1755000000000;

/** Write one spine through the REAL writer (single writer, seq assigned there). */
async function writeSpine(dir: string, sessionId: string, events: SessionEventInput[]): Promise<string> {
  let tick = 0;
  const writer = await SessionLogWriter.open(dir, sessionId, 1, { now: () => TS + (tick += 1) });
  try {
    for (const e of events) await writer.append(e);
  } finally {
    await writer.close();
  }
  return writer.path;
}

describe('decision vocabulary (WS7 slice 2)', () => {
  it('every decision kind is on the spine vocabulary and stays off the model surface', () => {
    for (const kind of DECISION_EVENT_KINDS) {
      expect(SESSION_EVENT_KINDS).toContain(kind);
      expect(MODEL_SURFACE_KINDS.has(kind)).toBe(false);
    }
    // The projection aggregate is exactly the five + the WS1 denial.
    expect([...DECISION_PROJECTION_KINDS]).toEqual([...DECISION_EVENT_KINDS, 'permission.denied']);
    expect(isDecisionProjectionKind('ask_user.fired')).toBe(true);
    expect(isDecisionProjectionKind('permission.denied')).toBe(true);
    expect(isDecisionProjectionKind('tool.call')).toBe(false);
  });

  it('payload contracts: a valid sample per kind, and the missing field is NAMED', () => {
    const valid: Record<DecisionEventKind, Record<string, unknown>> = {
      'permission.asked': {
        tool: 'write_file',
        categories: ['write'],
        effect: 'ask',
        matchedRuleId: 'no-secrets',
        source: 'project',
        reason: 'never touch secrets',
        argsSummary: '{"path":"secrets/key.pem"}',
      },
      'auto_approve.granted': { tool: 'read_file', categories: ['read'], source: 'default' },
      'jail.blocked': {
        tool: 'bash',
        backend: 'win32-restricted-token',
        mode: 'required',
        reason: 'backend unavailable on this platform',
      },
      'ask_user.fired': { question: 'cap at 20?', callId: 'c9', choices: ['20', '50'] },
      'verify.requested': { taskId: 't1', criterionIds: ['tests', 'lint'], source: 'strict-done' },
    };
    for (const kind of DECISION_EVENT_KINDS) {
      expect(decisionPayloadError(kind, valid[kind]), kind).toBeNull();
      // Forward-compat: an extra key is NOT a contract violation (open record).
      expect(decisionPayloadError(kind, { ...valid[kind], futureField: 1 }), kind).toBeNull();
    }
    expect(decisionPayloadError('permission.asked', { reason: 'no tool here' })).toContain('tool');
    expect(decisionPayloadError('jail.blocked', { backend: 'bwrap', reason: 'x' })).toContain('mode');
    expect(decisionPayloadError('jail.blocked', { backend: 'bwrap', mode: 'maybe', reason: 'x' })).toContain(
      'mode',
    );
    expect(decisionPayloadError('ask_user.fired', { callId: 'c1' })).toContain('question');
    expect(decisionPayloadError('verify.requested', { taskId: '' })).toContain('taskId');
  });

  it('flattens one event defensively — an empty payload still yields the kind', () => {
    const summary = parseDecisionEvent({
      schemaVersion: 1,
      sessionId: 's',
      seq: 7,
      ts: TS,
      kind: 'jail.blocked',
      actor: { type: 'system' },
      data: {},
    });
    expect(summary).toEqual({
      seq: 7,
      at: TS,
      kind: 'jail.blocked',
      tool: '',
      source: '',
      reason: '',
      detail: 'jail ?: ',
    });
  });
});

describe('decision projection over a real spine', () => {
  it('replays every kind in log order, with envelope seq/ts, off the model surface', async () => {
    const dir = await tmpDir();
    const events: SessionEventInput[] = [
      { kind: 'session.started', actor: { type: 'system' } },
      { kind: 'user.message', actor: { type: 'user' }, data: { text: 'do the thing' } },
      {
        kind: 'permission.asked',
        actor: { type: 'system', role: 'permissions' },
        data: { tool: 'write_file', categories: ['write'], effect: 'ask', matchedRuleId: 'no-secrets', source: 'project', reason: 'never touch secrets' },
      },
      {
        kind: 'auto_approve.granted',
        actor: { type: 'system', role: 'permissions' },
        data: { tool: 'read_file', source: 'default', categories: ['read'] },
      },
      {
        kind: 'jail.blocked',
        actor: { type: 'system', role: 'jail' },
        data: { tool: 'bash', backend: 'win32-restricted-token', mode: 'required', reason: 'no backend' },
      },
      {
        kind: 'ask_user.fired',
        actor: { type: 'agent' },
        data: { question: 'cap\nat 20?', callId: 'c9', choices: ['20', '50'] },
      },
      {
        kind: 'verify.requested',
        actor: { type: 'system', role: 'strict-done' },
        data: { taskId: 't1', criterionIds: ['tests'] },
      },
      { kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c1', tool: 'bash', args: {} } },
      { kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c1', tool: 'bash', ok: true } },
      { kind: 'session.ended', actor: { type: 'system' }, data: { reason: 'completed' } },
    ];
    const file = await writeSpine(dir, 'decisions-a', events);
    const report = await readSessionLog(file);
    expect(report.issues).toEqual([]);
    const projection = buildProjection(report.events, report.issues);

    expect(projection.decisionEvents.map((d) => d.kind)).toEqual([
      'permission.asked',
      'auto_approve.granted',
      'jail.blocked',
      'ask_user.fired',
      'verify.requested',
    ]);
    const asked = projection.decisionEvents[0];
    expect(asked).toMatchObject({
      seq: 3,
      kind: 'permission.asked',
      tool: 'write_file',
      source: 'project',
      reason: 'never touch secrets',
    });
    expect(asked?.at).toBe(report.events[2]?.ts); // envelope ts, not a payload field
    expect(projection.decisionEvents[1]).toMatchObject({
      tool: 'read_file',
      source: 'default',
      detail: 'auto-approved (default)',
    });
    expect(projection.decisionEvents[2]?.detail).toBe('win32-restricted-token required: no backend');
    // A multi-line question is collapsed so one event cannot break the report.
    expect(projection.decisionEvents[3]?.detail).toBe('cap at 20?  [choices: 20, 50]');
    expect(projection.decisionEvents[4]?.detail).toBe('criteria: tests');

    // P1: none of it reached the model surface (deriveMessages fed messages).
    const surface = JSON.stringify(projection.messages);
    expect(surface).not.toContain('never touch secrets');
    expect(surface).not.toContain('cap at 20?');
    expect(surface).not.toContain('auto-approved');
  });

  it('retro-compat: a spine with none of the new kinds parses exactly as before', async () => {
    const dir = await tmpDir();
    const events: SessionEventInput[] = [
      { kind: 'session.started', actor: { type: 'system' } },
      { kind: 'user.message', actor: { type: 'user' }, data: { text: 'old spine' } },
      { kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c1', tool: 'read_file', args: { path: 'a.ts' } } },
      { kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c1', tool: 'read_file', ok: true, output: 'x' } },
      { kind: 'verify.debt_open', actor: { type: 'system' }, data: { taskId: 't1', description: 'add the bridge' } },
      { kind: 'permission.denied', actor: { type: 'system', role: 'permissions' }, data: { tool: 'bash', matchedRuleId: 'r1', source: 'session', reason: 'no' } },
      { kind: 'session.ended', actor: { type: 'system' }, data: { reason: 'completed' } },
    ];
    const file = await writeSpine(dir, 'pre-slice2', events);
    const report = await readSessionLog(file);
    // No schema-mismatch: the pre-slice-2 vocabulary is untouched.
    expect(report.issues).toEqual([]);
    const projection = buildProjection(report.events, report.issues);
    expect(projection.eventCount).toBe(7);
    expect(projection.toolCalls).toBe(1);
    expect(projection.toolResults).toBe(1);
    expect(projection.permissionDenials).toHaveLength(1);
    // …and only the WS1 denial joins the aggregate when no new kinds are present.
    expect(projection.decisionEvents.map((d) => d.kind)).toEqual(['permission.denied']);
    expect(projection.verifyDebts.map((d) => [d.taskId, d.clearedSeq])).toEqual([['t1', undefined]]);
  });

  it('an unknown (retired/newer) kind is still a tolerated schema-mismatch, not a throw', async () => {
    const dir = await tmpDir();
    const file = await writeSpine(dir, 'unknown-kind', [
      { kind: 'session.started', actor: { type: 'system' } },
      { kind: 'note', actor: { type: 'system' }, data: { subject: 'ok' } },
    ]);
    // Hand-append a line whose kind this build does not know.
    const line = JSON.stringify({
      schemaVersion: 1,
      sessionId: 'unknown-kind',
      seq: 3,
      ts: TS + 3,
      kind: 'decision.future_kind',
      actor: { type: 'system' },
      data: {},
    });
    await fs.appendFile(file, `${line}\n`, 'utf-8');
    const report = await readSessionLog(file);
    expect(report.events).toHaveLength(2);
    expect(report.issues.map((i) => i.type)).toEqual(['schema-mismatch']);
    expect(buildProjection(report.events, report.issues).decisionEvents).toEqual([]);
  });
});
