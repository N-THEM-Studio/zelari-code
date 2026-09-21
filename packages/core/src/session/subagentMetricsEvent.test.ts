/**
 * t159 (P2a-2) — `subagent.metrics`: the additive spine event, pinned.
 *
 * Four properties the slice rests on:
 *   1. the kind is on the CLOSED spine vocabulary and OFF the model surface
 *      (P1: recording a measurement must not feed the model loop);
 *   2. the emission STOP RULE is ENCODED, not promised — the schema generation
 *      that declared the kind is pinned against SESSION_SCHEMA_VERSION, so a
 *      future bump fails here and needs a human decision, and an older
 *      generation writes nothing at all;
 *   3. honesty: absent stays absent (no fabricated zeros, no partial usage, no
 *      coerced junk) — a replay must never read a number this process invented;
 *   4. a REAL spine written by the REAL writer replays the event in log order,
 *      an unknown kind is still skipped with `schema-mismatch` while the rest of
 *      the spine replays (ADR-0016 tolerance), and a legacy spine WITHOUT the
 *      event replays exactly as it did (nothing REQUIRES it).
 */
import { describe, expect, it } from 'vitest';
import { appendFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLogWriter } from './writer.js';
import { buildProjection, readSessionLog } from './replay.js';
import { deriveMessages, MODEL_SURFACE_KINDS } from './modelSurface.js';
import { SESSION_EVENT_KINDS, SESSION_SCHEMA_VERSION, type SessionEventInput } from './types.js';
import {
  buildSubagentMetricsPayload,
  emitSubagentMetrics,
  readSubagentMetricsEvent,
  SUBAGENT_METRICS_ACTOR,
  SUBAGENT_METRICS_KIND,
  SUBAGENT_METRICS_SINCE_SCHEMA_VERSION,
  subagentMetricsKindSupported,
} from './subagentMetricsEvent.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-subagent-metrics-'));
}

const TS = 1755000000000;

async function writeSpine(
  dir: string,
  sessionId: string,
  events: SessionEventInput[],
): Promise<string> {
  let tick = 0;
  const writer = await SessionLogWriter.open(dir, sessionId, 1, { now: () => TS + (tick += 1) });
  try {
    for (const e of events) await writer.append(e);
  } finally {
    await writer.close();
  }
  return writer.path;
}

describe('subagent.metrics — vocabulary + stop rule (t159)', () => {
  it('is on the spine vocabulary, state-only, and the schema generation is PINNED', () => {
    expect(SESSION_EVENT_KINDS).toContain(SUBAGENT_METRICS_KIND);
    expect(MODEL_SURFACE_KINDS.has(SUBAGENT_METRICS_KIND)).toBe(false);
    // The stop rule itself: additive means NO bump. If this assertion fails,
    // the shared schema const moved — that is a schema review, not a fix.
    expect(SESSION_SCHEMA_VERSION).toBe(SUBAGENT_METRICS_SINCE_SCHEMA_VERSION);
  });

  it('a spine generation below the kind does not even reach the sink', async () => {
    const seen: SessionEventInput[] = [];
    const payload = buildSubagentMetricsPayload({ kind: 'explore', ok: true });
    const blocked = await emitSubagentMetrics(
      async (input) => {
        seen.push(input);
        return { seq: seen.length };
      },
      payload,
      { schemaVersion: SUBAGENT_METRICS_SINCE_SCHEMA_VERSION - 1 },
    );
    expect(blocked.recorded).toBe(false);
    expect(blocked.error).toContain(`v${SUBAGENT_METRICS_SINCE_SCHEMA_VERSION}`);
    expect(seen).toEqual([]);
    expect(subagentMetricsKindSupported(0)).toBe(false);
    expect(subagentMetricsKindSupported(SESSION_SCHEMA_VERSION)).toBe(true);
  });
});

describe('subagent.metrics — payload honesty (t159)', () => {
  it('never fabricates: absent usage/counters stay ABSENT keys', () => {
    const payload = buildSubagentMetricsPayload({ kind: 'general', ok: true, model: 'm-1' });
    expect(payload).toEqual({ kind: 'general', ok: true, model: 'm-1' });
    expect('usage' in payload).toBe(false);
    expect('turns' in payload).toBe(false);
    expect('toolCalls' in payload).toBe(false);
  });

  it('usage is all-or-nothing, and cached appears only when the provider cached >0', () => {
    const complete = buildSubagentMetricsPayload({
      kind: 'verify',
      ok: true,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 0 },
    });
    // totalTokens 0 is a MEASUREMENT (not absence): the triple survives intact.
    expect(complete.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 0 });
    const broken = buildSubagentMetricsPayload({
      kind: 'verify',
      ok: true,
      usage: { promptTokens: 10, completionTokens: Number.NaN, totalTokens: 4 },
    });
    expect('usage' in broken).toBe(false);
    const cachedZero = buildSubagentMetricsPayload({
      kind: 'verify',
      ok: true,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedPromptTokens: 0 },
    });
    expect(cachedZero.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    const cachedHit = buildSubagentMetricsPayload({
      kind: 'verify',
      ok: true,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedPromptTokens: 8 },
    });
    expect(cachedHit.usage?.cachedPromptTokens).toBe(8);
  });

  it('drops junk instead of coercing it, and only true is a degenerate/loop stop', () => {
    const payload = buildSubagentMetricsPayload({
      kind: 'explore',
      ok: false,
      model: '   ',
      turns: 2.5,
      toolCalls: -1,
      durationMs: Number.POSITIVE_INFINITY,
      degenerate: true,
    });
    expect(payload).toEqual({ kind: 'explore', ok: false, degenerate: true });
  });
});

describe('subagent.metrics — fail-open emission (t159)', () => {
  it('writes the event through the sink and echoes the writer seq', async () => {
    const seen: SessionEventInput[] = [];
    const payload = buildSubagentMetricsPayload({ kind: 'explore', ok: true, turns: 3 });
    const res = await emitSubagentMetrics(async (input) => {
      seen.push(input);
      return { seq: 42 };
    }, payload);
    expect(res).toEqual({ recorded: true, seq: 42 });
    expect(seen).toEqual([
      { kind: SUBAGENT_METRICS_KIND, actor: SUBAGENT_METRICS_ACTOR, data: payload },
    ]);
    expect(SUBAGENT_METRICS_ACTOR).toEqual({ type: 'system', role: 'metrics' });
  });

  it('a MISSING sink and a THROWING sink both record nothing and never throw', async () => {
    const payload = buildSubagentMetricsPayload({ kind: 'explore', ok: false });
    expect(await emitSubagentMetrics(undefined, payload)).toEqual({ recorded: false });
    const thrown = await emitSubagentMetrics(() => Promise.reject(new Error('SESSION_LOG_LOCKED')), payload);
    expect(thrown.recorded).toBe(false);
    expect(thrown.error).toContain('SESSION_LOG_LOCKED');
  });
});

describe('subagent.metrics — replay (t159)', () => {
  it('a real spine carries it, derives no model message, and projects cleanly', async () => {
    const dir = await tmpDir();
    const payload = buildSubagentMetricsPayload({
      kind: 'general',
      ok: false,
      thoroughness: 'deep',
      model: 'glm-5.3',
      agentId: 'a-1',
      turns: 7,
      toolCalls: 12,
      durationMs: 4321,
      degenerate: true,
      worktree: 'C:/tmp/wt-1',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    const file = await writeSpine(dir, 's-metrics', [
      { kind: 'session.started', actor: { type: 'system' }, data: {} },
      { kind: 'user.message', actor: { type: 'user' }, data: { text: 'go' } },
      { kind: SUBAGENT_METRICS_KIND, actor: SUBAGENT_METRICS_ACTOR, data: payload },
    ]);
    const report = await readSessionLog(file);
    expect(report.issues).toEqual([]);
    const metrics = report.events.filter((e) => e.kind === SUBAGENT_METRICS_KIND);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.seq).toBe(3);
    expect(metrics[0]!.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    // State-only: the model history is unchanged by the measurement.
    expect(deriveMessages(report.events).map((m) => m.content)).toEqual(['go']);
    const projection = buildProjection(report.events, report.issues);
    expect(projection.eventCount).toBe(3);
    expect(projection.decisionEvents).toEqual([]);
    expect(projection.verifyDebts).toEqual([]);
    expect(readSubagentMetricsEvent(metrics[0]!.data)).toMatchObject({
      kind: 'general',
      ok: false,
      turns: 7,
      toolCalls: 12,
      durationMs: 4321,
      degenerate: true,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
  });

  it('an UNKNOWN kind is still skipped as schema-mismatch, and the rest replays', async () => {
    const dir = await tmpDir();
    const file = await writeSpine(dir, 's-unknown', [
      { kind: 'session.started', actor: { type: 'system' }, data: {} },
      { kind: 'user.message', actor: { type: 'user' }, data: { text: 'hi' } },
    ]);
    // A future/foreign generation's line, exactly as a newer writer would emit it.
    appendFileSync(
      file,
      `${JSON.stringify({
        schemaVersion: SESSION_SCHEMA_VERSION,
        sessionId: 's-unknown',
        seq: 3,
        ts: TS + 9,
        kind: 'subagent.metrics.future',
        actor: { type: 'system' },
        data: { anything: true },
      })}\n`,
    );
    const report = await readSessionLog(file);
    expect(report.issues.map((i) => `${i.type}:${i.line}`)).toEqual(['schema-mismatch:3']);
    expect(report.events).toHaveLength(2);
    expect(deriveMessages(report.events).map((m) => m.content)).toEqual(['hi']);
  });

  it('a legacy spine WITHOUT the event is not required to carry one', async () => {
    const dir = await tmpDir();
    const file = await writeSpine(dir, 's-legacy', [
      { kind: 'session.started', actor: { type: 'system' }, data: {} },
      { kind: 'user.message', actor: { type: 'user' }, data: { text: 'legacy' } },
    ]);
    const report = await readSessionLog(file);
    expect(report.issues).toEqual([]);
    expect(report.events.some((e) => e.kind === SUBAGENT_METRICS_KIND)).toBe(false);
    expect(buildProjection(report.events, report.issues).eventCount).toBe(2);
  });

  it('reads a hand-edited payload defensively — junk yields what it carried, never a throw', () => {
    expect(readSubagentMetricsEvent(null)).toBeNull();
    expect(readSubagentMetricsEvent({ anything: true })).toEqual({
      kind: 'unknown',
      ok: false,
      degenerate: false,
    });
    expect(
      readSubagentMetricsEvent({ kind: 7, ok: 'yes', turns: 'many', usage: 'none' }),
    ).toEqual({ kind: 'unknown', ok: false, degenerate: false });
  });
});
