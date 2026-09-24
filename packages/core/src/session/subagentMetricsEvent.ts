/**
 * session/subagentMetricsEvent.ts — t159 (P2a-2): per-tentacle metrics, durable.
 *
 * WHY: the sub-agent loop already MEASURES (t156/P2a-1: provider-reported usage
 * summed across turns, uncapped tool executions, completed assistant turns) and
 * the parent already renders those numbers in one honest footer line. A footer
 * dies with the turn; the spine is durability. `subagent.metrics` is the event a
 * later replay asks of a past run — "what did this tentacle cost, how much did
 * it actually do, and did it stop on the loop guard?".
 *
 * ADDITIVE-ONLY (the P2a-2 stop rule): the kind is APPENDED to
 * SESSION_EVENT_KINDS and `SESSION_SCHEMA_VERSION` stays unchanged (ADR-0021:
 * additive state kinds need no bump — an older reader reports `schema-mismatch`,
 * skips the line through the tolerant replay in replay.ts, and still replays the
 * rest of the spine). A bump is NOT authorized by this slice, and that is not a
 * comment: `SUBAGENT_METRICS_SINCE_SCHEMA_VERSION` pins the schema generation
 * that declared the kind, and the test suite fails loudly the moment the shared
 * const moves away from it — the stop rule, encoded instead of promised.
 *
 * STATE-ONLY (P1): metrics record what the harness did, they never feed the
 * model loop, so this kind must never join MODEL_SURFACE_KINDS.
 *
 * HONESTY (same rules as the footer formatter `src/cli/tools/subagentMetrics.ts`):
 * never fabricate. `usage` appears only when the provider reported it — a run
 * with no reported usage carries NO `usage` key, not zeros; `cachedPromptTokens`
 * appears only when > 0; `turns`/`toolCalls` only when the loop counted them.
 * A payload with no usage is still a valid event (ok + kind + duration).
 *
 * FAIL-OPEN: emission is best-effort. No sink (a host without a session) records
 * nothing, a throwing sink is caught, and a schema generation below the kind's
 * own returns `recorded:false` — recording metrics can never fail, delay or
 * mutate the tentacle it is recording.
 *
 * Data contract (envelope `kind='subagent.metrics'`; `data` as built below):
 *   {kind, ok, thoroughness?, model?, agentId?, turns?, toolCalls?, toolErrors?,
 *    durationMs?, degenerate?, toolsDegraded?, worktree?, usage?{promptTokens,
 *    completionTokens, totalTokens, cachedPromptTokens?}}
 * `toolErrors`/`toolsDegraded` (additive, F4 2026-09-24): failed tool
 * executions and the tool-channel degradation flag — an `ok:true` tentacle
 * whose tools mostly failed is no longer indistinguishable from a clean run.
 * `data.kind` is the TENTACLE kind (`explore`/`general`/`verify`) — the envelope
 * owns the event kind, this field owns the sub-agent kind (t159 payload spec).
 * No PII beyond the model id: no prompts, no file paths outside the worktree.
 */
import { SESSION_SCHEMA_VERSION, type SessionActor, type SessionEventInput } from './types.js';

/** Envelope kind of the event (appended to SESSION_EVENT_KINDS in types.ts). */
export const SUBAGENT_METRICS_KIND = 'subagent.metrics' as const;

/**
 * The spine schema generation that DECLARED `subagent.metrics`. Literal on
 * purpose (never `= SESSION_SCHEMA_VERSION`): if the shared const is bumped, the
 * stop-rule test fails and a human decides — either the kind survives the new
 * vocabulary as-is, or it is re-declared under the new generation. Emission is
 * gated on this, so a reader/writer pinned to an OLDER generation emits nothing
 * instead of writing a shape that generation never promised.
 */
export const SUBAGENT_METRICS_SINCE_SCHEMA_VERSION = 1;

/** True when a spine of `schemaVersion` knows this event (tolerant the other way). */
export function subagentMetricsKindSupported(schemaVersion: number): boolean {
  return (
    Number.isFinite(schemaVersion) && schemaVersion >= SUBAGENT_METRICS_SINCE_SCHEMA_VERSION
  );
}

/** The harness records its OWN measurement: never attributed to the model. */
export const SUBAGENT_METRICS_ACTOR: SessionActor = { type: 'system', role: 'metrics' };

/** Provider-reported token usage (structural twin of `UsageBreakdown`). */
export interface SubagentMetricsUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Subset of `promptTokens` served from the provider cache; omitted when none. */
  cachedPromptTokens?: number;
}

/** Everything a terminal tentacle can honestly report about itself. */
export interface SubagentMetricsEventInput {
  /** Tentacle kind (`explore`/`general`/`verify`) — see the header note. */
  kind: string;
  /** True for a successful run, false for every terminal failure. */
  ok: boolean;
  thoroughness?: string;
  /** Model the sub-agent actually ran on. */
  model?: string;
  /** Live activity row id (the same id the agent_* BrainEvents carry). */
  agentId?: string;
  /** Completed assistant messages in the sub-agent loop. */
  turns?: number;
  /** TOTAL tool executions observed (uncapped — not the ring-capped trace). */
  toolCalls?: number;
  /** Tool executions that ended in error (uncapped, subset of `toolCalls`). */
  toolErrors?: number;
  usage?: SubagentMetricsUsage;
  durationMs?: number;
  /** t157: the run stopped on the cross-turn degenerate-loop guard. */
  degenerate?: boolean;
  /** F4: most tool executions failed — the report rests on a broken tool channel. */
  toolsDegraded?: boolean;
  /** Git worktree the tentacle ran in, when it was isolated. */
  worktree?: string;
}

/** Recorded payload — same fields, every present value finite and >= 0. */
export interface SubagentMetricsEventPayload {
  kind: string;
  ok: boolean;
  thoroughness?: string;
  model?: string;
  agentId?: string;
  turns?: number;
  toolCalls?: number;
  toolErrors?: number;
  durationMs?: number;
  degenerate?: boolean;
  toolsDegraded?: boolean;
  worktree?: string;
  usage?: SubagentMetricsUsage;
}

export type SubagentMetricsSink = (input: SessionEventInput) => Promise<unknown>;

export interface SubagentMetricsEmitResult {
  recorded: boolean;
  /** Writer-assigned seq, when the sink echoed one. */
  seq?: number;
  /** Why nothing was written (no sink is NOT an error — it is an absent spine). */
  error?: string;
}

/** A finite, non-negative number, else undefined — a wrong type is dropped, not coerced. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Integer counts only: a fractional "turn" would be a measurement bug, not data. */
function count(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** A non-empty string, else undefined (empty strings are absent, never recorded). */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Usage is ALL-OR-NOTHING: a partial triple would be an approximation wearing
 * exact numbers' clothes, so it degrades to "the provider reported nothing".
 */
function usageOf(value: SubagentMetricsUsage | undefined): SubagentMetricsUsage | undefined {
  if (!value) return undefined;
  const promptTokens = count(value.promptTokens);
  const completionTokens = count(value.completionTokens);
  const totalTokens = count(value.totalTokens);
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  const cached = count(value.cachedPromptTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    // Honest absence: a provider that cached nothing reports no cached field.
    ...(cached !== undefined && cached > 0 ? { cachedPromptTokens: cached } : {}),
  };
}

/**
 * Build the payload. Pure and shape-only: absent stays absent (no key at all),
 * invalid values are DROPPED rather than coerced — a replay must never read a
 * number this process invented.
 */
export function buildSubagentMetricsPayload(
  input: SubagentMetricsEventInput,
): SubagentMetricsEventPayload {
  const usage = usageOf(input.usage);
  const turns = count(input.turns);
  const toolCalls = count(input.toolCalls);
  const toolErrors = count(input.toolErrors);
  const durationMs = num(input.durationMs);
  const thoroughness = str(input.thoroughness);
  const model = str(input.model);
  const agentId = str(input.agentId);
  const worktree = str(input.worktree);
  return {
    kind: str(input.kind) ?? 'unknown',
    ok: input.ok,
    ...(thoroughness !== undefined ? { thoroughness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolErrors !== undefined && toolErrors > 0 ? { toolErrors } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input.degenerate === true ? { degenerate: true } : {}),
    ...(input.toolsDegraded === true ? { toolsDegraded: true } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
  };
}

function seqFrom(result: unknown): number | undefined {
  const raw =
    result !== null && typeof result === 'object' && 'seq' in result
      ? (result as { seq: unknown }).seq
      : undefined;
  const seq = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(seq) && seq > 0 ? seq : undefined;
}

/**
 * Append one metrics event, best-effort. Returns what actually happened; it
 * never throws and never blocks a caller's failure path.
 */
export async function emitSubagentMetrics(
  sink: SubagentMetricsSink | undefined,
  payload: SubagentMetricsEventPayload,
  opts: { schemaVersion?: number } = {},
): Promise<SubagentMetricsEmitResult> {
  const version = opts.schemaVersion ?? SESSION_SCHEMA_VERSION;
  // Stop rule: a generation older than the kind's own writes nothing (its
  // vocabulary never promised this event) — no sink is even touched.
  if (!subagentMetricsKindSupported(version)) {
    return {
      recorded: false,
      error: `${SUBAGENT_METRICS_KIND} requires spine schema v${SUBAGENT_METRICS_SINCE_SCHEMA_VERSION} (got v${version})`,
    };
  }
  if (!sink) return { recorded: false };
  try {
    // Spread into an open record: the envelope's `data` is `Record<string, unknown>`
    // and a future field must be addable without touching the interface.
    const data: Record<string, unknown> = { ...payload };
    const result = await sink({
      kind: SUBAGENT_METRICS_KIND,
      actor: SUBAGENT_METRICS_ACTOR,
      data,
    });
    const seq = seqFrom(result);
    return seq !== undefined ? { recorded: true, seq } : { recorded: true };
  } catch (error) {
    return { recorded: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One metrics record, as a reader sees it — every absent field stays absent. */
export interface SubagentMetricsRecord extends SubagentMetricsEventPayload {
  ok: boolean;
  degenerate: boolean;
}

/**
 * Defensive reader (same discipline as `parseDecisionEvent`): a hand-edited or
 * half-written payload yields what it actually carried, never a throw and never
 * an invented value. `null` means "this data is not a metrics payload at all"
 * (a replay consumer must skip it, not guess).
 */
export function readSubagentMetricsEvent(
  data: Record<string, unknown> | null | undefined,
): SubagentMetricsRecord | null {
  if (!data || typeof data !== 'object') return null;
  const rawUsage = data.usage;
  const usage =
    rawUsage !== null && typeof rawUsage === 'object'
      ? usageOf(rawUsage as SubagentMetricsUsage)
      : undefined;
  const turns = count(data.turns);
  const toolCalls = count(data.toolCalls);
  const toolErrors = count(data.toolErrors);
  const durationMs = num(data.durationMs);
  const thoroughness = str(data.thoroughness);
  const model = str(data.model);
  const agentId = str(data.agentId);
  const worktree = str(data.worktree);
  return {
    kind: str(data.kind) ?? 'unknown',
    ok: data.ok === true,
    degenerate: data.degenerate === true,
    ...(thoroughness !== undefined ? { thoroughness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolErrors !== undefined && toolErrors > 0 ? { toolErrors } : {}),
    ...(data.toolsDegraded === true ? { toolsDegraded: true } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
  };
}
