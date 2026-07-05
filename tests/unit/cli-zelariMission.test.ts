import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildMissionBrief } from '@zelari/core/council';
import { FileMemoryBackend } from '../../src/cli/memory/fileBackend.js';
import {
  runZelariMission,
  resolveMaxIterations,
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
  it('resolveMaxIterations defaults to 10 and honours the env', () => {
    expect(resolveMaxIterations({} as NodeJS.ProcessEnv)).toBe(10);
    expect(resolveMaxIterations({ ZELARI_MISSION_MAX_ITER: '4' } as NodeJS.ProcessEnv)).toBe(4);
    expect(resolveMaxIterations({ ZELARI_MISSION_MAX_ITER: 'x' } as NodeJS.ProcessEnv)).toBe(10);
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
