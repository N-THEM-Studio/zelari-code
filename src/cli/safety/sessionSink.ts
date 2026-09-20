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
 * WIRED (slice 4c — the graph/council residual, THIS change): the graph host
 * binds the SAME spine to the tentacle registries its node turns run
 * (`createKrakenSubAgentContextFactory({ sessionEventSink })`, in
 * `runHeadlessKrakenGraph`) and the council host binds it to the member
 * registry `dispatchCouncil` hands `runCouncilPure` (so every member's tool
 * dispatch — council and mission slices alike — emits on the parent spine).
 * Those two bindings are BOUNDED (`boundedSessionSink`) and kill-switchable
 * (`SESSION_SINK_ENV`): a graph run turns one host envelope into dozens of
 * node turns, so the allowed set is the decision/verify/file-write telemetry
 * only — a node's turn internals (tool.call/tool.result, assistant text, file
 * reads) never reach the spine. ADR-0024 (amendment v1.3) records the bound.
 *
 * STILL DELIBERATELY DORMANT (documented, not silently half-wired):
 *   - the TUI council / zelari-build registries built in `useChatTurn` (they
 *     call `dispatchCouncil` without a sink — the hook is outside this
 *     change's allowlist; the seam is ready, the caller is not converted);
 *   - `/kraken graph`, the CSV fanout slash handler and the gauntlet loop,
 *     which build tentacle registries through
 *     `createKrakenSubAgentContextFactory` without a sink (see its opts doc).
 *
 * @since v2.56.0 (WS7 slice 4b / t139)
 */
import { DECISION_PROJECTION_KINDS, type SessionEventInput } from '@zelari/core/session';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
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

/**
 * Populate `ToolContext.emitSessionEvent` for EVERY tool of an
 * already-built registry — the binding a host applies to a registry it did
 * not build through `createBuiltinToolRegistry`'s `sessionEventSink` option
 * (the council member registry `dispatchCouncil` hands to `runCouncilPure`).
 *
 * Re-registering an existing name keeps that name's position (the registry is
 * a Map), so `list()` / `toOpenAITools()` order — i.e. the tool-schema array
 * and its byte-identical prompt-cache prefix — is UNCHANGED. Idempotent and
 * order-independent: `withSessionEventSink` never overwrites a ctx that
 * already carries a sink, so binding twice is a no-op at dispatch time.
 *
 * Returns how many definitions were bound (observability for callers/tests).
 */
export function bindSessionSinkToRegistry(
  registry: ToolRegistry,
  sink: SessionToolSink,
): number {
  let bound = 0;
  for (const name of registry.list()) {
    const def = registry.get(name);
    if (!def) continue;
    registry.register(withSessionEventSink(def, sink));
    bound++;
  }
  return bound;
}

/**
 * Host-binding kill switch: `ZELARI_GRAPH_SPINE_SINK=0` disables the graph/
 * council binding entirely (default ON). Same grammar as the other opt-outs
 * (`ZELARI_KRAKEN_WORKTREE`): absence is fail-open, ONLY the literal `0` (after
 * trim) turns the binding off, so a typo can never silently drop a run's
 * decision telemetry, and an operator debugging spine noise has one exact
 * escape hatch.
 */
export const SESSION_SINK_ENV = 'ZELARI_GRAPH_SPINE_SINK';

export function sessionSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[SESSION_SINK_ENV] ?? '').trim() !== '0';
}

/**
 * The BOUNDED event set a graph/council binding may carry (spine noise control):
 * the decision family core already declares (`DECISION_PROJECTION_KINDS` — the
 * five slice-2 kinds plus WS1 `permission.denied`, which core files under the
 * same question), the verify-debt pair, and the WRITE-path file events.
 *
 * Deliberately NOT here: `file.read` — a graph node reads far more than it
 * writes, so read telemetry would drown the host's own envelope events — and
 * anything `tool.call`/`tool.result`-shaped: a node's turn internals stay on
 * the kraken radio channel (ADR-0024 v1.1/v1.2), correlated by `sessionId`.
 */
export const BOUNDED_SESSION_SINK_KINDS: ReadonlySet<string> = new Set<string>([
  ...DECISION_PROJECTION_KINDS,
  'verify.debt_open',
  'verify.debt_cleared',
  'file.applied',
  'file.rejected',
]);

/** Keep only the kinds above; everything else is dropped, never written. */
export function boundedSessionSink(sink: SessionToolSink): SessionToolSink {
  return async (input) =>
    BOUNDED_SESSION_SINK_KINDS.has(input.kind) ? sink(input) : undefined;
}

/**
 * The ONE call a graph/council host makes: its own open spine → the bounded,
 * kill-switchable tool sink the node/member registries receive. `undefined`
 * means "binding off" (`ZELARI_GRAPH_SPINE_SINK=0`), which callers forward as
 * an absent option so the registry stays byte-identical to the dormant build.
 */
export function hostSessionSink(
  spine: SpineEventAppender,
  env: NodeJS.ProcessEnv = process.env,
): SessionToolSink | undefined {
  if (!sessionSinkEnabled(env)) return undefined;
  return boundedSessionSink(spineSessionSink(spine));
}
