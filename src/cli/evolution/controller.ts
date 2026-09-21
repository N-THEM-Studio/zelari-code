/**
 * evolution/controller — Evolution Controller v0: SHADOW ONLY (ADR-0036).
 *
 * The controller is the piece that was missing between the WS7 slices: the
 * operator (tools/eval/operators/fuseEditVerify.ts) PROPOSES, the eval gate
 * JUDGES, and this module turns proposals into controller verdicts. In v0 the
 * only reachable actions are:
 *
 *   shadow — "report it": the proposal is valid evidence, nothing runs;
 *   hold   — "do not even report": unparsable, duplicate, under-evidenced,
 *            or the evolution surface is off (ZELARI_EVOLUTION != shadow).
 *
 * `canary` and `promote` DO NOT EXIST here on purpose. A promotion is a claim
 * on the future that only a signed PromotionReceipt (tools/eval/
 * promotionReceipt.ts, slice 1) can back; wiring that path is a later slice
 * and will arrive with its own gate. Fail-closed: anything the controller
 * cannot prove becomes `hold` with the reason spelled out — never a silent
 * pass (ADR-0023: unknown ≠ pass).
 *
 * Pure: no I/O, no clock, no env reads (the caller builds the policy — the
 * command layer reads ZELARI_EVOLUTION through evolution/ledger.ts so the
 * flag has exactly one spelling in the codebase).
 */
import { z } from 'zod';

/** The actions v0 can emit. Deliberately narrow: no canary, no promote. */
export const CONTROLLER_V0_ACTIONS = ['hold', 'shadow'] as const;
export type ControllerAction = (typeof CONTROLLER_V0_ACTIONS)[number];

/**
 * Structural mirror of the operator's FuseProposal (tools/eval/operators/
 * fuseEditVerify.ts). NOT imported from there on purpose: tools/eval is the
 * judge surface (ADR-0036 JUDGE_PATHS) written for `node --experimental-strip-
 * types` (`.ts` import specifiers) — importing it from src/cli would break the
 * tsc build. The mirror is validated with zod at the boundary, so a drifting
 * operator shape degrades to `hold: unparsable`, never to a wrong verdict.
 */
export const ControllerProposalSchema = z.object({
  kind: z.string().min(1),
  /** Spine identities of the calls the fused form would replace. */
  callIds: z.array(z.string().min(1)).min(1),
  /** Tool calls the fused form removes from the spine (counted, not modelled). */
  estSavedCalls: z.number().int().nonnegative(),
  /** Verifiable spine pointers (`{kind, ref}` — same shape the operator emits). */
  evidence: z.array(z.object({ kind: z.string().min(1), ref: z.string().min(1) })).min(1),
  /** The seq the proposal is anchored on (deterministic order + dedupe key). */
  decisiveSeq: z.number().int().positive(),
  path: z.string().optional(),
  tool: z.string().optional(),
  note: z.string().optional(),
});
export type ControllerProposal = z.infer<typeof ControllerProposalSchema>;

export interface ControllerPolicy {
  /** 'shadow' only when the caller resolved ZELARI_EVOLUTION=shadow; else '0'. */
  evolutionMode: '0' | 'shadow';
  /** Evidence entries a proposal must carry to be worth reporting. */
  minEvidence: number;
  /** Cap on verdicts per report (bounding the report itself). */
  maxVerdicts: number;
}

/** Conservative defaults: report nothing unless evolution is opted in. */
export const DEFAULT_CONTROLLER_POLICY: ControllerPolicy = {
  evolutionMode: '0',
  minEvidence: 3,
  maxVerdicts: 50,
};

export interface ControllerVerdict {
  action: ControllerAction;
  reason: string;
  /** Present only for parsable proposals (unparsable ones have nothing to show). */
  proposal?: ControllerProposal;
}

export interface ControllerSummary {
  total: number;
  shadow: number;
  hold: number;
  /** Estimated saved calls across SHADOW verdicts only (holds save nothing). */
  estSavedCalls: number;
}

/** One proposal → one verdict. `seenKeys` carries the dedupe set across calls. */
export function evaluateProposal(
  raw: unknown,
  policy: ControllerPolicy,
  seenKeys: Set<string>,
): ControllerVerdict {
  const parsed = ControllerProposalSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') ?? 'root';
    return { action: 'hold', reason: `unparsable proposal (${where}) — operator/controller shape drift` };
  }
  const proposal = parsed.data;
  if (policy.evolutionMode !== 'shadow') {
    return {
      action: 'hold',
      reason: 'ZELARI_EVOLUTION is not "shadow" — evolution surface off (ADR-0036 default-off)',
      proposal,
    };
  }
  const key = `${proposal.kind}:${proposal.decisiveSeq}`;
  if (seenKeys.has(key)) {
    return { action: 'hold', reason: `duplicate proposal (kind+decisiveSeq already verdicted)`, proposal };
  }
  if (proposal.evidence.length < policy.minEvidence) {
    return {
      action: 'hold',
      reason: `insufficient evidence (${proposal.evidence.length} < ${policy.minEvidence}) — a fusion claim needs the calls AND the boundary`,
      proposal,
    };
  }
  seenKeys.add(key);
  return { action: 'shadow', reason: 'v0 shadow: report-only, no runtime effect (apply is a later, gated slice)', proposal };
}

/** A batch of proposals → verdicts, capped by `policy.maxVerdicts`. */
export function evaluateProposals(
  proposals: readonly unknown[],
  policy: ControllerPolicy = DEFAULT_CONTROLLER_POLICY,
): ControllerVerdict[] {
  const seenKeys = new Set<string>();
  const verdicts: ControllerVerdict[] = [];
  for (const raw of proposals) {
    if (verdicts.length >= policy.maxVerdicts) break;
    verdicts.push(evaluateProposal(raw, policy, seenKeys));
  }
  return verdicts;
}

/** Deterministic summary for the report footer (and its tests). */
export function summarizeVerdicts(verdicts: readonly ControllerVerdict[]): ControllerSummary {
  let shadow = 0;
  let estSavedCalls = 0;
  for (const v of verdicts) {
    if (v.action === 'shadow') {
      shadow += 1;
      estSavedCalls += v.proposal?.estSavedCalls ?? 0;
    }
  }
  return { total: verdicts.length, shadow, hold: verdicts.length - shadow, estSavedCalls };
}
