/**
 * verificationBridge — adapts the 1.x Kraken check registry onto the 2.0
 * deterministic evidence contract (ADR-0023), and enforces ZELARI_STRICT_DONE.
 *
 * The legacy completion gate (completionGate.ts) already implements
 * `unknown ≠ pass` over verify-report blocks. This bridge additionally maps
 * those results onto Criterion/VerificationResult and runs the strict
 * CompletionPolicy, where "pass without evidence" is ALSO blockable — the
 * false-done guarantee the 2.0 contract adds on top.
 *
 * Composition rule: the strict verdict can only ADD blockers, never remove
 * them. A legacy-blocked turn stays blocked; a legacy-open turn can become
 * blocked only when strict evaluation is enabled AND the evidence contract
 * is not satisfied.
 *
 * F2 (Exit-2.4): when the native criteria pack is enabled
 * (ZELARI_VERIFY_PACK=1), the Zelari Coding Criteria Pack v1 joins the SAME
 * CompletionPolicy evaluation with real deterministic checks (typecheck/
 * test/build commands) executed through the core VerificationEngine —
 * see nativeVerification.ts. The pack is additive evidence; it can only add
 * blockers, never remove them, exactly like the rest of the strict layer.
 */
import { createHash } from 'node:crypto';
import { getKrakenCheckResults, krakenRequiredChecks, getLastVerifyToolTrace } from './candidateRegistry.js';
import { evaluateKrakenCompletionGate, type KrakenCompletionGate } from './completionGate.js';
import type { KrakenCheckResult, TentacleToolTrace } from './verifyReport.js';
import { evaluateNativePack, nativePackEnabled, type NativePackEvaluation } from './nativeVerification.js';
// t22: TaskContract → compiler (capability rules + verification criteria).
import {
  activeContractScope,
  evaluateContractCriteria,
  compileVerificationCriteria,
  type ContractCriteriaEvaluation,
} from './contractCompiler.js';
import type { ShellProvider } from '@zelari/core/runtime';
import type { SessionEventInput } from '@zelari/core/session';
import {
  evaluateCompletion,
  STRICT_BUILD_POLICY,
  type CompletionEvaluation,
  snapshotToCompletionEvaluation,
  type SessionVerificationRunSnapshot,
  type Criterion,
  type EvidenceRef,
  type VerificationResult,
  type VerifierReview,
} from '@zelari/core/verification';

/**
 * Strict done gate defaults: per-surface.
 * - `kraken` (default): ON by default (harness-hardening P0.1); explicit
 *   opt-out via `ZELARI_STRICT_DONE=0|false`.
 * - `mission`: ON by default; explicit opt-out via `ZELARI_MISSION_STRICT=0|false`.
 */
export type StrictDoneSurface = 'kraken' | 'mission';

export function strictDoneEnabled(surface: StrictDoneSurface = 'kraken'): boolean {
  if (surface === 'mission') {
    const v = process.env.ZELARI_MISSION_STRICT;
    if (v === '0' || v === 'false') return false;
    return true;
  }
  // P0.1: strict evidence gate is the default on the kraken surface too —
  // "done means verified" no longer requires an opt-in. `0|false` opts out.
  const v = process.env.ZELARI_STRICT_DONE;
  if (v === '0' || v === 'false') return false;
  return true;
}

export interface KrakenEvidenceContract {
  criteria: Criterion[];
  results: VerificationResult[];
}

/** Stable criterion id for a required-check text (deterministic per turn). */
function criterionId(check: string, index: number): string {
  const slug = check
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `check-${index + 1}-${slug || 'criterion'}`;
}

/** Lowercase + collapse whitespace (mirrors completionGate matching). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Find the reported result for a required check using the same tolerant
 * matching as the legacy gate (normalized equality, then containment either
 * direction at minimum length 8) so the two gates never disagree on mapping.
 */
function matchResult(
  check: string,
  byNormalized: Map<string, KrakenCheckResult>,
): KrakenCheckResult | undefined {
  const norm = normalize(check);
  const direct = byNormalized.get(norm);
  if (direct) return direct;
  for (const key of byNormalized.keys()) {
    if (key.length >= 8 && (key.includes(norm) || norm.includes(key))) {
      return byNormalized.get(key);
    }
  }
  return undefined;
}

/**
 * Map registry check results onto the evidence contract.
 *
 * Evidence discipline (ADR-0023): a `pass` counts only when the verify
 * tentacle left an evidence note pointing back at real tool output. A pass
 * without a note produces an empty evidence array — the CompletionPolicy
 * then treats it as `unknown` (pass without evidence ≠ done).
 */
export function krakenResultsToContract(
  requiredChecks: readonly string[],
  results: readonly KrakenCheckResult[] | null,
  now: number = Date.now(),
): KrakenEvidenceContract {
  const byNormalized = new Map<string, KrakenCheckResult>();
  for (const r of results ?? []) byNormalized.set(normalize(r.check), r); // later duplicates win
  const criteria: Criterion[] = [];
  const verifications: VerificationResult[] = [];
  requiredChecks.forEach((check, i) => {
    const id = criterionId(check, i);
    criteria.push({
      id,
      text: check,
      source: 'kraken-selection',
      required: true,
      check: { kind: 'none', reason: 'verified by verify tentacle report' },
    });
    const reported = matchResult(check, byNormalized);
    const evidence: EvidenceRef[] =
      reported?.note && reported.note.trim().length > 0
        ? [
            {
              tier: 'tool-output',
              ref: reported.note.trim().slice(0, 500),
              capturedAt: now,
            },
          ]
        : [];
    verifications.push({
      criterionId: id,
      status: reported?.status ?? 'unknown',
      source: 'verify-agent',
      evidence,
      evaluatedAt: now,
      durationMs: 0,
      ...(reported?.note ? { detail: `verify-report note: ${reported.note.slice(0, 200)}` } : {}),
    });
  });
  return { criteria, results: verifications };
}

/**
 * 2.0 (ADR-0026): stamp EvidenceRef.seq on selection-contract notes by
 * appending a `verification.evidence` event. Without an emitter the refs
 * stay unanchored and STRICT_BUILD_POLICY (requireEventBackedEvidence)
 * will BLOCK — that is the RC false-done guard, not a test-only quirk.
 */
/** Provenance outcome of one anchoring pass (2.1 T5 measurement). */
export interface EvidenceAnchoringCounts {
  /** EvidenceRefs anchored to a captured tool execution (pattern A). */
  toolResultAnchored: number;
  /** EvidenceRefs anchored to a re-emitted verify-report note (pattern B, deprecated). */
  noteFallback: number;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Best-effort match of a verify-report note to a captured tool execution:
 * 1. command-hint overlap (the note cites the command it ran), then
 * 2. distinctive output overlap (counts like "41/41" appear in the raw
 *    tool output the process captured).
 * Most recent execution wins — later tools are the likeliest source of
 * the evidence the verify tentacle is reporting on.
 */
export function matchNoteToToolTrace(
  note: string,
  trace: readonly TentacleToolTrace[],
): TentacleToolTrace | null {
  const n = normalize(note);
  if (!n) return null;
  for (let i = trace.length - 1; i >= 0; i--) {
    const t = trace[i]!;
    const cmd = t.command ? normalize(t.command) : '';
    if (cmd.length >= 4 && (n.includes(cmd) || cmd.includes(n))) return t;
  }
  for (let i = trace.length - 1; i >= 0; i--) {
    const t = trace[i]!;
    const out = normalize(t.output);
    if (!out) continue;
    if (n.length >= 8 && out.includes(n)) return t;
    const fragments = n.match(/\S*\d[\d.,/%]*\S*/g) ?? [];
    for (const raw of fragments) {
      const frag = raw.replace(/[.,;:]+$/, '');
      if (frag.length >= 3 && out.includes(frag)) return t;
    }
  }
  return null;
}

export async function anchorSelectionEvidence(
  results: VerificationResult[],
  emit?: (input: SessionEventInput) => Promise<unknown>,
  toolTrace?: readonly TentacleToolTrace[],
): Promise<EvidenceAnchoringCounts> {
  const counts: EvidenceAnchoringCounts = { toolResultAnchored: 0, noteFallback: 0 };
  if (!emit) return counts;
  for (const r of results) {
    for (const ev of r.evidence) {
      if (ev.seq !== undefined) continue;
      if (ev.tier === 'verifier-llm' || ev.tier === 'human') continue;
      try {
        // 2.1 T5 pattern A (original-tool-backed): match the note to a RAW
        // tool execution captured at run time, and anchor the EvidenceRef to
        // an event that carries the tool output + digest — not the note.
        const match =
          toolTrace && toolTrace.length > 0 ? matchNoteToToolTrace(ev.ref, toolTrace) : null;
        if (match) {
          const digest = sha256Hex(match.output);
          const appended = await emit({
            kind: 'verification.evidence',
            actor: { type: 'system', role: 'verification' },
            data: {
              observation: 'tool-result',
              provenance: 'tentacle-tool-capture',
              criterionId: r.criterionId,
              tool: match.tool,
              callId: match.callId,
              ok: match.ok,
              digest,
              outputTail: match.output.slice(0, 240),
              note: ev.ref,
              ...(match.command ? { command: match.command } : {}),
            },
          });
          const toolSeq =
            appended && typeof appended === 'object' && 'seq' in appended
              ? Number((appended as { seq: unknown }).seq)
              : NaN;
          if (Number.isFinite(toolSeq) && toolSeq > 0) {
            ev.seq = toolSeq;
            ev.digest = digest;
            ev.ref = `${match.tool}${match.command ? ` ${match.command}` : ''} → ${match.ok ? 'ok' : 'error'} @seq`;
            counts.toolResultAnchored += 1;
          }
          continue;
        }
        // Pattern B (deprecated fallback): no captured execution matches the
        // note — re-emit the note itself, explicitly marked as note-backed.
        const appended = await emit({
          kind: 'verification.evidence',
          actor: { type: 'system', role: 'verification' },
          data: {
            observation: 'verify-report-note',
            provenance: 'note-fallback',
            criterionId: r.criterionId,
            ref: ev.ref,
            tier: ev.tier,
          },
        });
        const seq =
          appended && typeof appended === 'object' && 'seq' in appended
            ? Number((appended as { seq: unknown }).seq)
            : NaN;
        if (Number.isFinite(seq) && seq > 0) {
          ev.seq = seq;
          counts.noteFallback += 1;
        }
      } catch {
        // degrade-and-stop: leave unanchored; policy will BLOCK if required
      }
    }
  }
  return counts;
}

/** Combined outcome: legacy gate + strict evidence evaluation (selection contract + native criteria pack). */
/**
 * t21 (§P1.D × PW §10): one reviewer's verdict as recorded for evidence.
 * Advisory-only metadata; never authoritative for verdict/blocked.
 */
export interface ReviewerVerdictRecord {
  provider: string | null;
  model: string | null;
  family: string;
  role: string;
  verdict: 'confirmed' | 'rejected' | 'unknown';
  score: number | null;
  rationale: string | null;
  fallback: string | null;
}

/**
 * t21 (PW §10): critical-risk dual-review disagreement becomes STRUCTURED
 * EVIDENCE (evidence item kind `verifier-divergence`) instead of a silent
 * pick. Serialized inside the `verification.run` payload (`verifier.divergence`)
 * so it flows verbatim into the completion proof json wrapper.
 */
export interface VerifierDivergenceEvidence {
  kind: 'verifier-divergence';
  risk: 'critical';
  /** True when reviewers disagreed (pessimistic merge still applies). */
  divergent: boolean;
  mergedVerdict: VerifierReview['verdict'];
  reviews: ReviewerVerdictRecord[];
}

export interface StrictBuildGateEvaluation {
  gate: KrakenCompletionGate;
  strict: boolean;
  evaluation: CompletionEvaluation | null;
  /**
   * F2 (Exit-2.4): native Zelari Coding Criteria Pack results evaluated by
   * the core VerificationEngine in this process. Null when the pack is
   * disabled (default during the alpha), the repo binds no deterministic
   * command, or the evaluation is reconstructed from the session log.
   */
  native?: NativePackEvaluation | null;
  /**
   * t22 (§P1.C): TaskContract-compiled criteria (verificationHint commands)
   * evaluated by the same engine, joined into the SAME CompletionPolicy
   * evaluation as the pack. Null when no contract/scope registered or the
   * contract binds no deterministic command.
   */
  compiled?: ContractCriteriaEvaluation | null;
  /**
   * Flat VerificationResult list backing the evaluation (selection contract
   * + native pack). Set whenever the strict path runs; consumed by the
   * advisory verifier review (verifierLifecycle.ts).
   */
  results?: VerificationResult[];
  /**
   * 2.1 T4: advisory LLM review attached by the lifecycle wiring —
   * informational only, NEVER authoritative for verdict/blocked.
   */
  review?: VerifierReview | null;
  /**
   * t21 (§P1.D): dual critical-risk reviewer verdicts + disagreement, set
   * only when two reviewers ran. Same advisory discipline as `review`.
   */
  reviewDivergence?: VerifierDivergenceEvidence | null;
  /**
   * 2.1 T5: how the selection-contract evidence was anchored — refs tied to
   * captured tool executions (pattern A) vs re-emitted notes (pattern B,
   * deprecated). Measurement hook for the 2.1 provenance migration.
   */
  anchoring?: EvidenceAnchoringCounts;
  /** True when the turn may NOT cleanly finish (either gate blocks). */
  blocked: boolean;
  /** One-line machine-readable summary for logging/NDJSON. */
  summary: string;
}

/** Host/test seam for the native pack evaluation (default: real NodeShellProvider). */
export interface StrictGateOptions {
  /** Workspace root for package.json detection and command cwd. */
  cwd?: string;
  /** Env snapshot override (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Shell seam (tests inject a stub); defaults to the core NodeShellProvider. */
  shell?: ShellProvider;
  /**
   * F3 (ADR-0023 §5): forward engine verification events
   * (`verification.evidence` / `verification.run`) onto the session spine;
   * the appended seq anchors the EvidenceRefs.
   */
  emit?: (input: SessionEventInput) => Promise<unknown>;
  /**
   * ADR-0025: which surface's defaults apply. `kraken` (default) keeps the
   * opt-in env gate; `mission` defaults the strict evidence gate ON with
   * opt-out via `ZELARI_MISSION_STRICT=0`.
   */
  surface?: StrictDoneSurface;
  /**
   * t22: live TaskContract of this turn — explicit override that wins over
   * the active-scope seam (kraken/contractCompiler.setActiveContractScope).
   * Neither present ⇒ no contract contribution to the gate.
   */
  taskContract?: import('@zelari/core').TaskContract;
}

/**
 * Evaluate the BUILD completion gate. When `ZELARI_STRICT_DONE` is enabled
 * and the turn registered required checks, the evidence contract is evaluated
 * as well and the verdicts merged (blockers add up).
 */
export async function evaluateStrictBuildGate(
  mode: 'plan' | 'build',
  options: StrictGateOptions = {},
): Promise<StrictBuildGateEvaluation> {
  const gate = evaluateKrakenCompletionGate(mode);
  // 2.1 T6: the native criteria pack is INDEPENDENT of Kraken selection —
  // ZELARI_VERIFY_PACK=1 evaluates the pack even on turns that never ran
  // kraken_select. Selection criteria join the same evaluation when present.
  const strictOn = strictDoneEnabled(options.surface ?? 'kraken');
  const nativeOn = nativePackEnabled(options.env ?? process.env);
  const selectionAvailable = gate.selectionUsed && gate.total > 0;
  // t22: TaskContract-compiled criteria participate under the SAME switches
  // as the pack. They can rescue a bare "nothing to evaluate" early-return
  // when no selection ran and the pack binds nothing (contract-only turn).
  const scopeContract = options.taskContract ?? activeContractScope()?.contract;
  const contractPlan = scopeContract ? compileVerificationCriteria(scopeContract) : [];
  if ((!selectionAvailable && !nativeOn && contractPlan.length === 0) || (!strictOn && !nativeOn)) {
    return {
      gate,
      strict: false,
      evaluation: null,
      native: null,
      blocked: gate.blocked,
      summary: gate.blocked
        ? `blocked: ${gate.failedChecks.length} failed, ${gate.unknownChecks.length} unknown`
        : 'open',
    };
  }
  const checks = selectionAvailable ? krakenRequiredChecks() : [];
  const contract = selectionAvailable
    ? krakenResultsToContract(checks, getKrakenCheckResults())
    : { criteria: [], results: [] };
  const anchoring = await anchorSelectionEvidence(
    contract.results,
    options.emit,
    getLastVerifyToolTrace() ?? undefined,
  );
  // F2: native criteria pack (opt-in) — real commands via the core engine.
  // A pack failure degrades to the legacy contract only; it never un-blocks.
  const native = await evaluateNativePack({
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    emit: options.emit,
  }).catch((): null => null);
  // t22: contract-compiled criteria join the pack's evaluation — blockers
  // add up. Evaluated with the same shell/emit seams so evidence anchors to
  // the spine exactly like the pack's. A failure degrades to no contribution.
  const compiled = scopeContract
    ? await evaluateContractCriteria(scopeContract, {
        cwd: options.cwd,
        shell: options.shell,
        emit: options.emit,
      }).catch((): ContractCriteriaEvaluation | null => null)
    : null;
  const allCriteria = [...contract.criteria, ...(native?.criteria ?? []), ...(compiled?.criteria ?? [])];
  const allResults = [...contract.results, ...(native?.results ?? []), ...(compiled?.results ?? [])];
  // Pack enabled but nothing bound (and no selection contract) → nothing to
  // evaluate: stay non-strict rather than certify an empty PASS.
  if (allCriteria.length === 0) {
    return {
      gate,
      strict: false,
      evaluation: null,
      native,
      results: allResults,
      blocked: gate.blocked,
      summary: gate.blocked
        ? `blocked: ${gate.failedChecks.length} failed, ${gate.unknownChecks.length} unknown`
        : 'open (native pack bound no command)',
    };
  }
  const evaluation = evaluateCompletion(allCriteria, allResults, STRICT_BUILD_POLICY);
  const blocked = gate.blocked || evaluation.verdict !== 'PASS';
  const legacyPart = selectionAvailable ? `${gate.passed}/${gate.total} legacy-pass, ` : 'no selection contract, ';
  return {
    gate,
    strict: true,
    results: allResults,
    anchoring,
    evaluation,
    native,
    compiled,
    blocked,
    summary: blocked
      ? `blocked (strict ${evaluation?.verdict ?? 'n/a'}): ${legacyPart}evidence ${
          evaluation?.evidenceComplete ? 'complete' : 'incomplete'
        }`
      : `open (strict PASS): ${evaluation?.satisfied.length ?? 0}/${allCriteria.length} criteria pass with evidence`,
  };
}

/**
 * E2.2 exit code for a strict-mode turn whose completion gate is still blocked
 * after the automatic repair pass: the run must NOT close as success.
 * Distinct from transport errors (3) and usage errors (2).
 */
export const STRICT_DONE_EXIT_CODE = 4;

/** Pure: strict blocked → dedicated exit code; anything else → keep the pass outcome. */
export function strictGateExitCode(evaluation: StrictBuildGateEvaluation): number {
  return evaluation.strict && evaluation.blocked ? STRICT_DONE_EXIT_CODE : 0;
}

/** Machine-readable record for the session spine `verification.run` event. */
export function strictGateEventPayload(evaluation: StrictBuildGateEvaluation): Record<string, unknown> {
  return {
    engine: evaluation.native ? 'kraken-legacy+completion-policy+criteria-pack' : 'kraken-legacy+completion-policy',
    strict: evaluation.strict,
    verdict: evaluation.evaluation?.verdict ?? (evaluation.blocked ? 'BLOCKED' : 'PASS'),
    legacy: {
      total: evaluation.gate.total,
      passed: evaluation.gate.passed,
      failed: evaluation.gate.failedChecks,
      unknown: evaluation.gate.unknownChecks,
    },
    evidence: evaluation.evaluation
      ? {
          satisfied: evaluation.evaluation.satisfied,
          unsatisfied: evaluation.evaluation.unsatisfied,
          complete: evaluation.evaluation.evidenceComplete,
          provenance: evaluation.anchoring ?? null,
        }
      : null,
    // F2: deterministic pack results — real command evidence, replayable.
    native: evaluation.native
      ? {
          packId: evaluation.native.packId,
          criteria: evaluation.native.criteria.map((c) => ({ id: c.id, required: c.required })),
          results: evaluation.native.results.map((r) => ({
            criterionId: r.criterionId,
            status: r.status,
            evidence: r.evidence.map((e) => ({ tier: e.tier, ref: e.ref, digest: e.digest, ...(e.seq !== undefined ? { seq: e.seq } : {}) })),
            detail: r.detail,
          })),
        }
      : null,
    // t22: contract-compiled deterministic checks (Verify commands) — same
    // evidence discipline as the pack; omitted entirely when absent so old
    // payloads stay byte-identical.
    ...(evaluation.compiled
      ? {
          compiled: {
            criteria: evaluation.compiled.criteria.map((c) => ({ id: c.id, required: c.required })),
            results: evaluation.compiled.results.map((r) => ({
              criterionId: r.criterionId,
              status: r.status,
              evidence: r.evidence.map((e) => ({ tier: e.tier, ref: e.ref, digest: e.digest, ...(e.seq !== undefined ? { seq: e.seq } : {}) })),
              detail: r.detail,
            })),
          },
        }
      : {}),
    // 2.1 T4: advisory verifier review (opt-in) — informational, never
    // authoritative: verdict/blocked above come from the deterministic policy.
    verifier: evaluation.review
      ? {
          verdict: evaluation.review.verdict,
          score: evaluation.review.score ?? null,
          rationale: evaluation.review.rationale ?? null,
          fallback: evaluation.review.fallback ?? null,
          effectiveModel: evaluation.review.effectiveModel,
          advisory: true,
          // t21 (PW §10): dual critical-risk reviewer evidence item — present
          // ONLY when two reviewers ran, so old payloads stay byte-identical.
          ...(evaluation.reviewDivergence ? { divergence: evaluation.reviewDivergence } : {}),
        }
      : null,
    summary: evaluation.summary,
  };
}

/**
 * E2.1 (ADR-0023 × ADR-0021): reconstruct the strict build gate verdict from
 * the session spine alone — no in-process registry. For hosts, mission
 * retries and audits: a turn's decision must be confirmable from its log.
 * A missing snapshot is "no verification evidence" (open, never pass); a
 * non-strict snapshot is not admissible. Blockers add up — the caller
 * combines this with its own current-process gate.
 */
export function evaluateStrictBuildGateFromSession(
  mode: 'plan' | 'build',
  snapshot: SessionVerificationRunSnapshot | null,
): StrictBuildGateEvaluation {
  // Legacy view of THIS process (usually empty on a resumed host).
  const gate = evaluateKrakenCompletionGate(mode);
  const evaluation = snapshot ? snapshotToCompletionEvaluation(snapshot) : null;
  const blocked = evaluation ? evaluation.verdict !== 'PASS' : false;
  return {
    gate,
    strict: evaluation !== null,
    evaluation,
    native: null, // session replay carries the payload, not in-process results
    blocked,
    summary: evaluation
      ? blocked
        ? `blocked (strict ${evaluation.verdict} from session log seq=${snapshot?.seq}): ${evaluation.summary}`
        : `open (strict PASS from session log seq=${snapshot?.seq}): ${evaluation.summary}`
      : 'open (no strict verification record in session log)',
  };
}
