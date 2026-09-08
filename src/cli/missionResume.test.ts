import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryBackend } from '@zelari/core';
import type { MissionBrief } from '@zelari/core/council';
import { buildMissionBrief } from '@zelari/core/council';
import {
  loadMissionState,
  resumeZelariMission,
  runZelariMission,
  type SliceRunResult,
  type ZelariMissionDeps,
} from './zelariMission.js';

function fakeMemory(): MemoryBackend {
  return {
    init: async () => {},
    search: async () => [],
    add: async () => {},
  } as unknown as MemoryBackend;
}

function briefWith(slices: MissionBrief['slices']): MissionBrief {
  return {
    intent: 'feature',
    runModeHint: 'implementation',
    stackInferred: [],
    deliverableThisMission: 'add the thing',
    assumptions: [],
    outOfScope: [],
    phases: [{ name: 'implementation', mode: 'implementation' }],
    sliceMvp: slices[0],
    slices,
    userPromptOriginal: 'add the thing',
  };
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-mission-'));
}

function deps(
  root: string,
  runSlice: ZelariMissionDeps['runSlice'],
  extra: Partial<ZelariMissionDeps> = {},
): ZelariMissionDeps {
  return {
    projectRoot: root,
    memory: fakeMemory(),
    runSlice,
    emit: () => {},
    env: { ZELARI_CHECKPOINT: '0' },
    ...extra,
  };
}

const green = async (): Promise<SliceRunResult> => ({
  completionOk: true,
  ran: true,
  writeCount: 1,
});
const red = async (): Promise<SliceRunResult> => ({
  completionOk: false,
  ran: true,
  writeCount: 1,
});

describe('buildMissionBrief — increment plan', () => {
  it('chunks plan tasks into gated increments', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);
    const brief = buildMissionBrief({
      userMessage: 'do work',
      planTaskIds: ids,
      maxSliceTasks: 8,
    });
    expect(brief.slices).toHaveLength(2);
    expect(brief.slices[0].id).toBe('slice-mvp');
    expect(brief.slices[0].taskIds).toEqual(ids.slice(0, 8));
    expect(brief.slices[1].id).toBe('slice-2');
    expect(brief.slices[1].taskIds).toEqual(ids.slice(8));
  });

  it('keeps a single MVP slice when no plan tasks are resolved', () => {
    const brief = buildMissionBrief({ userMessage: 'do work' });
    expect(brief.slices).toHaveLength(1);
    expect(brief.slices[0].id).toBe('slice-mvp');
  });
});

describe('mission increment gate', () => {
  it('advances to the next increment only after a green slice', async () => {
    const root = await tmpRoot();
    const slices = [
      { id: 'slice-mvp', title: 'MVP', maxTasks: 2 },
      { id: 'slice-2', title: 'Increment 2', maxTasks: 2 },
    ];
    let runs = 0;
    const state = await runZelariMission(
      'do work',
      briefWith(slices),
      deps(root, async () => {
        runs += 1;
        return green();
      }),
    );
    expect(runs).toBe(2);
    expect(state.status).toBe('success');
    expect(state.currentSliceId).toBe('slice-2');
    expect(state.trace?.map((t) => t.sliceId)).toEqual(['slice-mvp', 'slice-2']);
  });
});

describe('resumeZelariMission', () => {
  it('continues a stopped mission from the persisted state', async () => {
    const root = await tmpRoot();
    const stopped = await runZelariMission(
      'do work',
      briefWith([{ id: 'slice-mvp', title: 'MVP', maxTasks: 2 }]),
      deps(root, red, { maxIterations: 1 }),
    );
    expect(stopped.status).toBe('stopped');
    expect(stopped.iteration).toBeGreaterThanOrEqual(1);
    expect(await loadMissionState(root)).toMatchObject({ missionId: stopped.missionId });

    const resumed = await resumeZelariMission(deps(root, green));
    expect(resumed.status).toBe('success');
    expect(resumed.missionId).toBe(stopped.missionId);
    expect(resumed.iteration).toBeGreaterThanOrEqual(2);
  });

  it('refuses to resume when nothing is persisted', async () => {
    const root = await tmpRoot();
    await expect(resumeZelariMission(deps(root, green))).rejects.toThrow(/nessuna missione/);
    expect(await loadMissionState(root)).toBeUndefined();
  });
});
