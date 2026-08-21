/**
 * Persist a durable session.compacted range and optionally re-seed the
 * model history from the spine (compact the projection, never only RAM).
 */
import { createBrainEvent } from '@zelari/core';
import type { AgentMessage } from '@zelari/core/harness';
import {
  formatCompactionStateSnapshot,
  type CompactionStateSnapshot,
  type DerivedMessage,
} from '@zelari/core/session';
import type { BudgetPolicy } from './tokenBudget.js';
import { derivedModelSeed } from '../headlessSpine.js';

export interface CompactionTelemetry {
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  recompactionRate: number;
  summaryStrategy: 'extractive' | 'llm';
  provider?: string;
  model?: string;
}

export function compactEventPayload(
  budget: BudgetPolicy,
  stateSnapshot?: CompactionStateSnapshot | null,
  telemetry?: CompactionTelemetry,
): {
  summary: string;
  messagesRemoved: number;
  fromSeq?: number;
  toSeq?: number;
  checkpoint?: { role: 'user' | 'system'; content: string };
  strategy?: 'extractive' | 'llm';
  sourceEventSeqs?: number[];
  retainedCriterionIds?: string[];
  retainedEvidenceRefs?: CompactionStateSnapshot['retainedEvidenceRefs'];
  retainedState?: Record<string, unknown>;
  stateSnapshot?: CompactionStateSnapshot;
  inputTokens?: number;
  outputTokens?: number;
  savedTokens?: number;
  recompactionRate?: number;
  summaryStrategy?: 'extractive' | 'llm';
  provider?: string;
  model?: string;
} {
  const summary = budget.compactSummary ?? '';
  const first = budget.history[0];
  const narrative =
    first?.role === 'user' && first.content.includes('<compacted-summary>')
      ? first.content
      : summary;
  const checkpointContent = stateSnapshot
    ? formatCompactionStateSnapshot(stateSnapshot) + '\n\n' + narrative
    : narrative;
  const ranged =
    budget.compactedFromSeq !== undefined && budget.compactedToSeq !== undefined;
  return {
    summary,
    messagesRemoved: budget.messagesRemoved ?? 0,
    ...(telemetry ? { ...telemetry } : {}),
    ...(ranged
      ? {
          fromSeq: budget.compactedFromSeq,
          toSeq: budget.compactedToSeq,
          checkpoint: { role: 'user' as const, content: checkpointContent },
          ...(budget.compactStrategy ? { strategy: budget.compactStrategy } : {}),
          ...(budget.compactSourceSeqs && budget.compactSourceSeqs.length > 0
            ? { sourceEventSeqs: budget.compactSourceSeqs }
            : {}),
          ...(stateSnapshot
            ? {
                retainedCriterionIds: stateSnapshot.activeCriteria
                  .filter((criterion) => criterion.required)
                  .map((criterion) => criterion.id),
                retainedEvidenceRefs: stateSnapshot.retainedEvidenceRefs,
                retainedState: {
                  unresolvedIssueIds: stateSnapshot.unresolvedIssues.map((issue) => issue.id),
                  affectedFiles: stateSnapshot.affectedFiles,
                  ...(stateSnapshot.missionState?.phase
                    ? { missionStateRef: 'phase:' + stateSnapshot.missionState.phase }
                    : {}),
                },
                stateSnapshot,
              }
            : {}),
        }
      : {}),
  };
}

export function createSessionCompactedEvent(sessionId: string, budget: BudgetPolicy) {
  return createBrainEvent('session_compacted', sessionId, compactEventPayload(budget));
}

export async function reseedAfterDurableCompact(
  spine:
    | {
        status: string;
        derivedPriorTurns: () => Promise<DerivedMessage[] | null>;
      }
    | null
    | undefined,
  currentUserText: string,
): Promise<AgentMessage[] | null> {
  if (!spine || spine.status !== 'active') return null;
  const derived = await spine.derivedPriorTurns();
  if (!derived || derived.length === 0) return null;
  let seed = derivedModelSeed(derived);
  const last = seed[seed.length - 1];
  if (last?.role === 'user' && last.content === currentUserText) {
    seed = seed.slice(0, -1);
  }
  return seed;
}
