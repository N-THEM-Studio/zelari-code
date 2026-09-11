/**
 * missionResume.test.ts — locks the /resume-mission contract
 * (experimental/cursor-learn 2.3).
 *
 * Covers: status label mapping, the status formatter, the slash parser
 * (/resume-mission | /resume-mission status) and the absent-state path of
 * handleResumeMissionStatus. The resume RUN path is covered end-to-end by
 * src/cli/missionResume.test.ts (resumeZelariMission) — not duplicated here.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatMissionStatus,
  handleResumeMissionStatus,
  missionStatusLabel,
} from './missionResume.js';
import type { MissionState } from '../zelariMission.js';
import { handleSlashCommand } from '../slashCommands.js';

const state = (over: Partial<MissionState> = {}): MissionState =>
  ({
    missionId: 'm_1a2b3c4d',
    userPrompt: 'completa il piano sperimentale di cursor',
    iteration: 3,
    currentSliceId: 's-02',
    status: 'stopped',
    lastCompletionOk: true,
    startedAt: '2026-09-11T10:00:00.000Z',
    updatedAt: '2026-09-11T12:00:00.000Z',
    ...over,
  }) as unknown as MissionState;

describe('missionStatusLabel', () => {
  it('maps every MissionStatus to an Italian label', () => {
    expect(missionStatusLabel('running')).toBe('in corso');
    expect(missionStatusLabel('success')).toBe('completata');
    expect(missionStatusLabel('stopped')).toBe('ferma');
    expect(missionStatusLabel('stalled')).toBe('in stallo');
    expect(missionStatusLabel('cancelled')).toBe('annullata');
    expect(missionStatusLabel('error')).toBe('in errore');
  });
});

describe('formatMissionStatus', () => {
  it('names mission, status, iteration and slice', () => {
    const out = formatMissionStatus(state());
    expect(out).toContain('m_1a2b3c4d');
    expect(out).toContain('ferma');
    expect(out).toContain('iterazione: 3');
    expect(out).toContain('s-02');
    expect(out).toContain('aggiornata: 2026-09-11T12:00:00.000Z');
  });

  it('truncates long prompts at 120 chars', () => {
    const out = formatMissionStatus(
      state({ userPrompt: 'x'.repeat(200) }),
    );
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(130));
  });
});

describe('/resume-mission parser', () => {
  it('bare command resumes the persisted mission', () => {
    const res = handleSlashCommand('/resume-mission', []);
    expect(res.handled).toBe(true);
    expect(res.kind).toBe('resume_mission');
  });

  it('status argument only shows the state (no run)', () => {
    const res = handleSlashCommand('/resume-mission status', []);
    expect(res.handled).toBe(true);
    expect(res.kind).toBe('resume_mission_status');
  });
});

describe('handleResumeMissionStatus (absent state)', () => {
  it('reports the missing mission-state.json instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zelari-resume-'));
    const emitted: string[] = [];
    const setMessages = ((update: unknown) => {
      const next =
        typeof update === 'function'
          ? (update as (prev: never[]) => unknown)([])
          : update;
      emitted.push(JSON.stringify(next));
    }) as unknown as Parameters<typeof handleResumeMissionStatus>[0]['setMessages'];
    await handleResumeMissionStatus({ setMessages }, root);
    expect(emitted[0]).toContain('nessuna missione persistita');
  });
});
