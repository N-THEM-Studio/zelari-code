/**
 * phaseState — current work phase (plan | build).
 * Mirrors conversationContext: simple module state so agent/council/zelari
 * and slash handlers share one value without prop drilling through Ink.
 *
 * Per harness session in `--serve-harness` (sessionScope): concurrent chats
 * keep their own phase — a build turn in one chat must never lift the
 * plan-phase gate of another. Process-wide everywhere else (TUI, headless).
 */
import type { WorkPhase } from './phase.js';
import { sessionLocal } from './sessionScope.js';

const phase = sessionLocal<WorkPhase>(() => 'build');

export function getPhase(): WorkPhase {
  return phase.get();
}

export function setPhase(next: WorkPhase): void {
  phase.set(next);
}

/** Test helper. */
export function _resetPhaseForTests(): void {
  phase.set('build');
}
