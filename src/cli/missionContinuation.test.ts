/**
 * F4 integration — the mission loop records advisory continuation without
 * obeying it: advice on every implementation slice, deterministic stop rules
 * untouched, spine round-trip of mission.progress state events.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runZelariMission,
  type SliceRunResult,
  type ZelariMissionDeps,
} from './zelariMission.js';
import type { MissionBrief } from '@zelari/core/council';
import type { MemoryBackend } from '@zelari/core';
import {
  SessionStore,
  readSessionLog,
  buildProjection,
} from '@zelari/core/session';
import { deriveMissionState } from '@zelari/core/mission';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';

const brief: MissionBrief = {
  goal: 'vertical slice',
  deliverableThisMission: 'one module',
  phases: [{ mode: 'implementation', focus: 'impl' }],
  sliceMvp: { id: 'slice-1', summary: 'mvp', acceptance: [] },
} as unknown as MissionBrief;

function fakeMemory(): MemoryBackend {
  return {
    init: vi.fn(async () => {}),
    add: vi.fn(async () => {}),
    search: vi.fn(async () => []),
  } as unknown as MemoryBackend;
}

function deps(overrides: Partial<ZelariMissionDeps> = {}): ZelariMissionDeps {
  return {
    projectRoot: os.tmpdir(),
    memory: fakeMemory(),
    runSlice: vi.fn(async (): Promise<SliceRunResult> => ({ completionOk: true, ran: true, writeCount: 2 })),
    emit: vi.fn(),
    env: { ZELARI_CHECKPOINT: '0', ZELARI_MISSION_MAX_ITER: '3' },
    ...overrides,
  };
}

describe('runZelariMission — advisory continuation (F4)', () => {
  it('records advice on each implementation slice but never obeys it for done-by-score', async () => {
    const onMissionProgress = vi.fn();
    // Slice 1: claims completion but wrote 0 files → NOT done.
    // Slice 2: real green → done. The loop must follow its own deterministic
    // rules; the advice is only recorded.
    const results: SliceRunResult[] = [
      { completionOk: true, ran: true, writeCount: 0 },
      { completionOk: true, ran: true, writeCount: 3 },
    ];
    let i = 0;
    const d = deps({
      runSlice: vi.fn(async () => results[i++]),
      onMissionProgress,
    });
    const state = await runZelariMission('do it', brief, d);
    expect(state.status).toBe('success');
    expect(state.iteration).toBeGreaterThanOrEqual(2);
    expect(onMissionProgress).toHaveBeenCalled();
    const first = onMissionProgress.mock.calls[0][0] as {
      recommendation: string;
      doneByScore: boolean;
      goalRewrite: false;
    };
    expect(first.doneByScore).toBe(false);
    expect(first.goalRewrite).toBe(false);
    expect(['continue', 'wind-down', 'hold-for-user']).toContain(first.recommendation);
  });

  it('emits a wind-down advice only when the deterministic gate is green', async () => {
    const seen: string[] = [];
    const d = deps({
      runSlice: vi.fn(
        async (): Promise<SliceRunResult> => ({ completionOk: true, ran: true, writeCount: 1 }),
      ),
      onMissionProgress: (advice) => seen.push(advice.recommendation),
    });
    const state = await runZelariMission('go', brief, d);
    expect(state.status).toBe('success');
    expect(seen[seen.length - 1]).toBe('wind-down');
  });

  it('budget-exhausted run holds for the user instead of claiming done', async () => {
    const onMissionProgress = vi.fn();
    const d = deps({
      runSlice: vi.fn(
        async (): Promise<SliceRunResult> => ({ completionOk: false, ran: true, writeCount: 1 }),
      ),
      onMissionProgress,
    });
    const state = await runZelariMission('go', brief, d);
    expect(state.status).toBe('stopped');
    const last = onMissionProgress.mock.calls.at(-1)![0] as { recommendation: string };
    expect(['hold-for-user', 'continue']).toContain(last.recommendation);
  });
});

describe('mission.progress spine round-trip', () => {
  it('advice events replay as state (lastAdvice) and never join the model surface', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'f4-'));
    const store = new SessionStore(tmp);
    const { sessionId, writer } = await store.create({ profile: 'mission/v1' });
    await writer.append({
      kind: 'mission.phase',
      actor: { type: 'system' },
      data: { phase: 'build' },
    });
    await writer.append({
      kind: 'mission.progress',
      actor: { type: 'system' },
      data: {
        recommendation: 'continue',
        rationale: 'required criteria incomplete → no early-stop',
        blockers: ['1/1 required criteria not passing'],
        iteration: 2,
      },
    });
    await writer.close();

    const report = await readSessionLog(path.join(tmp, sessionId, 'events.jsonl'));
    const events = report.events;
    const projection = buildProjection(events, report.issues);
    expect(projection.missionAdvice).toHaveLength(1);
    expect(projection.missionAdvice[0].recommendation).toBe('continue');

    const state = deriveMissionState(projection);
    expect(state.phase).toBe('build');
    expect(state.lastAdvice?.rationale).toContain('no early-stop');

    const { isModelSurfaceEvent } = await import('@zelari/core/session');
    const adviceEvent = events.find((e) => e.kind === 'mission.progress');
    expect(adviceEvent).toBeDefined();
    expect(isModelSurfaceEvent(adviceEvent!)).toBe(false);
  });
});
