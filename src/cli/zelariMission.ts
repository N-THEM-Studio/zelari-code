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
import type { DurableStateStore, MemoryBackend } from '@zelari/core';
import type { CouncilRunMode, MissionBrief } from '@zelari/core/council';
import { formatMemoryHits } from './memory/fileBackend.js';
import { createCheckpoint } from './checkpoint/checkpointManager.js';
import { getStateStore } from './state/fileStateStore.js';
import { discoveriesFromOutcome, tryStateCommit } from './state/commitHelpers.js';

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
  /** HEAD of durable state after last verified commit (Palmer accumulation). */
  lastGoodCommitId?: string;
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
  /** Wall-clock step (design + implementation). */
  iteration: number;
  /**
   * 1-based implementation attempt when `runMode === 'implementation'`.
   * Design-phase leaves this undefined / 0.
   */
  implementationIndex?: number;
  /**
   * True on implementation attempts after the first: drivers should run a
   * reduced roster (Minosse + Lucifero only) instead of a full council.
   */
  implementerRetry?: boolean;
}

export interface ZelariMissionDeps {
  projectRoot: string;
  memory: MemoryBackend;
  /**
   * Optional durable state store. When omitted, the driver resolves one via
   * getStateStore(projectRoot) (fail-open). Inject in tests to assert commits.
   */
  stateStore?: DurableStateStore;
  /** Runs a single council slice and reports its completion. */
  runSlice: (args: RunSliceArgs) => Promise<SliceRunResult>;
  /** Emit a status/progress line to the UI. */
  emit: (message: string) => void;
  maxIterations?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  missionId?: string;
  /**
   * When true, implementation slices use single-agent harness (emit labels
   * say build@agent). When false/undefined, emit legacy council roster labels.
   * Does not change runSlice wiring — the caller still injects the runner.
   */
  buildViaAgent?: boolean;
}

/**
 * Default budget for **implementation** slices only.
 * Design-phase (when the brief asks for it) is free and does not consume this.
 * Override via `ZELARI_MISSION_MAX_ITER`.
 */
const DEFAULT_MAX_ITER = 6;
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

  const stateStore =
    deps.stateStore ?? (await getStateStore(deps.projectRoot, deps.env ?? process.env));
  try {
    await stateStore.init(deps.projectRoot);
  } catch {
    // fail-open
  }

  // Safety net: snapshot the working tree before the mission mutates files,
  // so a bad run can be rolled back atomically (opt out: ZELARI_CHECKPOINT=0).
  // Best-effort — a non-git project or a git hiccup just skips the checkpoint.
  let missionCheckpointId: string | undefined;
  if ((deps.env ?? process.env).ZELARI_CHECKPOINT !== '0') {
    const cp = await createCheckpoint(deps.projectRoot, `zelari mission ${missionId}`);
    if (cp.ok) {
      missionCheckpointId = cp.value.id;
      deps.emit(
        `[zelari] checkpoint ${cp.value.id} creato — se la missione va storta ripristina con \`/rollback ${cp.value.id}\`.`,
      );
    }
  }

  const designFirst = brief.phases[0]?.mode === 'design-phase';

  // Consecutive implementation iterations that wrote 0 project files. Reset on
  // any real write. Drives the `stalled` early-out (see resolveMaxStall).
  let noWriteStreak = 0;
  // Wall-clock step counter (design + impl) for state.iteration / logging.
  let step = 0;
  // Implementation slices only — this is what maxIter budgets.
  let implStep = 0;
  // One free design-phase pass when the brief asks for it (does not burn budget).
  let pendingDesign = designFirst;

  while (true) {
    const runMode: CouncilRunMode = pendingDesign ? 'design-phase' : 'implementation';
    if (runMode === 'implementation') {
      if (implStep >= maxIter) break;
      implStep++;
    }
    step++;
    state.iteration = step;

    const hits = await deps.memory.search(`${brief.deliverableThisMission} ${userMessage}`, {
      limit: 8,
      metadataFilter: { projectRoot: deps.projectRoot },
    });
    // Memory only here — durable HEAD is injected once via compose/loadDurableContext
    // in the council dispatch path (avoids double materialize of the same block).
    const ragContext = formatMemoryHits(hits);
    // buildSlicePrompt uses iteration>1 for "fix remaining failures" — that
    // should track implementation attempts, not free design steps.
    const promptIter = runMode === 'implementation' ? implStep : 1;
    const slicePrompt = buildSlicePrompt(brief, userMessage, runMode, promptIter);

    const implementerRetry = runMode === 'implementation' && implStep > 1;

    if (runMode === 'design-phase') {
      deps.emit(
        `[zelari] design-phase (fuori budget) · step ${step} · slice ${brief.sliceMvp.id}`,
      );
    } else if (deps.buildViaAgent) {
      deps.emit(
        `[zelari] implementazione ${implStep}/${maxIter} · step ${step} · ` +
          `build@agent · slice ${brief.sliceMvp.id}`,
      );
    } else if (implementerRetry) {
      deps.emit(
        `[zelari] implementazione ${implStep}/${maxIter} · step ${step} · ` +
          `roster ridotto (Minosse+Lucifero) · slice ${brief.sliceMvp.id}`,
      );
    } else {
      deps.emit(
        `[zelari] implementazione ${implStep}/${maxIter} · step ${step} · ` +
          `council completo · slice ${brief.sliceMvp.id}`,
      );
    }

    let result: SliceRunResult;
    try {
      result = await deps.runSlice({
        userMessage: slicePrompt,
        runMode,
        ragContext,
        iteration: step,
        implementationIndex: runMode === 'implementation' ? implStep : undefined,
        implementerRetry,
      });
    } catch (err) {
      state.status = 'error';
      state.updatedAt = now().toISOString();
      await writeMissionState(deps.projectRoot, state);
      deps.emit(
        `[zelari] errore allo step ${step}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return state;
    }

    await deps.memory.add(
      JSON.stringify({
        iteration: step,
        implStep: runMode === 'implementation' ? implStep : 0,
        runMode,
        completionOk: result.completionOk,
        synthesis: result.synthesisText?.slice(0, 2000) ?? '',
      }),
      {
        projectRoot: deps.projectRoot,
        missionId,
        sliceId: brief.sliceMvp.id,
        source: 'council',
        iteration: step,
      },
    );

    // Implementation slices that report writeCount===0 cannot be "done" even if
    // a vacuous completion.json says ok (empty tree / no blocking verify).
    let completionOk = result.completionOk;
    if (
      runMode === 'implementation' &&
      completionOk &&
      typeof result.writeCount === 'number' &&
      result.writeCount === 0
    ) {
      completionOk = false;
      deps.emit(
        '[zelari] completion.ok ignored: implementation slice wrote 0 project files',
      );
    }

    state.lastCompletionOk = completionOk;
    state.updatedAt = now().toISOString();

    // Design is free: clear the flag and continue into implementation budget.
    if (runMode === 'design-phase') {
      pendingDesign = false;
      await writeMissionState(deps.projectRoot, state);
      continue;
    }

    // Durable accumulation: verified success → hard commit; progress with
    // writes → soft progress commit so the next slice inherits discoveries.
    const wrote = typeof result.writeCount === 'number' && result.writeCount > 0;
    if (completionOk || wrote) {
      const hard = result.completionOk === true;
      const commitRes = await tryStateCommit({
        projectRoot: deps.projectRoot,
        store: stateStore,
        env: deps.env,
        mode: 'zelari',
        layer: hard
          ? `mission:impl-${implStep}`
          : `mission:progress-${implStep}`,
        label: hard
          ? `zelari ${brief.sliceMvp.id} impl ${implStep} verified`
          : `zelari ${brief.sliceMvp.id} progress impl ${implStep}`,
        sessionId: missionId,
        verification: { ok: hard, ran: result.ran },
        force: !hard,
        // Prefer linking the mission-start checkpoint (no explosion).
        workspaceCheckpointId: missionCheckpointId,
        withCheckpoint: hard && !missionCheckpointId,
        discoveries: discoveriesFromOutcome({
          stepId: `${missionId}-${step}`,
          synthesis: result.synthesisText,
          writeCount: result.writeCount,
          note: hard
            ? `Implementation slice ${implStep} completed (verified)`
            : `Progress slice ${implStep} (${result.writeCount} writes, not yet complete)`,
        }),
      });
      if (commitRes.ok && commitRes.meta?.id) {
        // Only advance lastGoodCommitId on verified commits (Palmer: oracle PASS).
        if (hard) {
          state.lastGoodCommitId = commitRes.meta.id;
          if (commitRes.checkpointId && !missionCheckpointId) {
            missionCheckpointId = commitRes.checkpointId;
          }
        }
        deps.emit(
          `[zelari] state commit ${commitRes.meta.id}` +
            ` (${hard ? 'verified' : 'progress'} layer mission:${hard ? 'impl' : 'progress'}-${implStep})`,
        );
      } else if (commitRes.error) {
        deps.emit(`[zelari] state commit skipped: ${commitRes.error}`);
      }
    }

    // Success only when an IMPLEMENTATION slice completes (and wrote if counted).
    if (completionOk) {
      state.status = 'success';
      await writeMissionState(deps.projectRoot, state);
      deps.emit(
        `[zelari] ✓ missione completata — slice MVP verde all'implementazione ${implStep}/${maxIter} (step ${step}).`,
      );
      return state;
    }

    // Stall detection: an implementation slice that wrote 0 files made no
    // progress toward the deliverable (the documented composer-2.5 mode —
    // synthesis claims done but nothing is written). Bail early with an
    // actionable message instead of burning the whole iteration budget on
    // identical no-op runs. Only counts when the driver reports writeCount.
    if (typeof result.writeCount === 'number') {
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
    `[zelari] fermata dopo ${maxIter} implementazioni senza completamento verde` +
      (designFirst ? ' (design-phase esclusa dal budget)' : '') +
      '. Stato salvato in .zelari/mission-state.json',
  );
  return state;
}
