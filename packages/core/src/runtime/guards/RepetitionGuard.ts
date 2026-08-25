/**
 * RepetitionGuard — detect semantically identical tool calls repeated without
 * new progress (Frontier upgrade, PHASE 1B).
 *
 * Fingerprint is a canonical sha256 over { tool, args } (order-free), so two
 * calls with the same tool and equal arguments — regardless of key order — map
 * to the same bucket. Reaction: inject a reassess message at `warnAfter`, stop
 * the run at `stopAfter`.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../../core/requestSnapshot.js';
import { CONTINUE } from '../observers/types.js';
import type {
  AgentObserver,
  ObserverResult,
  ToolCallEvent,
} from '../observers/types.js';

export interface ToolCallFingerprint {
  tool: string;
  argsHash: string;
}

/** Canonical sha256 over { tool, args }; arg-key-order independent. */
export function toolCallFingerprint(tool: string, args: unknown): ToolCallFingerprint {
  const argsHash = createHash('sha256')
    .update(stableStringify(args ?? null))
    .digest('hex');
  return { tool, argsHash };
}

export interface RepetitionGuardConfig {
  /** Inject a reassess message at this many identical calls (default 2). */
  warnAfter?: number;
  /** Stop the run at this many identical calls (default 5). */
  stopAfter?: number;
}

const REASSESS_MESSAGE = [
  'The same tool call has produced no new progress multiple times.',
  'Reassess the current hypothesis before repeating it again.',
].join('\n');

export class RepetitionGuard implements AgentObserver {
  private readonly counts = new Map<string, number>();
  private readonly warnAfter: number;
  private readonly stopAfter: number;

  constructor(config: RepetitionGuardConfig = {}) {
    this.warnAfter = config.warnAfter ?? 2;
    this.stopAfter = config.stopAfter ?? 5;
  }

  async onToolCall(event: ToolCallEvent): Promise<ObserverResult> {
    const fingerprint = toolCallFingerprint(event.toolName, event.args);
    const key = `${fingerprint.tool}\u0000${fingerprint.argsHash}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);

    if (count >= this.stopAfter) {
      return {
        action: 'stop',
        reason: `repeated tool call "${fingerprint.tool}" ${count} times without new progress`,
        code: 'repeated_tool',
      };
    }
    if (count >= this.warnAfter) {
      return {
        action: 'inject',
        message: { role: 'user', kind: 'runtime-warning', content: REASSESS_MESSAGE },
      };
    }
    return CONTINUE;
  }

  reset(): void {
    this.counts.clear();
  }
}
