/**
 * Host-driven Gauntlet loop: builder tentacle → isolated critic → GAP
 * or PASS, capped. No parent writes. No "until critics win".
 */
import { parseBlindWinner } from './blind.js';
import type { GauntletCaps } from './policy.js';
import { DEFAULT_WALL_MS } from './policy.js';
import { parseGauntletVerdict, type GauntletVerdict } from './verdict.js';
import { builderUserPrompt, criticUserPrompt, GAUNTLET_CRITIC_SYSTEM } from './prompts.js';
import type { GauntletPiece } from './decompose.js';
import { scheduleWaves } from './schedule.js';
import {
  formatGauntletSummary,
  gauntletProgressEvent,
  type GauntletPhase,
  type GauntletProgressView,
} from './events.js';

export interface GauntletTentacleResult {
  ok: boolean;
  result: string;
  error?: string;
  toolTraceCount?: number;
}

export interface GauntletLoopDeps {
  runBuilder: (args: {
    piece: GauntletPiece;
    prompt: string;
    round: number;
  }) => Promise<GauntletTentacleResult>;
  runCritic: (args: {
    piece: GauntletPiece;
    prompt: string;
    systemPrompt: string;
    round: number;
  }) => Promise<GauntletTentacleResult>;
  emit: (event: Record<string, unknown>) => void;
  note?: (text: string, data?: Record<string, unknown>) => void;
  signal?: AbortSignal;
  now?: () => number;
  sessionId: string;
  /** Optional workspace briefing injected into builder prompts. */
  briefing?: string;
}

export interface GauntletPieceResult {
  id: string;
  label: string;
  verdict: GauntletVerdict;
  rounds: number;
  winner?: 'A' | 'B' | 'TIE';
}

export interface GauntletLoopResult {
  settled: boolean;
  cancelled: boolean;
  timedOut: boolean;
  pieces: GauntletPieceResult[];
  summary: string;
}

export async function runGauntletLoop(args: {
  pieces: GauntletPiece[];
  caps: GauntletCaps;
  deps: GauntletLoopDeps;
}): Promise<GauntletLoopResult> {
  const { caps, deps } = args;
  const pieces = args.pieces.slice(0, caps.maxPieces);
  const started = (deps.now ?? Date.now)();
  const results: GauntletPieceResult[] = [];
  const emitProgress = (partial: Omit<GauntletProgressView, 'elapsedMs'>): void => {
    const progress: GauntletProgressView = {
      ...partial,
      elapsedMs: (deps.now ?? Date.now)() - started,
    };
    deps.emit(gauntletProgressEvent(deps.sessionId, progress) as unknown as Record<string, unknown>);
    deps.note?.('gauntlet.progress', progress as unknown as Record<string, unknown>);
  };

  const wall =
    caps.wallClockMs === undefined ? DEFAULT_WALL_MS : caps.wallClockMs;
  const expired = (): boolean =>
    wall > 0 && (deps.now ?? Date.now)() - started >= wall;
  const aborted = (): boolean => Boolean(deps.signal?.aborted);
  const stop = (): boolean => aborted() || expired();
  const indexOf = (piece: GauntletPiece): number =>
    pieces.findIndex((p) => p.id === piece.id);

  const runOnePiece = async (piece: GauntletPiece): Promise<GauntletPieceResult> => {
    let last: GauntletVerdict = {
      kind: 'BLOCKED',
      gap: 'no round ran',
      evidence: false,
    };
    let gap: string | undefined;
    let winner: 'A' | 'B' | 'TIE' | undefined;
    let rounds = 0;
    const i = Math.max(0, indexOf(piece));
    for (let round = 1; round <= caps.maxRounds; round++) {
      if (stop()) break;
      rounds = round;
      const phase: GauntletPhase = gap ? 'repairing' : 'building';
      emitProgress({
        phase,
        pieceId: piece.id,
        pieceLabel: piece.label,
        pieceIndex: i,
        pieceCount: pieces.length,
        round,
        maxRounds: caps.maxRounds,
      });
      const built = await deps.runBuilder({
        piece,
        prompt: builderUserPrompt(piece, gap, deps.briefing),
        round,
      });
      if (stop()) break;

      emitProgress({
        phase: 'critiquing',
        pieceId: piece.id,
        pieceLabel: piece.label,
        pieceIndex: i,
        pieceCount: pieces.length,
        round,
        maxRounds: caps.maxRounds,
      });
      const criticized = await deps.runCritic({
        piece,
        prompt: criticUserPrompt(piece, round),
        systemPrompt: GAUNTLET_CRITIC_SYSTEM,
        round,
      });
      last = parseGauntletVerdict(criticized.result, {
        toolTraceCount: criticized.toolTraceCount ?? 0,
        builderFailed: !built.ok,
        builderError: built.error,
      });
      winner = parseBlindWinner(criticized.result) ?? winner;
      emitProgress({
        phase: last.kind === 'PASS' ? 'settled' : last.kind === 'BLOCKED' ? 'blocked' : 'repairing',
        pieceId: piece.id,
        pieceLabel: piece.label,
        pieceIndex: i,
        pieceCount: pieces.length,
        round,
        maxRounds: caps.maxRounds,
        verdict: last.kind,
        gap: last.gap,
        winner,
      });
      if (last.kind === 'PASS' || last.kind === 'BLOCKED') break;
      gap = last.gap;
    }
    return {
      id: piece.id,
      label: piece.label,
      verdict: last,
      rounds,
      ...(winner ? { winner } : {}),
    };
  };

  for (const wave of scheduleWaves(pieces, caps.maxParallel)) {
    if (stop()) return finish(results, { cancelled: aborted(), timedOut: expired() });
    if (wave.length === 1) {
      results.push(await runOnePiece(wave[0]!));
    } else {
      const waveResults = await Promise.all(wave.map((p) => runOnePiece(p)));
      results.push(...waveResults);
    }
    if (stop()) return finish(results, { cancelled: aborted(), timedOut: expired() });
  }

  return finish(results, { cancelled: aborted(), timedOut: expired() });
}

function finish(
  results: GauntletPieceResult[],
  flags: { cancelled: boolean; timedOut: boolean },
): GauntletLoopResult {
  const cancelled = flags.timedOut ? false : flags.cancelled;
  const timedOut = flags.timedOut;
  const settled =
    !cancelled &&
    !timedOut &&
    results.length > 0 &&
    results.every((r) => r.verdict.kind === 'PASS');
  return {
    settled,
    cancelled,
    timedOut,
    pieces: results,
    summary: formatGauntletSummary(
      results.map((r) => ({
        id: r.id,
        label: r.label,
        verdict: r.verdict.kind,
        rounds: r.rounds,
        gap: r.verdict.gap,
        winner: r.winner,
      })),
      { timedOut, cancelled },
    ),
  };
}
