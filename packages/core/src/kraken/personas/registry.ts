/**
 * Kraken spec council — persona registry (Pillar 2, F2.1).
 *
 * The 3 reviewer personas share a common surface (a verdict trailer, an
 * optional per-requirement table, and a system prompt). This file defines
 * the registry; individual personas live in sibling files and register
 * themselves via {@link registerPersona}.
 *
 * The registry is **runtime-populated, not compile-time**. The reason:
 * personas are additive (Pillar 2 lands 3, future pillars may add more
 * for oracle / advisor / etc.), and we want adding a persona to be a
 * single file with no central edit. The price is one indirection at
 * lookup time; that's cheap relative to the LLM call it gates.
 *
 * Adding a persona:
 *   1. Create `packages/core/src/kraken/personas/<name>.ts`.
 *   2. Call `registerPersona({ kind: 'spec', systemPrompt: '...', ... })`
 *      at module load.
 *   3. (Optional) Extend `TaskNodeKind` to include the new kind — the
 *      runtime routes 'verify', 'spec', 'conformance' to the same
 *      host agent today, so this is not strictly required.
 *
 * @since Kraken v1.30.x — workflow script runtime (Pillar 2)
 */

import type { TaskNodeKind } from '../graph.js';
import {
  parsePersonaVerdict,
  type PersonaVerdict,
  type RequirementVerdict,
} from '../verdict.js';

/** A reviewer persona: a kind, a system prompt, and a verdict parser. */
export interface Persona {
  /** The `TaskNodeKind` this persona matches. */
  kind: TaskNodeKind;
  /** Short label for status / radio. */
  label: string;
  /** Long-form description (one line). */
  description: string;
  /**
   * System prompt the sub-agent is given. Should include:
   *   - the persona's role and bias (spec-reviewer is conservative, etc.)
   *   - the verdict format the persona must emit (trailer + optional table)
   *   - the kind of evidence the persona should cite
   */
  systemPrompt: string;
  /**
   * Parse the persona's reply into a structured verdict. Default: the
   * generic `parsePersonaVerdict` (trailer + requirements block).
   * Override when a persona has a custom format (e.g. oracle's blind A/B).
   */
  parseVerdict?: (text: string) => PersonaVerdict;
}

const registry = new Map<TaskNodeKind, Persona>();

/** Register a persona. Idempotent: re-registering the same kind overwrites. */
export function registerPersona(p: Persona): void {
  registry.set(p.kind, p);
}

/** Look up a persona by kind. Returns undefined when not registered. */
export function getPersona(kind: TaskNodeKind): Persona | undefined {
  return registry.get(kind);
}

/** All registered personas, in registration order. */
export function listPersonas(): Persona[] {
  return [...registry.values()];
}

/** Whether the given kind is a "reviewer" — a persona that judges other
 *  tentacles' work. Used by the executor to decide whether to wire the
 *  verdict into a rework round. */
export function isReviewerKind(kind: TaskNodeKind): boolean {
  return kind === 'verify' || kind === 'spec' || kind === 'conformance';
}

/** Default verdict parser for any persona. Mirrors `parsePersonaVerdict`. */
export function defaultPersonaParse(text: string): PersonaVerdict {
  return parsePersonaVerdict(text);
}

// Re-export the verdict types so callers don't need to import from two paths.
export type { PersonaVerdict, RequirementVerdict };
