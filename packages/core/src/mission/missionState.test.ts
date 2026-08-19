import { describe, expect, it } from 'vitest';
import { deriveMissionState, missionSnapshot } from './missionState.js';
import { buildProjection, type VerificationRunSummary } from '../session/replay.js';
import type { SessionEventEnvelope, SessionEventKind } from '../session/types.js';

function e(seq: number, kind: SessionEventKind, data: Record<string, unknown> = {}): SessionEventEnvelope {
  return { schemaVersion: 1, sessionId: 'm', seq, ts: seq, kind, actor: { type: 'system' }, data };
}

function withVerifications(
  events: SessionEventEnvelope[],
  runs: Array<{ complete?: boolean; results: VerificationRunSummary['results'] }>,
): SessionEventEnvelope[] {
  let seq = events.length;
  const out = [...events];
  for (const run of runs) {
    seq += 1;
    out.push(
      e(seq, 'verification.run', {
        results: run.results.map((r) => ({ ...r, evidence: Array.from({ length: r.evidenceCount }) })),
        complete: run.complete,
      }),
    );
  }
  return out;
}

describe('deriveMissionState', () => {
  it('empty/new session → design, not interrupted', () => {
    const state = deriveMissionState(buildProjection([]));
    expect(state.phase).toBe('design');
    expect(state.interrupted).toBe(false);
    expect(state.progress.ratio).toBeNull();
  });

  it('messages only → design; tool activity → build; interrupted without session.ended', () => {
    const design = deriveMissionState(buildProjection([e(1, 'session.started'), e(2, 'assistant.message', { text: 'plan' })]));
    expect(design.phase).toBe('design');
    expect(design.interrupted).toBe(true);

    const build = deriveMissionState(
      buildProjection([e(1, 'session.started'), e(2, 'tool.call', { callId: 'c', tool: 'edit_file' })]),
    );
    expect(build.phase).toBe('build');
  });

  it('verification.run without complete → verification phase with honest progress', () => {
    const events = withVerifications(
      [e(1, 'session.started'), e(2, 'tool.call', { tool: 'edit_file' })],
      [
        {
          results: [
            { criterionId: 'tests', status: 'pass', evidenceCount: 1 },
            { criterionId: 'typecheck', status: 'fail', evidenceCount: 1 },
          ],
        },
      ],
    );
    const state = deriveMissionState(buildProjection(events));
    expect(state.phase).toBe('verification');
    expect(state.progress).toEqual({
      criteriaTotal: 2,
      criteriaPassed: 1,
      ratio: 0.5,
      evidenceComplete: false,
    });
    expect(state.verifications).toBe(1);
  });

  it('complete:true verification with evidence on every pass → done', () => {
    const events = withVerifications(
      [e(1, 'session.started')],
      [
        {
          complete: true,
          results: [
            { criterionId: 'tests', status: 'pass', evidenceCount: 2 },
            { criterionId: 'build', status: 'pass', evidenceCount: 1 },
          ],
        },
      ],
    );
    const state = deriveMissionState(buildProjection(events));
    expect(state.phase).toBe('done');
    expect(state.progress.evidenceComplete).toBe(true);
  });

  it('explicit mission.phase wins over inference (except done)', () => {
    const events = [
      e(1, 'session.started'),
      e(2, 'tool.call', { tool: 'edit_file' }),
      e(3, 'mission.phase', { phase: 'design' }), // replan back to design
      e(4, 'mission.replan', { reason: 'scope changed' }),
    ];
    const state = deriveMissionState(buildProjection(events));
    expect(state.phase).toBe('design');
    expect(state.replans).toBe(1);
  });

  it('ended session is not interrupted; snapshot is JSON round-trippable', () => {
    const state = deriveMissionState(
      buildProjection([e(1, 'session.started'), e(2, 'session.ended', { reason: 'completed' })]),
    );
    expect(state.interrupted).toBe(false);
    const parsed = JSON.parse(missionSnapshot(state)) as typeof state & { format: string };
    expect(parsed.format).toBe('zelari-mission-snapshot');
    expect(parsed.phase).toBe(state.phase);
  });

  it('fork parent is surfaced for lineage-aware resume', () => {
    const state = deriveMissionState(
      buildProjection([e(1, 'session.started'), e(2, 'session.forked', { parentSessionId: 'parent-1', parentSeq: 9 })]),
    );
    expect(state.forkParent).toBe('parent-1');
  });
});
