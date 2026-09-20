/**
 * WS7 slice 4b (t139) — how a HOST turns its session writer into the
 * `ToolContext.emitSessionEvent` sink the tool-side seams read.
 *
 * WHY this module exists: the seam was declared optional (toolTypes.ts) but no
 * runtime host ever populated it. Both real hosts build their tools through
 * `createBuiltinToolRegistry`, hand the registry to `AgentHarness`, and the
 * harness dispatches with `ToolRegistry.invoke(name, args, { cwd, sessionId,
 * signal })` — it never forwards a host sink into the invoke options
 * (AgentHarness.ts:839 and :1848). Every integration test passed because tests
 * hand-build a `ToolContext`. Consequence in production: ADR-0033 `file.*`
 * telemetry, WS1 `permission.denied` and the WS7 slice-4 decision emitters
 * were DORMANT, while only `verify.requested` (which rides the separately
 * bound verify-debt spine emit) was live.
 *
 * So the sink is populated one hop lower: `withSessionEventSink` decorates the
 * registered tool and fills `ctx.emitSessionEvent` from the host's own spine
 * writer before the tool body (or any wrapper above it) runs. No second writer
 * and no second vocabulary is introduced — the payloads and their validation
 * stay exactly where they were (`builtin/fileEvents.ts`, `decisionEmit.ts`);
 * this module only moves the SAME sink one hop closer to the host.
 *
 * Contract:
 *   - one sink TYPE, imported from `decisionEmit.ts` (`DecisionEventSink`) —
 *     identical to `ToolContext.emitSessionEvent` / `SpineEmit`, never
 *     re-declared here;
 *   - `lateSessionSink(holder)` is for hosts whose registry is built BEFORE the
 *     spine opens (headless `runOneTurn` builds the tools, then opens the
 *     spine): an unbound holder resolves to `undefined`, tools skip telemetry,
 *     and a miss can neither break a turn nor fabricate an event;
 *   - the decorator only INJECTS (`??=` semantics via a fresh ctx object): a
 *     ctx that already carries a sink — a test seam, or a host that passes the
 *     new `InvokeOptions.emitSessionEvent` (core registry.ts) — always wins.
 *
 * WIRED (slice 4b): the TUI single-agent turn (`useChatTurn` → dispatchPrompt,
 * the registry the harness dispatches) and the headless turn
 * (`headless/runOneTurn`) — including, via sink inheritance, every tentacle
 * registry the parent `task` tool builds.
 *
 * DELIBERATELY LEFT DORMANT (documented, not silently half-wired):
 *   - the kraken GRAPH executor path and its siblings — `/kraken graph`, the
 *     `--kraken-graph` headless executor, the CSV fanout handler and the
 *     gauntlet loop — build tentacle registries through
 *     `createKrakenSubAgentContextFactory` without a sink (see its opts doc);
 *   - the TUI council / zelari-build registries built in the same hook.
 * Both stay exactly as dormant as they are today until those hosts bind one.
 *
 * @since v2.56.0 (WS7 slice 4b / t139)
 */
import type { SessionEventInput } from '@zelari/core/session';
import type {
  ToolContext,
  ToolDefinition,
  TypedResult,
} from '@zelari/core/harness/tools/toolTypes';
import type { DecisionEventSink } from './decisionEmit.js';

/** Session-spine sink shape (ToolContext.emitSessionEvent / SpineEmit). */
export type SessionToolSink = DecisionEventSink;

/**
 * The structural half of a spine handle this module needs: `SessionSpineMirror`
 * (TUI) and `HeadlessSpineHandle` (headless) both satisfy it, and so does any
 * test double — the seq is a writer detail we simply forward.
 */
export interface SpineEventAppender {
  appendEvent(input: SessionEventInput): Promise<unknown>;
}

/**
 * Bind an OPEN spine to the tool sink. Same shape the hosts already use for
 * verify-debt (`bindVerifyDebtSpineEmit(async (input) => ({ seq: await
 * spine.appendEvent(input) }))`), so a replayed session sees one writer and
 * one monotonic seq sequence.
 */
export function spineSessionSink(spine: SpineEventAppender): SessionToolSink {
  return async (input) => ({ seq: await spine.appendEvent(input) });
}

/** Late-binding holder: `current` is assigned once the spine is open. */
export interface LateSessionSinkHolder {
  current?: SessionToolSink;
}

/**
 * Sink for a host that must build its registry first and bind the spine later.
 * Unbound ⇒ resolved `undefined`: the tools' `emitFileEvent`/`emitDecisionEvent`
 * helpers already treat a missing sink as "record nothing", so the window
 * before the binding is silent rather than lossy-with-a-lie.
 */
export function lateSessionSink(holder: LateSessionSinkHolder): SessionToolSink {
  return async (input) => {
    const bound = holder.current;
    return bound ? bound(input) : undefined;
  };
}

/**
 * Populate `ToolContext.emitSessionEvent` for one tool. Runs OUTSIDE every
 * other wrapper (it is applied last, over the registered definition), so the
 * permission gate, the sandbox, the jail preflight and the tool body all see
 * the sink. A caller-supplied sink is never overwritten.
 */
export function withSessionEventSink<I, O>(
  original: ToolDefinition<I, O>,
  sink: SessionToolSink,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: (input: I, ctx: ToolContext): Promise<TypedResult<O>> =>
      original.execute(input, ctx.emitSessionEvent ? ctx : { ...ctx, emitSessionEvent: sink }),
  };
}
