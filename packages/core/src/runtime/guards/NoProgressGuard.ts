/**
 * NoProgressGuard — detect runs that stop making meaningful progress
 * (Frontier upgrade, PHASE 1B §15).
 *
 * Core-level progress signals available from observer events: file-writing
 * tool calls (write_file / edit_file / apply_diff) and first-time tool-call
 * fingerprints. A turn with zero tool calls is treated as neutral (pure
 * synthesis / answer turns do not advance the stall counter, to avoid false
 * positives on legitimately finishing runs).
 *
 * `softStallTurns` consecutive unproductive turns inject a change-strategy
 * warning; `hardStallTurns` consecutive unproductive turns stop the run.
 * This generalizes the mission-level stall concept to the plain Kraken loop.
 */
import { CONTINUE } from '../observers/types.js';
import type {
  AgentObserver,
  ObserverResult,
  ToolCallEvent,
  TurnEndEvent,
} from '../observers/types.js';
import { toolCallFingerprint } from './RepetitionGuard.js';

/** Tools whose execution changes repository state. */
export const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'apply_diff',
]);

export interface NoProgressGuardConfig {
  /** Consecutive unproductive turns before the inject warning (default 2). */
  softStallTurns?: number;
  /** Consecutive unproductive turns before the stop (default 5). */
  hardStallTurns?: number;
}

const REASSESS_MESSAGE = [
  'The run has made no measurable progress for several turns.',
  'Change strategy: inspect different files, delegate exploration, or revise the hypothesis.',
].join('\n');

export class NoProgressGuard implements AgentObserver {
  private readonly seenFingerprints = new Set<string>();
  private readonly soft: number;
  private readonly hard: number;
  private stallTurns = 0;
  private turnToolCalls = 0;
  private turnWrites = 0;
  private turnNewFingerprints = 0;

  constructor(config: NoProgressGuardConfig = {}) {
    this.soft = config.softStallTurns ?? 2;
    this.hard = config.hardStallTurns ?? 5;
  }

  async onToolCall(event: ToolCallEvent): Promise<ObserverResult> {
    this.turnToolCalls += 1;
    if (FILE_WRITING_TOOLS.has(event.toolName)) this.turnWrites += 1;

    const fingerprint = toolCallFingerprint(event.toolName, event.args);
    const key = `${fingerprint.tool}\u0000${fingerprint.argsHash}`;
    if (!this.seenFingerprints.has(key)) {
      this.seenFingerprints.add(key);
      this.turnNewFingerprints += 1;
    }
    return CONTINUE;
  }

  async onTurnEnd(_event: TurnEndEvent): Promise<ObserverResult> {
    if (this.turnToolCalls === 0) {
      // Neutral: a turn without tool calls is synthesis, not stall evidence.
      return CONTINUE;
    }
    const productive = this.turnWrites > 0 || this.turnNewFingerprints > 0;
    this.stallTurns = productive ? 0 : this.stallTurns + 1;
    this.turnToolCalls = 0;
    this.turnWrites = 0;
    this.turnNewFingerprints = 0;

    if (this.stallTurns >= this.hard) {
      return {
        action: 'stop',
        reason: `no measurable progress for ${this.stallTurns} consecutive turns`,
        code: 'no_progress',
      };
    }
    if (this.stallTurns >= this.soft) {
      return {
        action: 'inject',
        message: { role: 'user', kind: 'runtime-warning', content: REASSESS_MESSAGE },
      };
    }
    return CONTINUE;
  }

  reset(): void {
    this.seenFingerprints.clear();
    this.stallTurns = 0;
    this.turnToolCalls = 0;
    this.turnWrites = 0;
    this.turnNewFingerprints = 0;
  }
}
