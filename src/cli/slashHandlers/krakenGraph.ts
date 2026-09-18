/**
 * Slash handler for `/kraken graph <prompt>` (F6).
 *
 * Standalone entry point that plans a task DAG (F4 `planTaskGraph`) and
 * drives it to convergence (F3 `KrakenGraphExecutor`), printing the final
 * ASCII graph status (F5 `formatKrakenGraphAscii`) to the transcript. Kept
 * deliberately outside `useChatTurn.ts` (Correction 3 of the design doc):
 * this is a self-contained async function invoked directly from
 * `useSlashDispatch.ts`, the same shape as `/state`'s handlers.
 *
 * @since v0.10.x — Kraken graph engine (F6)
 */
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';
import { AuditLogger } from '../safety/auditLogger.js';
import { createKrakenSubAgentContextFactory } from '../toolRegistry.js';
import {
  planTaskGraph,
  isKrakenPlannerFallbackEnabled,
  plannerFallbackDigest,
} from '../kraken/planner.js';
import { loadGraphSnapshot, formatSnapshotForPlanner } from '../kraken/graphMemory.js';
import { KrakenGraphExecutor, isKrakenGraphEnabled } from '../kraken/executor.js';
import { formatKrakenGraphAscii, formatKrakenGraphDigest } from '../kraken/graphStatus.js';
import {
  getMemoryService,
  isMemoryAutoWriteEnabled,
  isMemoryV2Enabled,
} from '../memory/serviceFactory.js';
// W2: memory telemetry projected onto the session spine as state-only notes.
import { flushMemorySpineNotes, memorySinkFor, type LateBindingSpineHolder, type SpineNoteHandle } from '../memory/spineTelemetry.js';
import type { SpineMirroringWriter } from '../sessionSpine.js';

export interface KrakenGraphSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  cwd: string;
  sessionId: string;
  /**
   * W2: TUI session writer ref (optional — headless/test callers omit it).
   * When present, memory telemetry projects onto the session spine mirror.
   */
  writerRef?: React.MutableRefObject<SpineMirroringWriter | null>;
  /**
   * K3.4 / F17: the same-process degradation target. When the planner throws
   * and `ZELARI_KRAKEN_PLANNER_FALLBACK=1`, the host passes its ordinary
   * single-agent turn runner here instead of letting the handler report a
   * failure. Optional: without it the fallback is still announced (never
   * `graph run failed`) and the executor is never started.
   */
  fallbackToSingleAgent?: (prompt: string) => void | Promise<void>;
}

export async function handleKrakenGraph(
  ctx: KrakenGraphSlashContext,
  prompt: string,
): Promise<void> {
  if (!isKrakenGraphEnabled()) {
    appendSystem(
      ctx.setMessages,
      '[kraken] graph engine disabled (ZELARI_KRAKEN_GRAPH=0). Unset it to re-enable.',
    );
    return;
  }
  if (!prompt.trim()) {
    appendSystem(ctx.setMessages, 'Usage: /kraken graph <goal> — plans and runs a Kraken task graph');
    return;
  }

  appendSystem(ctx.setMessages, `[kraken] planning graph for: ${prompt.trim()}`);

  // W2: late-binding sink — the TUI spine mirror attaches per turn on the
  // session writer, so events resolve `ctx.writerRef?.current?.spine` at emit
  // time (same idiom as useChatTurn.ts). Missing ref → events are dropped.
  const tuiSpineHolder: LateBindingSpineHolder = {
    get current(): SpineNoteHandle | undefined {
      return ctx.writerRef?.current?.spine ?? undefined;
    },
  };
  const memory = isMemoryV2Enabled()
    ? await getMemoryService(ctx.cwd, process.env, {
        onWarning: (warning) => appendSystem(ctx.setMessages, warning),
        onEvent: memorySinkFor(tuiSpineHolder),
      })
    : undefined;
  // T4-S3: drain pre-attach buffered events if the session writer already
  // carries the spine mirror (explicit flush; no auto-flush later).
  flushMemorySpineNotes(tuiSpineHolder);

  const audit = new AuditLogger();
  const taskToolDeps = {
    createSubAgentContext: createKrakenSubAgentContextFactory({
      root: ctx.cwd,
      audit,
      sessionId: ctx.sessionId,
    }),
    ...(memory ? { memoryService: memory } : {}),
    memoryAutoWrite: isMemoryAutoWriteEnabled(),
  };

  try {
    const previous = await loadGraphSnapshot(ctx.cwd);
    const previousAttempt = formatSnapshotForPlanner(previous);
    if (previousAttempt) {
      appendSystem(ctx.setMessages, '[kraken] resuming from the previous unfinished graph');
    }
    // K3.4 / F17: ONLY the planner call is wrapped — an executor failure below
    // is not a planner failure and keeps the existing `graph run failed` line.
    let graph: Awaited<ReturnType<typeof planTaskGraph>>;
    try {
      graph = await planTaskGraph({
        prompt,
        graphId: `kraken-${Date.now().toString(36)}`,
        cwd: ctx.cwd,
        ...(previousAttempt ? { previousAttempt } : {}),
      });
    } catch (planErr) {
      if (!isKrakenPlannerFallbackEnabled()) throw planErr;
      const { reason, digest } = plannerFallbackDigest(planErr);
      // The spine may be absent (tests, detached writer): optional chain, same
      // idiom as the memory telemetry sink above.
      ctx.writerRef?.current?.spine?.note('kraken.planner_fallback', { reason, digest });
      appendSystem(
        ctx.setMessages,
        `[kraken] planner failed — falling back to single-agent (${digest})`,
      );
      // Host-owned single-agent turn; without the callback the message above is
      // still the honest report (never also `graph run failed`).
      await ctx.fallbackToSingleAgent?.(prompt);
      return;
    }
    appendSystem(ctx.setMessages, formatKrakenGraphAscii(graph));

    const executor = new KrakenGraphExecutor({
      taskToolDeps,
      parentCwd: ctx.cwd,
      sessionId: ctx.sessionId,
      goal: prompt,
    });
    const summary = await executor.execute(graph);

    const digest = formatKrakenGraphDigest(summary.graph, {
      durationsMs: summary.durationsMs,
      unresolvedFindings: summary.unresolvedFindings,
    });
    appendSystem(
      ctx.setMessages,
      `${formatKrakenGraphAscii(summary.graph)}\n\n${digest}\n\n` +
        (summary.converged
          ? '[kraken] graph converged.'
          : summary.cancelled
            ? '[kraken] graph cancelled.'
            : `[kraken] graph did not converge — failed: ${summary.failedNodeIds.join(', ') || 'none'}`),
    );
  } catch (err) {
    appendSystem(
      ctx.setMessages,
      `[kraken] graph run failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await memory?.close().catch(() => undefined);
  }
}
