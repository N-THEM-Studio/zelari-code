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
import { KrakenGraphExecutor, isKrakenGraphEnabled } from '../kraken/executor.js';
import { formatKrakenGraphAscii } from '../kraken/graphStatus.js';

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

  const audit = new AuditLogger();
  const taskToolDeps = {
    createSubAgentContext: createKrakenSubAgentContextFactory({
      root: ctx.cwd,
      audit,
      sessionId: ctx.sessionId,
    }),
  };

  try {
    const graph = await planTaskGraph({ prompt, graphId: `kraken-${Date.now().toString(36)}` });
    appendSystem(ctx.setMessages, formatKrakenGraphAscii(graph));

    const executor = new KrakenGraphExecutor({
      taskToolDeps,
      parentCwd: ctx.cwd,
      sessionId: ctx.sessionId,
    });
    const summary = await executor.execute(graph);

    appendSystem(
      ctx.setMessages,
      `${formatKrakenGraphAscii(summary.graph)}\n\n` +
        (summary.converged
          ? '[kraken] graph converged.'
          : `[kraken] graph did not converge — failed: ${summary.failedNodeIds.join(', ') || 'none'}`),
    );
  } catch (err) {
    appendSystem(
      ctx.setMessages,
      `[kraken] graph run failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
