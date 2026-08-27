/**
 * orchestration/facts — t23 (§P1.E): cheap I/O inputs for the decision.
 *
 * chooseOrchestration itself stays PURE (no I/O, no env reads) — this module
 * is the only place that touches disk / the task-contract seam, and callers
 * inject its output into the pure classifier. Every collector fails soft:
 * on any error it returns `undefined` for that input (the table then treats
 * the fact as "unknown", never as an escalation reason).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskRisk } from '@zelari/core';
import { activeContractScope, type ActiveContractScope } from '../kraken/contractCompiler.js';
import type { OrchestrationPolicyOpts } from './policy.js';

/** Repos above this file count count as "large" (weak explore-signal only). */
export const LARGE_REPO_FILES = 800;

/** Bounded walk budget: stop counting after this many files. */
const MAX_WALK_FILES = 5_000;

/** Directories never descended into (dependency/vendor noise). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.zelari',
  '.venv',
]);

/**
 * Count workspace files with a bounded iterative walk (cheap, no deps).
 * `undefined` when the root is unreadable — unknown is not an error.
 */
export async function collectRepoFileCount(root: string = process.cwd()): Promise<number | undefined> {
  try {
    // The ROOT failing to read is "unknown repo"; a nested dir failing is
    // just skipped noise. Distinguish them honestly.
    await fs.readdir(root);
  } catch {
    return undefined;
  }
  try {
    let count = 0;
    const queue: string[] = [root];
    while (queue.length > 0 && count <= MAX_WALK_FILES) {
      const dir = queue.pop()!;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable subdir → skip silently
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) queue.push(path.join(dir, e.name));
        } else if (e.isFile()) {
          count++;
          if (count > MAX_WALK_FILES) return count;
        }
      }
    }
    return count;
  } catch {
    return undefined;
  }
}

export interface OrchestrationFacts {
  /** Active contract risk via the contractCompiler seam (undefined ⇒ none). */
  risk?: TaskRisk;
  /** Number of glob paths in the active contract scope (0 when absent). */
  scopePathsCount?: number;
  /** File-count of the workspace at dispatch time. */
  repoSize?: number;
  /**
   * Recent verification failures from the session spine. At --mode auto
   * dispatch time NO spine handle exists yet (it opens inside the hosts), so
   * callers pass 0 today. Documented limitation of P1.E — wiring a prior-turn
   * failure feed is future work, NOT silently skipped semantics.
   */
  previousFailures: number;
}

/**
 * Gather all v2 decision inputs in one place:
 * - risk/scope come from the ACTIVE TaskContract registered on the
 *   contractCompiler seam (`setActiveContractScope`, t22); headless turns
 *   start fresh per process, so usually undefined ⇒ neutral defaults apply
 *   inside the policy (medium-ish risk, no scope).
 * - repoSize from the bounded walk above.
 * - previousFailures is always 0 until a spine look-up is threaded through
 *   (see OrchestrationFacts.previousFailures note).
 */
export async function collectOrchestrationFacts(
  cwd: string = process.cwd(),
): Promise<OrchestrationFacts> {
  const scope: ActiveContractScope | undefined = safeActiveScope();
  const [repoSize] = await Promise.all([collectRepoFileCount(cwd)]);
  return {
    ...(scope?.contract.risk ? { risk: scope.contract.risk } : {}),
    ...(scope?.contract.scope
      ? {
          scopePathsCount:
            (scope.contract.scope.allowedPaths?.length ?? 0) +
            (scope.contract.scope.forbiddenPaths?.length ?? 0),
        }
      : {}),
    ...(repoSize !== undefined ? { repoSize } : {}),
    previousFailures: 0,
  };
}

function safeActiveScope(): ActiveContractScope | undefined {
  try {
    return activeContractScope();
  } catch {
    return undefined;
  }
}

/**
 * Telemetry: record the decision on the session spine as a state-only `note`
 * event (ADR-0021 vocabulary — `note` is existing, never model-surface, and
 * the tolerant replay invariant already ignores it). Adding a brand-new core
 * kind would require a schema review, so we REUSE `note` with a namespaced
 * payload: data.subject === 'orchestration_decision'.
 */
export function spineOrchestrationNote(
  handle: { note(text: string, data?: Record<string, unknown>): void },
  decision: { strategy: string; surface: string; confidence: number; rationaleCode: string; reason: string; estimatedLatencyMs: number },
): void {
  try {
    handle.note(`orchestration_decision ${decision.strategy}`, {
      subject: 'orchestration_decision',
      strategy: decision.strategy,
      surface: decision.surface,
      confidence: decision.confidence,
      rationaleCode: decision.rationaleCode,
      reason: decision.reason,
      estimatedLatencyMs: decision.estimatedLatencyMs,
    });
  } catch {
    // Degraded/disabled spine must NEVER break the run over telemetry.
  }
}

/** Re-export so tests/runHeadless can name the whole opts shape from here. */
export type FactsAsOpts = OrchestrationFacts & OrchestrationPolicyOpts;
