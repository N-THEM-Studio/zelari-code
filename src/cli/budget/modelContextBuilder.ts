/**
 * Host-neutral model context pipeline.
 *
 * derive session surface -> measure/prune/compact -> persist checkpoint ->
 * flush -> re-derive the exact durable surface sent to AgentHarness.
 */
import type {
  AgentMessage,
  AgentToolSpec,
  ProviderStreamFn,
} from '@zelari/core/harness';
import type {
  CompactionStateSnapshot,
  DerivedMessage,
} from '@zelari/core/session';
import type { WorkPhase } from '../phase.js';
import {
  applyBudgetPolicyAsync,
  estimateHistoryTokens,
  type BudgetPolicy,
  type BudgetPolicyEnvelope,
} from './tokenBudget.js';
import { measureRequest } from './requestMeter.js';
import {
  compactEventPayload,
  type CompactionTelemetry,
} from './persistCompact.js';
import { derivedModelSeed } from '../headlessSpine.js';
import { formatResourceSnapshot } from '@zelari/core/session';

export interface CompactionMetrics extends CompactionTelemetry {
  count: 1;
  restoreFailures: number;
}

function messageWasRecompacted(message: AgentMessage, history: readonly AgentMessage[]): boolean {
  if (message.compactedFromSeq === undefined) return false;
  return !history.some((candidate) => candidate.seq !== undefined && candidate.seq === message.seq);
}

/** RESOURCE STATUS system tail (doc §10.3) from the latest snapshot payload. */
function resourceStatusMessage(payload: object): AgentMessage {
  return { role: 'system', content: formatResourceSnapshot(payload as Record<string, unknown>) };
}

export type DurableCompactionPayload = ReturnType<typeof compactEventPayload>;

export interface ModelContextSession {
  status: string;
  derivedPriorTurns(): Promise<DerivedMessage[] | null>;
  flush?(): Promise<void>;
  compactionStateSnapshot?(toSeq: number): Promise<CompactionStateSnapshot | null>;
}

export interface ModelContextBuilderInput {
  fallbackHistory: readonly AgentMessage[];
  phase: WorkPhase;
  model?: string;
  provider?: string;
  systemMessages?: readonly AgentMessage[];
  tools?: readonly AgentToolSpec[];
  session?: ModelContextSession | null;
  sessionTokens?: number;
  sessionId?: string;
  signal?: AbortSignal;
  requestSnapshot?: BudgetPolicyEnvelope['requestSnapshot'];
  providerStream?: ProviderStreamFn;
  /** Latest resource snapshot (2.6 Track B) — rendered as RESOURCE STATUS. */
  resourceSnapshot?: object | null;
  /** Receives one record for each compaction attempt. */
  onCompactionMetric?: (metrics: CompactionMetrics) => void;
  /**
   * Host-owned persistence seam. TUI dual-writes a BrainEvent; headless
   * appends directly to the Session spine.
   */
  persistCompaction?: (payload: DurableCompactionPayload, budget: BudgetPolicy) => Promise<void>;
}

export interface ModelContextBuilderResult {
  history: AgentMessage[];
  budget: BudgetPolicy;
  source: 'session' | 'fallback';
  compactionMetrics?: CompactionMetrics;
  compactionPayload?: DurableCompactionPayload;
  durableCompaction: boolean;
  reconstructedFromSession: boolean;
}

async function sessionHistory(
  session: ModelContextSession | null | undefined,
): Promise<AgentMessage[] | null> {
  if (!session || session.status !== 'active') return null;
  const derived = await session.derivedPriorTurns();
  if (!derived || derived.length === 0) return null;
  return derivedModelSeed(derived);
}

/**
 * Build the model-visible conversation once for every host.
 *
 * Call before logging the current user message, so a post-compaction
 * re-derive contains prior turns only and no host-specific stripping is
 * required.
 */
export async function buildModelContext(
  input: ModelContextBuilderInput,
): Promise<ModelContextBuilderResult> {
  const derived = await sessionHistory(input.session);
  const source = derived ? 'session' as const : 'fallback' as const;
  const sourceHistory = derived ?? [...input.fallbackHistory];
  const inputTokens = estimateHistoryTokens(sourceHistory);
  const requestSurface =
    input.systemMessages || input.tools
      ? {
          provider: input.provider ?? 'local',
          model: input.model ?? 'unknown',
          systemMessages: input.systemMessages ?? [],
          tools: input.tools ?? [],
        }
      : null;

  let budget = await applyBudgetPolicyAsync(sourceHistory, input.phase, {
    model: input.model,
    sessionTokens: input.sessionTokens,
    sessionId: input.sessionId,
    signal: input.signal,
    requestSnapshot: input.requestSnapshot,
    requestSurface,
    providerStream: input.providerStream,
  });
  let history = budget.history;
  let compactionPayload: DurableCompactionPayload | undefined;
  let durableCompaction = false;
  let reconstructedFromSession = false;
  let compactionMetrics: CompactionMetrics | undefined;

  if ((budget.messagesRemoved ?? 0) > 0) {
    const ranged =
      budget.compactedFromSeq !== undefined &&
      budget.compactedToSeq !== undefined;
    const stateSnapshot =
      ranged && input.session?.compactionStateSnapshot
        ? await input.session.compactionStateSnapshot(budget.compactedToSeq!)
        : null;
    const outputTokens = estimateHistoryTokens(budget.history);
    const telemetry: CompactionTelemetry = {
      inputTokens,
      outputTokens,
      savedTokens: Math.max(0, inputTokens - outputTokens),
      recompactionRate: sourceHistory.some((message) =>
        messageWasRecompacted(message, budget.history)
      ) ? 1 : 0,
      summaryStrategy: budget.compactStrategy ?? 'extractive',
      ...(budget.compactStrategy === 'llm' && input.provider
        ? { provider: input.provider }
        : {}),
      ...(budget.compactStrategy === 'llm' && input.model ? { model: input.model } : {}),
    };
    compactionPayload = compactEventPayload(budget, stateSnapshot, telemetry);
    if (input.persistCompaction) {
      await input.persistCompaction(compactionPayload, budget);
      await input.session?.flush?.();
      if (ranged && input.session?.status === 'active') {
        const replayed = await sessionHistory(input.session);
        if (replayed) {
          history = replayed;
          durableCompaction = true;
          reconstructedFromSession = true;
        }
      }
    }
    compactionMetrics = {
      count: 1,
      ...telemetry,
      restoreFailures:
        ranged && input.persistCompaction && !reconstructedFromSession ? 1 : 0,
    };
    input.onCompactionMetric?.(compactionMetrics);
  }

  // 2.6 Track B (doc §10.3) / 2.6.1 fix (closure plan §12): the durable
  // `resource.snapshot` event is the ONLY model surface (ADR-0016 invariant:
  // model-visible ⟺ logged) — deriveMessages projects the LATEST snapshot as
  // one system message. Append a tail ONLY when no durable snapshot is in the
  // history (fallback history, or a spine replay predating budget tracking).
  // Exactly one RESOURCE STATUS may ever reach the provider.
  if (
    input.resourceSnapshot &&
    !history.some(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('RESOURCE STATUS'),
    )
  ) {
    history = [...history, resourceStatusMessage(input.resourceSnapshot)];
  }

  if (requestSurface) {
    const measured = measureRequest({
      systemMessages: requestSurface.systemMessages,
      tools: requestSurface.tools,
      conversation: history,
      anchor: input.requestSnapshot,
      contextLimit: budget.contextLimit,
      reservedOutputTokens: 8_192,
    });
    budget = {
      ...budget,
      history,
      estimatedHistoryTokens: estimateHistoryTokens(history),
      occupancy: measured.occupancy,
      contextPressureTokens: measured.contextPressureTokens,
    };
  } else {
    const estimated = estimateHistoryTokens(history);
    budget = {
      ...budget,
      history,
      estimatedHistoryTokens: estimated,
      occupancy: Math.min(1, estimated / budget.contextLimit),
    };
  }

  return {
    history,
    budget,
    source,
    ...(compactionPayload ? { compactionPayload } : {}),
    ...(compactionMetrics ? { compactionMetrics } : {}),
    durableCompaction,
    reconstructedFromSession,
  };
}
