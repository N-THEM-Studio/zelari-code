/**
 * Headless entry for the Gauntlet host loop (BUILD kraken path).
 */
import { AgentHarness } from '@zelari/core/harness';
import type { HeadlessOptions } from '../headless.js';
import { emitEvent } from '../headless.js';
import { openHeadlessSpine, seedHeadlessModelHistory, sessionStartedEvent } from '../headlessSpine.js';
import { AuditLogger } from '../safety/auditLogger.js';
import { createKrakenSubAgentContextFactory } from '../toolRegistry.js';
import {
  runTentacle,
  type TaskToolDeps,
} from '../tools/taskTool.js';
import { gauntletComplete } from './complete.js';
import { decomposeGoal, formatHistoryNote } from './decompose.js';
import { gauntletProgressEvent } from './events.js';
import { runGauntletLoop } from './loop.js';
import { resolveGauntletCaps } from './policy.js';
import { buildWorkspaceSummary } from '../workspace/workspaceSummary.js';

export async function runHeadlessGauntlet(
  opts: HeadlessOptions,
  provider: string,
  model: string,
): Promise<number> {
  const sessionId = opts.resumeSessionId ?? crypto.randomUUID();
  const spine = await openHeadlessSpine({
    sessionId,
    mode: opts.mode,
    profile: opts.profile,
    workspace: process.cwd(),
  });
  emitEvent(sessionStartedEvent(spine));
  const seeded = await seedHeadlessModelHistory(spine, opts.history);
  if (opts.task) spine.userMessage(opts.task);
  spine.note('gauntlet.start', { goal: opts.task.slice(0, 200) });

  const abort = new AbortController();
  const onSigint = (): void => {
    emitEvent({ type: 'log', message: '[gauntlet] SIGINT — cancelling' });
    abort.abort();
  };
  process.once('SIGINT', onSigint);
  const wallMs = resolveGauntletCaps().wallClockMs ?? 0;
  const wallTimer =
    wallMs > 0
      ? setTimeout(() => {
          emitEvent({ type: 'log', message: '[gauntlet] wall clock — aborting tentacles' });
          abort.abort();
        }, wallMs)
      : undefined;

  const cwd = process.cwd();
  const audit = new AuditLogger();
  const createSubAgentContext = createKrakenSubAgentContextFactory({
    root: cwd,
    audit,
    sessionId,
    provider,
    model,
  });
  const deps: TaskToolDeps = {
    createSubAgentContext,
    allowWorktree: false,
    harnessFactory: (config) => {
      const harness = new AgentHarness(config);
      return {
        async *run() {
          for await (const ev of harness.run()) {
            if (
              ev.type === 'thinking_delta' ||
              ev.type === 'tool_execution_start' ||
              ev.type === 'tool_execution_end'
            ) {
              emitEvent(ev);
              spine.observe(ev);
            }
            yield ev;
          }
        },
        cancel: () => harness.cancel(),
      };
    },
  };

  const emit = (event: Record<string, unknown>): void => {
    if (opts.output === 'json') emitEvent(event);
    else if (typeof event.message === 'string') {
      process.stderr.write(`${event.message}\n`);
    }
  };

  emitEvent({ type: 'agent_start', model, provider, role: 'gauntlet' });
  emit({ type: 'log', message: '[gauntlet] host loop — builder/critic rounds, parent cannot write' });

  const caps = resolveGauntletCaps();
  const workspace = buildWorkspaceSummary(cwd, { maxChars: 2500 });
  const historyNote = formatHistoryNote(seeded.history);
  emitEvent(
    gauntletProgressEvent(sessionId, {
      phase: 'decomposing',
      pieceId: '',
      pieceLabel: 'Goal',
      pieceIndex: 0,
      pieceCount: 1,
      round: 0,
      maxRounds: caps.maxRounds,
      elapsedMs: 0,
    }),
  );

  try {
    const decomposed = await decomposeGoal({
      goal: opts.task,
      maxPieces: caps.maxPieces,
      workspace,
      historyNote,
      complete: (req) => gauntletComplete(req, { provider, model, signal: abort.signal }),
    });
    spine.note('gauntlet.decompose', {
      source: decomposed.source,
      count: decomposed.pieces.length,
      ...(decomposed.error ? { error: decomposed.error.slice(0, 240) } : {}),
    });
    emit({
      type: 'log',
      message: `[gauntlet] ${decomposed.pieces.length} piece(s) from ${decomposed.source}${
        decomposed.error ? ` (${decomposed.error.slice(0, 80)})` : ''
      }`,
    });

    const result = await runGauntletLoop({
      pieces: decomposed.pieces,
      caps,
      deps: {
        sessionId,
        signal: abort.signal,
        emit,
        briefing: workspace.slice(0, 1200),
        note: (text, data) => spine.note(text, data),
        runBuilder: async ({ piece, prompt, round }) => {
          emit({
            type: 'log',
            message: `[gauntlet] ${piece.id} round ${round}/${caps.maxRounds} builder`,
          });
          const tent = await runTentacle({
            deps,
            agent: 'general',
            thoroughness: 'medium',
            parentCwd: cwd,
            sessionId,
            signal: abort.signal,
            args: {
              description: `gauntlet-builder ${piece.id} r${round}`,
              prompt,
              ...(piece.scope ? { scope: piece.scope } : {}),
              ...(piece.acceptance.length > 0 ? { acceptance: piece.acceptance } : {}),
            },
          });
          if (!tent.ok) return { ok: false, result: '', error: tent.error };
          return {
            ok: true,
            result: tent.result,
            toolTraceCount: tent.toolTrace?.length ?? 0,
          };
        },
        runCritic: async ({ piece, prompt, systemPrompt, round }) => {
          emit({
            type: 'log',
            message: `[gauntlet] ${piece.id} round ${round}/${caps.maxRounds} critic`,
          });
          const tent = await runTentacle({
            deps,
            agent: 'verify',
            thoroughness: 'medium',
            parentCwd: cwd,
            sessionId,
            signal: abort.signal,
            systemPromptOverride: systemPrompt,
            args: {
              description: `gauntlet-critic ${piece.id} r${round}`,
              prompt,
              ...(piece.scope ? { scope: piece.scope } : {}),
              ...(piece.acceptance.length > 0 ? { acceptance: piece.acceptance } : {}),
            },
          });
          if (!tent.ok) {
            return { ok: false, result: tent.error, error: tent.error, toolTraceCount: 0 };
          }
          return {
            ok: true,
            result: tent.result,
            toolTraceCount: tent.toolTrace?.length ?? 0,
          };
        },
      },
    });

    emitEvent({ type: 'message_start', role: 'assistant' });
    emitEvent({ type: 'message_delta', delta: result.summary });
    emitEvent({ type: 'message_end', totalLength: result.summary.length });
    emitEvent({
      type: 'agent_end',
      reason: result.cancelled || result.timedOut
        ? 'cancelled'
        : result.settled
          ? 'completed'
          : 'error',
    });
    if (result.timedOut) {
      emit({ type: 'log', message: `[gauntlet] wall clock (${Math.round(wallMs / 60000)}m)` });
      await spine.interrupt('gauntlet-wall-clock');
      return 1;
    }
    if (result.cancelled) {
      await spine.interrupt('gauntlet-cancelled');
      return 1;
    }
    await spine.close(result.settled ? 'gauntlet-pass' : 'gauntlet-incomplete');
    return result.settled ? 0 : 3;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitEvent({ type: 'error', severity: 'fatal', message: msg, code: 'gauntlet' });
    await spine.interrupt(`gauntlet-error: ${msg}`).catch(() => undefined);
    return 2;
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    process.removeListener('SIGINT', onSigint);
  }
}
