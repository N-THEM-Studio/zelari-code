/**
 * krakenSelectTool — `kraken_select`: compare this turn's candidate reports
 * and select the best-supported hypothesis (Fase 4, ADR-0020).
 *
 * Registered ONLY on the parent Kraken registry (toolRegistry gates it on
 * `krakenSelect: true` + full profile — tentacles and non-Kraken modes never
 * see it). The judging LLM call defaults to the EXACT parent provider/model
 * (see verifier.ts); a missing/failed verifier DEGRADES to
 * `needs_more_evidence` and the parent turn continues.
 *
 * Pure wiring: `loadParentIdentity` / `loadStream` are injected by
 * toolRegistry, so unit tests never touch provider config or the network.
 */

import { z } from 'zod';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { UsageBreakdown } from '@zelari/core/events';
import { recordSelectionOutcome } from '../kraken/metrics.js';
import {
  typedOk,
  typedErr,
  type ToolDefinition,
  type TypedResult,
} from '@zelari/core/harness/tools/toolTypes';
import {
  resolveKrakenVerifier,
  runKrakenSelection,
  type KrakenSelectionVerdict,
  type KrakenVerifierIdentity,
  type KrakenVerifierOverride,
} from '../kraken/verifier.js';
import {
  getKrakenSelection,
  krakenCandidates,
  setKrakenSelection,
} from '../kraken/candidateRegistry.js';

const KrakenSelectArgsSchema = z.object({
  task: z
    .string()
    .optional()
    .describe(
      'The user task being solved, in one or two sentences. Used to judge ' +
        'which candidate hypothesis best serves it. Omit to judge against ' +
        'the candidates alone.',
    ),
});

export interface KrakenSelectToolDeps {
  /** Resolve the PARENT run identity (provider+model) for verifier defaults. */
  loadParentIdentity: () => Promise<KrakenVerifierIdentity | null>;
  /** Build a provider stream for a provider id (null → unavailable). */
  loadStream: (provider: string) => Promise<ProviderStreamFn | null>;
  /** Env snapshot (tests). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Load the persisted verifier override (Fase 9 settings → provider.json
   * `krakenVerifier`). Absent/undefined → inherit the EXACT parent model
   * (env vars still apply — see resolveKrakenVerifier precedence).
   */
  loadVerifierOverride?: () => KrakenVerifierOverride | undefined;
  /** Verifier call timeout. Default 120s. */
  timeoutMs?: number;
}

/**
 * Consume a provider stream into plain text (single completion, no tools).
 * Captures provider-reported token usage when the stream emits a `usage`
 * delta (Fase 10 metrics — never approximated). Throws on error deltas —
 * runKrakenSelection degrades gracefully.
 */
export async function collectProviderText(
  stream: ProviderStreamFn,
  params: Parameters<ProviderStreamFn>[0],
): Promise<{ text: string; usage?: UsageBreakdown }> {
  let text = '';
  let usage: UsageBreakdown | undefined;
  for await (const delta of stream(params)) {
    if (delta.kind === 'text') text += delta.delta;
    else if (delta.kind === 'usage') usage = delta.usage;
    else if (delta.kind === 'error') throw new Error(delta.message);
    else if (delta.kind === 'finish') break;
    // 'thinking' / 'tool_call' — not part of the verdict text.
  }
  return { text, ...(usage ? { usage } : {}) };
}

function renderVerdict(
  verdict: KrakenSelectionVerdict,
  candidateCount: number,
): string {
  const header =
    verdict.status === 'selected' && verdict.winnerIndex !== null
      ? `kraken_select: SELECTED candidate #${verdict.winnerIndex}`
      : 'kraken_select: NEEDS MORE EVIDENCE — no candidate clearly wins';
  const lines = [header, `Rationale: ${verdict.rationale}`];
  if (verdict.requiredChecks.length > 0) {
    lines.push('Required checks (must pass before clean completion):');
    verdict.requiredChecks.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }
  if (verdict.degraded && verdict.fallbackReason) {
    lines.push(
      `NOTE (degraded): ${verdict.fallbackReason}. Proceed with your own ` +
        'judgment — the verifier could not decide.',
    );
  }
  lines.push(`Candidates compared: ${candidateCount}.`);
  return lines.join('\n');
}

/** Build the `kraken_select` tool from injected deps. */
export function createKrakenSelectTool(
  deps: KrakenSelectToolDeps,
): ToolDefinition<z.infer<typeof KrakenSelectArgsSchema>, { result: string }> {
  const timeoutMs = deps.timeoutMs ?? 120_000;
  return {
    name: 'kraken_select',
    description:
      'Compare the candidate research reports spawned this turn (task ' +
      'purpose=candidate) and select the hypothesis best supported by ' +
      'OBSERVED EVIDENCE. A dedicated verifier call (default: the current ' +
      'model) judges grounded vs unsupported claims; degraded observations ' +
      'are never treated as proof of absence. Returns the selected ' +
      'candidate, a rationale, and requiredChecks the implementation must ' +
      'pass. Call it ONCE per turn, after candidate tentacles finished and ' +
      'BEFORE implementing. If it reports needs_more_evidence, either spawn ' +
      'ONE more differentiated candidate or proceed with your own judgment.',
    permissions: ['read', 'network'],
    timeoutMs: 300_000,
    inputSchema: KrakenSelectArgsSchema,
    execute: async (
      input,
      _ctx,
    ): Promise<TypedResult<{ result: string }>> => {
      try {
        const candidates = krakenCandidates();
        if (candidates.length === 0) {
          return typedOk({
            result:
              'kraken_select: no candidates registered this turn — nothing ' +
              'to compare. Proceed directly (single-path execution).',
          });
        }

        const parent = await deps.loadParentIdentity();
        if (!parent) {
          const verdict: KrakenSelectionVerdict = {
            status: 'needs_more_evidence',
            winnerIndex: null,
            rationale:
              'Verifier unavailable (no provider identity for this run). ' +
              'Proceed with your own judgment.',
            requiredChecks: [],
            degraded: true,
            fallbackReason: 'parent identity unavailable',
            verifier: null,
            judgedBy: 'deterministic',
          };
          setKrakenSelection(verdict);
          return typedOk({ result: renderVerdict(verdict, candidates.length) });
        }

        const identity = resolveKrakenVerifier(
          parent,
          deps.env ?? process.env,
          deps.loadVerifierOverride?.(),
        );
        // Fase 10: real telemetry for the judging call (latency always,
        // tokens only when the provider reports them — never approximated).
        let judgingStartedAt = Date.now();
        let judgingUsage: UsageBreakdown | undefined;
        let judgingLatencyMs = 0;
        const verdict = await runKrakenSelection({
          task: input.task ?? '',
          candidates,
          identity,
          callModel: async ({ system, user, identity: id }) => {
            const stream = await deps.loadStream(id.provider);
            if (!stream) {
              throw new Error(`no provider config for verifier "${id.provider}"`);
            }
            judgingStartedAt = Date.now();
            try {
              const { text: raw, usage } = await collectProviderText(stream, {
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: user },
                ],
                model: id.model,
                provider: id.provider,
                tools: [],
                signal: AbortSignal.timeout(timeoutMs),
              });
              judgingUsage = usage;
              if (raw.trim().length === 0) throw new Error('empty verifier response');
              return raw;
            } finally {
              judgingLatencyMs = Date.now() - judgingStartedAt;
            }
          },
        });
        recordSelectionOutcome({
          latencyMs: judgingLatencyMs,
          ...(judgingUsage ? { tokens: judgingUsage.totalTokens } : {}),
          degraded: verdict.degraded,
          fallbackReason: verdict.fallbackReason,
        });
        setKrakenSelection(verdict);
        return typedOk({ result: renderVerdict(verdict, candidates.length) });
      } catch (err) {
        // Belt over braces: runKrakenSelection already degrades, but the
        // wiring itself (identity/stream resolution) must never kill a turn.
        return typedErr(
          `kraken_select: internal error — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}

/** Test/inspection helper: last verdict stored this turn (delegates). */
export function lastKrakenSelection(): KrakenSelectionVerdict | null {
  return getKrakenSelection();
}
