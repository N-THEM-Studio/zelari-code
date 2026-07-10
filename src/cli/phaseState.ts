/**
 * phaseState — process-wide current work phase (plan | build).
 * Mirrors conversationContext: simple module state so agent/council/zelari
 * and slash handlers share one value without prop drilling through Ink.
 */
import type { WorkPhase } from './phase.js';

let phase: WorkPhase = 'build';

export function getPhase(): WorkPhase {
  return phase;
}

export function setPhase(next: WorkPhase): void {
  phase = next;
}

/** Test helper. */
export function _resetPhaseForTests(): void {
  phase = 'build';
}
