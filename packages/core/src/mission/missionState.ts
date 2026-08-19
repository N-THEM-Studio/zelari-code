/**
 * mission/missionState.ts — mission state DERIVED from the session spine
 * (2.0 Phase 4). No parallel state writer: phase, progress and replan count
 * are projections of logged events. Interrupt/resume is native — an
 * un-ended log with events is an interrupted, resumable mission.
 */

import type { SessionProjection, VerificationRunSummary } from '../session/replay.js';

export type MissionPhase = 'design' | 'build' | 'verification' | 'done';

const VALID_PHASES: readonly MissionPhase[] = ['design', 'build', 'verification', 'done'];

export interface MissionProgress {
  criteriaTotal: number;
  criteriaPassed: number;
  /** pass/total from the last verification run; null when never verified. */
  ratio: number | null;
  /** True when the last verification passed everything WITH evidence. */
  evidenceComplete: boolean;
}

export interface MissionState {
  sessionId: string;
  phase: MissionPhase;
  progress: MissionProgress;
  replans: number;
  verifications: number;
  lastSeq: number;
  /** Events exist but session.ended is absent → resumable interrupt. */
  interrupted: boolean;
  /** Direct fork parent (full chain via lineageOf on the store). */
  forkParent?: string;
}

function progressFrom(lastVerification: VerificationRunSummary | undefined): MissionProgress {
  const results = lastVerification?.results ?? [];
  const criteriaTotal = results.length;
  const criteriaPassed = results.filter((r) => r.status === 'pass').length;
  const evidenceComplete =
    criteriaTotal > 0 &&
    criteriaPassed === criteriaTotal &&
    results.every((r) => r.evidenceCount > 0);
  return {
    criteriaTotal,
    criteriaPassed,
    ratio: criteriaTotal === 0 ? null : criteriaPassed / criteriaTotal,
    evidenceComplete,
  };
}

/**
 * Project a session into mission state.
 * Phase precedence: last `complete:true` verification → done; else the last
 * explicit `mission.phase` event; else inferred (verification > build > design).
 */
export function deriveMissionState(projection: SessionProjection): MissionState {
  const lastVerification = projection.verifications[projection.verifications.length - 1];
  const complete = lastVerification?.complete === true;
  const explicit = [...projection.missionPhases]
    .reverse()
    .find((p) => (VALID_PHASES as readonly string[]).includes(p.phase));

  const phase: MissionPhase = complete
    ? 'done'
    : explicit
      ? (explicit.phase as MissionPhase)
      : projection.verifications.length > 0
        ? 'verification'
        : projection.toolCalls > 0 || projection.toolResults > 0
          ? 'build'
          : 'design';

  return {
    sessionId: projection.sessionId,
    phase,
    progress: progressFrom(lastVerification),
    replans: projection.replans,
    verifications: projection.verifications.length,
    lastSeq: projection.lastSeq,
    interrupted: projection.lastSeq > 0 && projection.endedAt === undefined,
    forkParent: projection.fork?.parentSessionId,
  };
}

/** Serializable mission snapshot (headless/Desktop resume payload). */
export function missionSnapshot(state: MissionState): string {
  return JSON.stringify(
    {
      format: 'zelari-mission-snapshot',
      version: 1,
      ...state,
    },
    null,
    2,
  );
}
