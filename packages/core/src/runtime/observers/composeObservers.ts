/**
 * composeObservers — collapse several observers into a single AgentObserver.
 *
 * Each hook fans out to every observer in order and returns the resolved
 * intervention. This is a raw fan-out (no failure modes); use {@link ObserverBus}
 * when throw isolation / fail-closed semantics are required.
 */
import type { AgentObserver, ObserverResult } from './types.js';
import { CONTINUE } from './types.js';
import { resolveInterventions } from './resolve.js';

const HOOKS: (keyof AgentObserver)[] = [
  'onRunStart',
  'onModelAttempt',
  'onModelDelta',
  'onModelResponse',
  'onToolCall',
  'onToolResult',
  'onTurnEnd',
  'onRunEnd',
  'onCancelled',
];

type HookCallback = (event: unknown) => ObserverResult | Promise<ObserverResult>;

export function composeObservers(observers: AgentObserver[]): AgentObserver {
  const composed: AgentObserver = {};
  for (const hook of HOOKS) {
    (composed as Record<string, unknown>)[hook] = async (event: unknown): Promise<ObserverResult> => {
      const results: ObserverResult[] = [];
      for (const observer of observers) {
        const callback = (observer as Record<string, unknown>)[hook];
        if (typeof callback === 'function') {
          results.push((await (callback as HookCallback)(event)) ?? CONTINUE);
        }
      }
      return resolveInterventions(results);
    };
  }
  return composed;
}
