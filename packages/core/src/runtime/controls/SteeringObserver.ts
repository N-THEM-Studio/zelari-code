/**
 * SteeringObserver — drains pending steers at each safe turn boundary and
 * injects them as one user message (Frontier PHASE 2, §26–27).
 *
 * Boundary semantics (§21): this hook runs after tool results are flushed and
 * the assistant turn is sealed, before the next provider call. The in-flight
 * provider request is never mutated. Follow-ups are NOT drained here: they
 * become the next user task after the current run ends (§23.2), which is the
 * caller's decision, not the observer's.
 */
import { CONTINUE, type AgentObserver, type ObserverResult, type TurnEndEvent } from '../observers/types.js';
import type { RuntimeControlQueue } from './RuntimeControlQueue.js';
import type { SteerControlEvent } from './types.js';

/**
 * Render steers verbatim and numbered — never compacted automatically, later
 * instructions may supersede earlier ones (§27).
 */
export function renderSteers(steers: SteerControlEvent[]): string {
  const lines = ['Runtime user steering received during execution:', ''];
  steers.forEach((steer, index) => {
    lines.push(`[${index + 1}]`);
    lines.push(steer.text);
    lines.push('');
  });
  lines.push('Later instructions may supersede earlier ones.');
  return lines.join('\n');
}

export class SteeringObserver implements AgentObserver {
  constructor(private readonly queue: RuntimeControlQueue) {}

  async onTurnEnd(_event: TurnEndEvent): Promise<ObserverResult> {
    const steers = this.queue.drainSteers();
    if (steers.length === 0) {
      return CONTINUE;
    }
    return {
      action: 'inject',
      message: {
        role: 'user',
        kind: 'runtime-steer',
        content: renderSteers(steers),
      },
    };
  }
}
