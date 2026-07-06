/**
 * Zelari-mode mission driver — the autonomous multi-run loop.
 *
 * Runs council slices until the MVP slice's `completion.ok` is true (success)
 * or the iteration budget is exhausted (stop + handoff state). The loop itself
 * is provider-agnostic and dependency-injected (`runSlice`, `memory`, `emit`)
 * so it is unit-testable without a live LLM. The TUI wires `runSlice` to a real
 * council dispatch; tests wire a fake.
 *
 * Between iterations only a compact context is re-fed (mission brief + memory
 * hits via `ragContext`), never the full JSONL transcript.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryBackend } from '@zelari/core';
import type { CouncilRunMode, MissionBrief } from '@zelari/core/council';
import { formatMemoryHits } from './memory/fileBackend.js';

export type MissionStatus =
  | 'running'
  | 'success'
  | 'stopped'
  | 'stalled'
  | 'cancelled'
  | 'error';

export interface MissionState {
  missionId: string;
  userPrompt: string;
  brief: MissionBrief;
  iteration: number;
  currentSliceId: string;
  status: MissionStatus;
  lastCompletionOk: boolean;
  startedAt: string;
  updatedAt: string;
}

/** What one council slice run reports back to the loop. */
export interface SliceRunResult {
  completionOk: boolean;
  ran: boolean;
  synthesisText?: string;
  /**
   * Project-file writes (write_file/edit_file) this slice performed. When the
   * driver reports this, the loop uses it to detect the documented
   * composer-2.5 failure mode (implementation slice that claims done but
   * writes 0 files → degraded → never green). `undefined` means the driver
   * did not report it, so stall detection is disabled (backward compatible).
   */
  writeCount?: number;
  /** The council flagged this slice as a degraded (non-hand-off) run. */
  degraded?: boolean;
}

export interface RunSliceArgs {
  userMessage: string;
  runMode: CouncilRunMode;
  ragContext: string;
  iteration: number;
}

export interface ZelariMissionDeps {
  projectRoot: string;
  memory: MemoryBackend;
  /** Runs a single council slice and reports its completion. */
  runSlice: (args: RunSliceArgs) => Promise<SliceRunResult>;
  /** Emit a status/progress line to the UI. */
  emit: (message: string) => void;
  maxIterations?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  missionId?: string;
}

const DEFAULT_MAX_ITER = 10;
const DEFAULT_MAX_STALL = 2;

export function resolveMaxIterations(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_MISSION_MAX_ITER;
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_ITER;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ITER;
}

/**
 * Consecutive implementation iterations that write 0 files before the mission
 * bails out with `stalled`. Grinding the full iteration budget when every run
 * writes nothing just burns council calls without approaching a deliverable —
 * this caps that waste and surfaces an actionable message instead. `0` disables
 * stall detection (fall back to the plain iteration budget).
 */
export function resolveMaxStall(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_MISSION_MAX_STALL;
  if (raw === undefined) return DEFAULT_MAX_STALL;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_STALL;
}

/** True unless auto-start is explicitly requested. */
export function isMissionAutoStart(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZELARI_MISSION_AUTO === '1';
}

async function writeMissionState(projectRoot: string, state: MissionState): Promise<void> {
  const dir = path.join(projectRoot, '.zelari');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'mission-state.json'),
    JSON.stringify(state, null, 2) + '\n',
    'utf8',
  );
}

function buildSlicePrompt(
  brief: MissionBrief,
  userMessage: string,
  runMode: CouncilRunMode,
  iteration: number,
): string {
  if (runMode === 'design-phase') {
    return (
      `${userMessage}\n\n[Zelari mission] Produce the design-phase plan for the MVP: ` +
      `${brief.deliverableThisMission}. Keep the first slice to at most ` +
      `${brief.sliceMvp.maxTasks ?? 8} tasks.`
    );
  }
  const fix =
    iteration > 1
      ? ' Address any remaining verification failures recorded in .zelari/completion.json.'
      : '';
  return (
    `${userMessage}\n\n[Zelari mission] Implement the MVP slice: ` +
    `${brief.deliverableThisMission}.${fix} ` +
    'You MUST create or modify the real project files with write_file / edit_file — ' +
    'not just describe them in prose. A run that claims completion without writing ' +
    'any file is a failed run and will not be accepted.'
  );
}

/** Render the brief as a chat block for the confirmation step. */
export function formatBriefForChat(brief: MissionBrief): string {
  const lines: string[] = [
    '[zelari] Mission brief',
    `  intent:      ${brief.intent}`,
    `  first run:   ${brief.runModeHint}`,
    `  deliverable: ${brief.deliverableThisMission}`,
  ];
  if (brief.stackInferred.length) {
    lines.push(`  stack:       ${brief.stackInferred.join(', ')}`);
  }
  if (brief.assumptions.length) {
    lines.push('  assumptions:');
    for (const a of brief.assumptions) lines.push(`    - ${a}`);
  }
  if (brief.outOfScope.length) {
    lines.push('  out of scope:');
    for (const o of brief.outOfScope) lines.push(`    - ${o}`);
  }
  lines.push(`  MVP slice:   ${brief.sliceMvp.title} (≤ ${brief.sliceMvp.maxTasks} tasks)`);
  return lines.join('\n');
}

/**
 * Drive a full Zelari mission to success or the iteration limit.
 */
export async function runZelariMission(
  userMessage: string,
  brief: MissionBrief,
  deps: ZelariMissionDeps,
): Promise<MissionState> {
  const now = deps.now ?? (() => new Date());
  const maxIter = deps.maxIterations ?? resolveMaxIterations(deps.env);
  const maxStall = resolveMaxStall(deps.env);
  const missionId = deps.missionId ?? `m_${randomUUID().slice(0, 8)}`;
  const startedAt = now().toISOString();

  const state: MissionState = {
    missionId,
    userPrompt: userMessage,
    brief,
    iteration: 0,
    currentSliceId: brief.sliceMvp.id,
    status: 'running',
    lastCompletionOk: false,
    startedAt,
    updatedAt: startedAt,
  };

  await deps.memory.init(deps.projectRoot);
  await writeMissionState(deps.projectRoot, state);

  const designFirst = brief.phases[0]?.mode === 'design-phase';

  // Consecutive implementation iterations that wrote 0 project files. Reset on
  // any real write. Drives the `stalled` early-out (see resolveMaxStall).
  let noWriteStreak = 0;

  for (let i = 1; i <= maxIter; i++) {
    state.iteration = i;
    const runMode: CouncilRunMode = i === 1 && designFirst ? 'design-phase' : 'implementation';

    const hits = await deps.memory.search(`${brief.deliverableThisMission} ${userMessage}`, {
      limit: 8,
      metadataFilter: { projectRoot: deps.projectRoot },
    });
    const ragContext = formatMemoryHits(hits);
    const slicePrompt = buildSlicePrompt(brief, userMessage, runMode, i);

    deps.emit(`[zelari] iterazione ${i}/${maxIter} · ${runMode} · slice ${brief.sliceMvp.id}`);

    let result: SliceRunResult;
    try {
      result = await deps.runSlice({ userMessage: slicePrompt, runMode, ragContext, iteration: i });
    } catch (err) {
      state.status = 'error';
      state.updatedAt = now().toISOString();
      await writeMissionState(deps.projectRoot, state);
      deps.emit(`[zelari] errore all'iterazione ${i}: ${err instanceof Error ? err.message : String(err)}`);
      return state;
    }

    await deps.memory.add(
      JSON.stringify({
        iteration: i,
        runMode,
        completionOk: result.completionOk,
        synthesis: result.synthesisText?.slice(0, 2000) ?? '',
      }),
      { projectRoot: deps.projectRoot, missionId, sliceId: brief.sliceMvp.id, source: 'council', iteration: i },
    );

    state.lastCompletionOk = result.completionOk;
    state.updatedAt = now().toISOString();

    // Success only when an IMPLEMENTATION slice completes — a design-phase run
    // never writes completion.json, so it always advances the loop.
    if (result.completionOk && runMode === 'implementation') {
      state.status = 'success';
      await writeMissionState(deps.projectRoot, state);
      deps.emit(`[zelari] ✓ missione completata — slice MVP verde all'iterazione ${i}.`);
      return state;
    }

    // Stall detection: an implementation slice that wrote 0 files made no
    // progress toward the deliverable (the documented composer-2.5 mode —
    // synthesis claims done but nothing is written). Bail early with an
    // actionable message instead of burning the whole iteration budget on
    // identical no-op runs. Only counts when the driver reports writeCount.
    if (runMode === 'implementation' && typeof result.writeCount === 'number') {
      if (result.writeCount === 0) noWriteStreak++;
      else noWriteStreak = 0;

      if (maxStall > 0 && noWriteStreak >= maxStall) {
        state.status = 'stalled';
        state.updatedAt = now().toISOString();
        await writeMissionState(deps.projectRoot, state);
        deps.emit(
          `[zelari] fermata: ${noWriteStreak} iterazioni di implementation senza ` +
            'scrivere alcun file (il modello dichiara "fatto" ma non produce il ' +
            'deliverable). Prova un modello più capace o verifica provider/chiave. ' +
            'Stato salvato in .zelari/mission-state.json',
        );
        return state;
      }
    }

    await writeMissionState(deps.projectRoot, state);
  }

  state.status = 'stopped';
  state.updatedAt = now().toISOString();
  await writeMissionState(deps.projectRoot, state);
  deps.emit(
    `[zelari] fermata dopo ${maxIter} iterazioni senza completamento verde. ` +
      'Stato salvato in .zelari/mission-state.json',
  );
  return state;
}
