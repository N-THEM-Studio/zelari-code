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
import { planTaskGraph } from '../kraken/planner.js';
import { loadGraphSnapshot, formatSnapshotForPlanner } from '../kraken/graphMemory.js';
import { KrakenGraphExecutor, isKrakenGraphEnabled } from '../kraken/executor.js';
import { formatKrakenGraphAscii, formatKrakenGraphDigest } from '../kraken/graphStatus.js';
import {
  getMemoryService,
  isMemoryAutoWriteEnabled,
  isMemoryV2Enabled,
} from '../memory/serviceFactory.js';

export interface KrakenGraphSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  cwd: string;
  sessionId: string;
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

  // W2 follow-up: this TUI path has no cheap spine handle
  // (KrakenGraphSlashContext carries no mirror), so memory telemetry stays
  // unwired here. The headless --kraken-graph path IS wired (runHeadless.ts).
  const memory = isMemoryV2Enabled()
    ? await getMemoryService(ctx.cwd, process.env, {
        onWarning: (warning) => appendSystem(ctx.setMessages, warning),
      })
    : undefined;

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
    const graph = await planTaskGraph({
      prompt,
      graphId: `kraken-${Date.now().toString(36)}`,
      cwd: ctx.cwd,
      ...(previousAttempt ? { previousAttempt } : {}),
    });
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
