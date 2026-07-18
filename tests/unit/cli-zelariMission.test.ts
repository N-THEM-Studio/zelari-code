import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildMissionBrief } from '@zelari/core/council';
import { FileMemoryBackend } from '../../src/cli/memory/fileBackend.js';
import {
  runZelariMission,
  resolveMaxIterations,
  resolveMaxStall,
  isMissionAutoStart,
  formatBriefForChat,
  type RunSliceArgs,
  type SliceRunResult,
} from '../../src/cli/zelariMission.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-mission-'));
  dirs.push(d);
  return d;
}

async function readState(root: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(root, '.zelari', 'mission-state.json'), 'utf8');
  return JSON.parse(raw);
}

describe('runZelariMission', () => {
  it('succeeds when an implementation slice completes', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'correggi il bug di sessione', hasPlan: true });
    const runModes: string[] = [];
    const emits: string[] = [];

    const state = await runZelariMission('correggi il bug di sessione', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: (m) => emits.push(m),
      runSlice: async (a: RunSliceArgs): Promise<SliceRunResult> => {
        runModes.push(a.runMode);
        return { completionOk: true, ran: true, synthesisText: 'fixed' };
      },
    });

    expect(state.status).toBe('success');
    expect(state.iteration).toBe(1);
    expect(runModes).toEqual(['implementation']);
    expect((await readState(root)).status).toBe('success');
    expect(emits.some((m) => m.includes('completata'))).toBe(true);
  });

  it('greenfield chains design-phase then implementation', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'costruisci una vetrina e-commerce' });
    expect(brief.phases.map((p) => p.mode)).toEqual(['design-phase', 'implementation']);

    const runModes: string[] = [];
    const state = await runZelariMission('costruisci una vetrina e-commerce', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: () => {},
      runSlice: async (a: RunSliceArgs): Promise<SliceRunResult> => {
        runModes.push(a.runMode);
        // completion reported true on both, but only the impl run may end the mission
        return { completionOk: true, ran: true };
      },
    });

    expect(runModes).toEqual(['design-phase', 'implementation']);
    expect(state.status).toBe('success');
    expect(state.iteration).toBe(2);
  });

  it('marks implementerRetry on implementation 2+ (not first impl or design)', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'costruisci una vetrina e-commerce' });
    const flags: Array<{ mode: string; retry?: boolean; implIdx?: number }> = [];

    await runZelariMission('costruisci una vetrina e-commerce', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: () => {},
      maxIterations: 3,
      runSlice: async (a: RunSliceArgs): Promise<SliceRunResult> => {
        flags.push({
          mode: a.runMode,
          retry: a.implementerRetry,
          implIdx: a.implementationIndex,
        });
        return { completionOk: false, ran: true };
      },
    });

    // design free + 3 impl attempts
    expect(flags).toEqual([
      { mode: 'design-phase', retry: false, implIdx: undefined },
      { mode: 'implementation', retry: false, implIdx: 1 },
      { mode: 'implementation', retry: true, implIdx: 2 },
      { mode: 'implementation', retry: true, implIdx: 3 },
    ]);
  });

  it('design-phase does not consume the implementation budget', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'costruisci una vetrina e-commerce' });
    const runModes: string[] = [];
    const emits: string[] = [];

    const state = await runZelariMission('costruisci una vetrina e-commerce', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: (m) => emits.push(m),
      maxIterations: 2,
      runSlice: async (a: RunSliceArgs): Promise<SliceRunResult> => {
        runModes.push(a.runMode);
        // Never green — force budget exhaust on implementation only.
        return { completionOk: false, ran: true };
      },
    });

    // 1 free design + 2 implementation = 3 slice calls; budget is impl-only.
    expect(runModes).toEqual(['design-phase', 'implementation', 'implementation']);
    expect(state.status).toBe('stopped');
    expect(state.iteration).toBe(3);
    expect(emits.some((m) => m.includes('design-phase') && m.includes('fuori budget'))).toBe(
      true,
    );
    expect(emits.some((m) => m.includes('2 implementazioni') && m.includes('design-phase'))).toBe(
      true,
    );
  });

  it('stops after the iteration budget without a green completion', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'correggi qualcosa', hasPlan: true });
    const emits: string[] = [];

    const state = await runZelariMission('correggi qualcosa', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: (m) => emits.push(m),
      maxIterations: 3,
      runSlice: async (): Promise<SliceRunResult> => ({ completionOk: false, ran: true }),
    });

    expect(state.status).toBe('stopped');
    expect(state.iteration).toBe(3);
    expect(emits.some((m) => m.includes('fermata'))).toBe(true);
  });

  it('stalls early after consecutive implementation slices write no files', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'implementa il login', hasPlan: true });
    const emits: string[] = [];
    let calls = 0;

    const state = await runZelariMission('implementa il login', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: (m) => emits.push(m),
      maxIterations: 10,
      env: { ZELARI_MISSION_MAX_STALL: '2' } as NodeJS.ProcessEnv,
      runSlice: async (): Promise<SliceRunResult> => {
        calls++;
        return { completionOk: false, ran: true, writeCount: 0, degraded: true };
      },
    });

    expect(state.status).toBe('stalled');
    // Bails at the stall threshold, well before the iteration budget.
    expect(calls).toBe(2);
    expect(state.iteration).toBe(2);
    expect(emits.some((m) => m.includes('senza') && m.includes('file'))).toBe(true);
    expect((await readState(root)).status).toBe('stalled');
  });

  it('a real write resets the no-write streak', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'implementa il login', hasPlan: true });
    const writeCounts = [0, 3, 0, 0];
    let idx = 0;

    const state = await runZelariMission('implementa il login', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: () => {},
      maxIterations: 10,
      env: { ZELARI_MISSION_MAX_STALL: '2' } as NodeJS.ProcessEnv,
      runSlice: async (): Promise<SliceRunResult> => ({
        completionOk: false,
        ran: true,
        writeCount: writeCounts[idx++] ?? 0,
      }),
    });

    // 0 (streak 1) → 3 (reset) → 0 (streak 1) → 0 (streak 2 → stall).
    expect(state.status).toBe('stalled');
    expect(state.iteration).toBe(4);
  });

  it('does not stall when the driver does not report writeCount', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'implementa', hasPlan: true });
    const state = await runZelariMission('implementa', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: () => {},
      maxIterations: 3,
      env: { ZELARI_MISSION_MAX_STALL: '2' } as NodeJS.ProcessEnv,
      // Legacy driver shape: no writeCount → stall detection stays off.
      runSlice: async (): Promise<SliceRunResult> => ({ completionOk: false, ran: true }),
    });
    expect(state.status).toBe('stopped');
    expect(state.iteration).toBe(3);
  });

  it('ZELARI_MISSION_MAX_STALL=0 disables stall detection', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'implementa', hasPlan: true });
    const state = await runZelariMission('implementa', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: () => {},
      maxIterations: 3,
      env: { ZELARI_MISSION_MAX_STALL: '0' } as NodeJS.ProcessEnv,
      runSlice: async (): Promise<SliceRunResult> => ({
        completionOk: false,
        ran: true,
        writeCount: 0,
      }),
    });
    expect(state.status).toBe('stopped');
    expect(state.iteration).toBe(3);
  });

  it('records slice outcomes in project memory', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'correggi', hasPlan: true });
    const memory = new FileMemoryBackend();

    await runZelariMission('correggi', brief, {
      projectRoot: root,
      memory,
      emit: () => {},
      maxIterations: 2,
      runSlice: async (): Promise<SliceRunResult> => ({ completionOk: false, ran: true }),
    });

    const hits = await memory.search('iteration completionOk', {
      metadataFilter: { projectRoot: root },
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('captures a runSlice throw as mission error', async () => {
    const root = await tmp();
    const brief = buildMissionBrief({ userMessage: 'correggi', hasPlan: true });
    const state = await runZelariMission('correggi', brief, {
      projectRoot: root,
      memory: new FileMemoryBackend(),
      emit: () => {},
      runSlice: async (): Promise<SliceRunResult> => {
        throw new Error('provider down');
      },
    });
    expect(state.status).toBe('error');
    expect((await readState(root)).status).toBe('error');
  });
});

describe('env helpers', () => {
  it('resolveMaxIterations defaults to 6 and honours the env', () => {
    expect(resolveMaxIterations({} as NodeJS.ProcessEnv)).toBe(6);
    expect(resolveMaxIterations({ ZELARI_MISSION_MAX_ITER: '4' } as NodeJS.ProcessEnv)).toBe(4);
    expect(resolveMaxIterations({ ZELARI_MISSION_MAX_ITER: 'x' } as NodeJS.ProcessEnv)).toBe(6);
  });

  it('resolveMaxStall defaults to 2, honours the env, and clamps', () => {
    expect(resolveMaxStall({} as NodeJS.ProcessEnv)).toBe(2);
    expect(resolveMaxStall({ ZELARI_MISSION_MAX_STALL: '3' } as NodeJS.ProcessEnv)).toBe(3);
    expect(resolveMaxStall({ ZELARI_MISSION_MAX_STALL: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveMaxStall({ ZELARI_MISSION_MAX_STALL: 'x' } as NodeJS.ProcessEnv)).toBe(2);
    expect(resolveMaxStall({ ZELARI_MISSION_MAX_STALL: '-1' } as NodeJS.ProcessEnv)).toBe(2);
  });

  it('isMissionAutoStart only when explicitly 1', () => {
    expect(isMissionAutoStart({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isMissionAutoStart({ ZELARI_MISSION_AUTO: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('formatBriefForChat', () => {
  it('renders the key brief fields', () => {
    const brief = buildMissionBrief({ userMessage: 'costruisci un gestionale in react con stripe' });
    const out = formatBriefForChat(brief);
    expect(out).toContain('Mission brief');
    expect(out).toContain('intent:');
    expect(out).toContain('MVP slice:');
  });
});
