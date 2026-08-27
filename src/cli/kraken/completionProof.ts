/**
 * completionProof — harness-hardening P0.3 (× ADR-0023), transaction-grade
 * persistence (t20 §P1.B × PW §7): the completion proof-of-work artifact.
 *
 * Every strict build-gate evaluation leaves a durable witness on disk:
 * `.zelari/completion-proof.md` (prose) + `.zelari/completion-proof.json`
 * (machines). v2 contract (t20): the JSON WRAPS the spine
 * `verification.run` payload under `evaluation` verbatim and seals an
 * `attestation` block of sha256 digests (./completionProofAttestation.js);
 * writes are atomic (tmp→fsync→rename, ./completionProofPersist.js); under
 * `required` persistence a failed write BLOCKS an otherwise-PASSing gate
 * (completionGate exit-4 family).
 *
 * Discipline: rendering is deterministic given its inputs; writing NEVER throws — failures surface in the returned outcome.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { strictGateEventPayload, type StrictBuildGateEvaluation } from './verificationBridge.js';
import {
  PROOF_KIND,
  PROOF_VERSION,
  attestationSection,
  buildAttestedWrapper,
  type CompletionProofWrapper,
  type ProofAttestation,
  type ProofAttestationOptions,
} from './completionProofAttestation.js';
import { activeTaskContractSnapshot, defaultVerificationPlanSnapshot } from './completionProofProbe.js';
import {
  activeProofPersistenceMode,
  enforceRequiredProofPersistence,
  writeFileAtomic,
  type ProofPersistenceMode,
  type ProofPersistenceOutcome,
} from './completionProofPersist.js';
import type { Criterion, VerificationResult } from '@zelari/core/verification';

/** Contextual pointers rendered into the proof header (all optional). */
export interface CompletionProofMeta {
  /** Gate surface that produced the evaluation ('kraken' | 'mission'). */
  surface?: string;
  /** Session spine id — the audit trail behind the evidence seqs. */
  sessionId?: string;
  /** Epoch ms; when omitted the render stays clock-free (deterministic). */
  generatedAt?: number;
}

export interface CompletionProofRender {
  markdown: string;
  json: string;
}

export interface CompletionProofPaths {
  markdownPath: string;
  jsonPath: string;
}

export interface WriteCompletionProofOptions {
  /** Directory that owns the `.zelari/` folder; defaults to process.cwd(). */
  baseDir?: string;
  meta?: CompletionProofMeta;
  /**
   * Extra context hashed into the attestation (task contract of this run,
   * pre-resolved verification plan / git inputs). Omitted pieces resolve
   * best-effort; set `skipProbes` for hermetic artifacts.
   */
  attestation?: ProofAttestationOptions;
  /** Override persistence-mode resolution (defaults to active mode). */
  persistenceMode?: ProofPersistenceMode;
}

/** Verdict line — mirrors strictGateEventPayload's fallback rule exactly. */
function verdictOf(evaluation: StrictBuildGateEvaluation): string {
  return evaluation.evaluation?.verdict ?? (evaluation.blocked ? 'BLOCKED' : 'PASS');
}

/** Markdown table cell: pipes and newlines must not break the table. */
function cell(text: string, max = 200): string {
  const flat = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One `tier · seq N · digest xxxxxxxx…` descriptor per evidence ref. */
function evidenceCell(result: VerificationResult | null): string {
  if (!result || result.evidence.length === 0) return '—';
  return result.evidence
    .map((e) => {
      const parts: string[] = [e.tier];
      if (e.seq !== undefined) parts.push(`seq ${e.seq}`);
      if (e.digest) parts.push(`digest ${e.digest.slice(0, 8)}…`);
      return parts.join(' · ');
    })
    .join('; ');
}
interface ProofRow {
  id: string;
  text: string | null;
  required: boolean;
  status: string;
  result: VerificationResult | null;
}

/**
 * Deterministic criterion rows: flat results first (selection contract then
 * native pack order), then unsatisfied ids with no result at all (`missing`).
 */
function proofRows(evaluation: StrictBuildGateEvaluation): ProofRow[] {
  const nativeById = new Map<string, Criterion>(
    (evaluation.native?.criteria ?? []).map((c) => [c.id, c]),
  );
  const rows = new Map<string, ProofRow>();
  for (const result of evaluation.results ?? []) {
    const criterion = nativeById.get(result.criterionId);
    rows.set(result.criterionId, {
      id: result.criterionId,
      text: criterion?.text ?? null,
      required: criterion ? criterion.required : true,
      status: result.status,
      result,
    });
  }
  for (const unsatisfied of evaluation.evaluation?.unsatisfied ?? []) {
    if (rows.has(unsatisfied.id)) continue;
    const criterion = nativeById.get(unsatisfied.id);
    rows.set(unsatisfied.id, {
      id: unsatisfied.id,
      text: criterion?.text ?? null,
      required: true, // satisfied/unsatisfied lists cover required criteria only
      status: unsatisfied.status,
      result: null,
    });
  }
  return [...rows.values()];
}

function renderMarkdown(
  evaluation: StrictBuildGateEvaluation,
  meta: CompletionProofMeta,
  attestationLines: string[],
): string {
  const lines: string[] = [
    '# Completion Proof',
    '',
    'Strict build-gate proof-of-work (ADR-0023). The machine-readable twin of',
    'this document — `completion-proof.json` — wraps the exact',
    '`verification.run` payload sent to the session spine.',
    '',
    `- **Verdict**: **${verdictOf(evaluation)}**`,
    `- **Strict gate**: ${evaluation.strict ? 'on' : 'off'}`,
    `- **Turn blocked**: ${evaluation.blocked ? 'yes' : 'no'}`,
    `- **Summary**: ${cell(evaluation.summary, 400)}`,
    `- **Legacy selection gate**: ${evaluation.gate.passed}/${evaluation.gate.total} passed` +
      (evaluation.gate.failedChecks.length > 0 ? `; failed: ${evaluation.gate.failedChecks.length}` : '') +
      (evaluation.gate.unknownChecks.length > 0 ? `; unknown: ${evaluation.gate.unknownChecks.length}` : ''),
  ];
  if (meta.surface) lines.push(`- **Surface**: ${meta.surface}`);
  if (meta.sessionId) lines.push(`- **Session**: ${meta.sessionId} (session spine)`);
  if (meta.generatedAt !== undefined) {
    lines.push(`- **Generated**: ${new Date(meta.generatedAt).toISOString()}`);
  }

  const rows = proofRows(evaluation);
  lines.push('', '## Criteria', '', '| Criterion | Required | Status | Evidence |', '| --- | --- | --- | --- |');
  if (rows.length === 0) {
    lines.push('| _none — no criteria joined this evaluation_ | — | — | — |');
  }
  for (const row of rows) {
    const label = row.text ? `\`${row.id}\` — ${cell(row.text)}` : `\`${row.id}\``;
    lines.push(`| ${label} | ${row.required ? 'yes' : 'no'} | ${row.status} | ${evidenceCell(row.result)} |`);
  }

  const unsatisfied = evaluation.evaluation?.unsatisfied ?? [];
  if (unsatisfied.length > 0) {
    lines.push('', '### Unsatisfied', '');
    for (const u of unsatisfied) lines.push(`- \`${u.id}\`: **${u.status}** — ${cell(u.reason, 300)}`);
  }

  const native = evaluation.native;
  if (native) {
    lines.push(
      '',
      `## Native criteria pack — ${native.packId}`,
      '',
      '| Criterion | Command | Status | Detail |',
      '| --- | --- | --- | --- |',
    );
    for (const result of native.results) {
      const criterion = native.criteria.find((c) => c.id === result.criterionId);
      const check = criterion?.check;
      const command = check?.kind === 'command' ? check.command : '—';
      const label = criterion?.text ? `\`${result.criterionId}\` — ${cell(criterion.text, 120)}` : `\`${result.criterionId}\``;
      lines.push(`| ${label} | \`${cell(command, 120)}\` | ${result.status} | ${cell(result.detail ?? '—')} |`);
    }
  }

  const review = evaluation.review;
  if (review) {
    lines.push(
      '',
      '## Advisory verifier review',
      '',
      '_Advisory only — this review cannot change the gate verdict above._',
      '',
      `- **Verdict**: ${review.verdict}`,
    );
    if (review.score !== undefined) lines.push(`- **Score**: ${review.score}`);
    const model = review.effectiveModel.model ?? review.effectiveModel.provider ?? review.effectiveModel.mode;
    lines.push(`- **Model**: ${model}${review.usedLogprobs ? ' (logprobs)' : ''}`);
    if (review.fallback) lines.push(`- **Fallback**: ${review.fallback}`);
    if (review.rationale) lines.push(`- **Rationale**: ${cell(review.rationale, 400)}`);
    // t21 (PW §10): dual critical-risk reviewers surface their verdicts and
    // any disagreement right here — `verifier-divergence` is EVIDENCE in the
    // proof, not a silent pick between conflicting reviews.
    const divergence = evaluation.reviewDivergence;
    if (divergence) {
      const perReviewer = divergence.reviews
        .map((r) => `${r.provider ?? '?'}/${r.model ?? '?'}=${r.verdict}`)
        .join(' vs ');
      lines.push(`- **Dual review (${divergence.risk})**: ${cell(perReviewer)}`);
      lines.push(
        `- **Divergence** (\`verifier-divergence\` evidence item): ${divergence.divergent ? 'yes' : 'no'} — pessimistic merge → ${divergence.mergedVerdict}`,
      );
    }
  }

  if (attestationLines.length > 0) lines.push('', ...attestationLines);

  lines.push('', '---', '', 'Machine record: `completion-proof.json` (same directory).');
  return `${lines.join('\n')}\n`;
}

/**
 * Render the proof pair. Without a sealed attestation json stays the bare
 * spine payload (legacy v1); with one BOTH views come from the v2 wrapper
 * (json) and gain `## Attestation` (markdown). Deterministic.
 */
export function renderCompletionProof(
  evaluation: StrictBuildGateEvaluation,
  meta: CompletionProofMeta = {},
  attestation?: ProofAttestation,
): CompletionProofRender {
  const payload = strictGateEventPayload(evaluation);
  if (!attestation) {
    return { markdown: renderMarkdown(evaluation, meta, []), json: JSON.stringify(payload, null, 2) };
  }
  const wrapper: CompletionProofWrapper = {
    kind: PROOF_KIND,
    version: PROOF_VERSION,
    evaluation: payload,
    attestation,
  };
  return {
    markdown: renderMarkdown(evaluation, meta, attestationSection(attestation)),
    json: JSON.stringify(wrapper, null, 2),
  };
}

/**
 * Persist `.zelari/completion-proof.{md,json}` under `baseDir`. Atomic per
 * file; NEVER throws — failures land in the outcome (`paths: null`), and
 * under `required` persistence also as `requiredBlockReason` for hosts to
 * flip the gate via enforceRequiredProofPersistence.
 */
export async function writeCompletionProofDetailed(
  evaluation: StrictBuildGateEvaluation,
  options: WriteCompletionProofOptions = {},
): Promise<ProofPersistenceOutcome> {
  const mode = options.persistenceMode ?? activeProofPersistenceMode();
  try {
    const baseDir = options.baseDir ?? process.cwd();
    const dir = path.join(baseDir, '.zelari');
    await mkdir(dir, { recursive: true });
    const requested = options.attestation ?? {};
    const plan =
      requested.skipProbes || requested.verificationPlan !== undefined
        ? undefined
        : await defaultVerificationPlanSnapshot(baseDir);
    const wrapper = await buildAttestedWrapper(
      strictGateEventPayload(evaluation),
      {
        skipProbes: requested.skipProbes,
        // t22 (PW §8): default to the CURRENT live contract from the
        // contract-scope seam — a steer that bumps the version changes this
        // digest on the next proof write. Explicit host value wins;
        // skipProbes keeps artifacts hermetic (no seam read).
        taskContract: requested.skipProbes
          ? requested.taskContract
          : (requested.taskContract ?? activeTaskContractSnapshot()),
        git: requested.git,
        verificationPlan: requested.verificationPlan ?? plan,
      },
      process.env,
      baseDir,
    );
    const rendered = renderCompletionProof(evaluation, options.meta ?? {}, wrapper.attestation);
    const markdownPath = path.join(dir, 'completion-proof.md');
    const jsonPath = path.join(dir, 'completion-proof.json');
    await writeFileAtomic(markdownPath, rendered.markdown);
    await writeFileAtomic(jsonPath, rendered.json);
    return { paths: { markdownPath, jsonPath }, mode, requiredBlockReason: null };
  } catch (err) {
    // Failure reasons must be actionable — under `required` they close runs.
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      paths: null,
      mode,
      requiredBlockReason: mode === 'required' ? reason : null,
    };
  }
}

/** Legacy best-effort entry point (unchanged v1 contract): paths or null. */
export async function writeCompletionProof(
  evaluation: StrictBuildGateEvaluation,
  options: WriteCompletionProofOptions = {},
): Promise<CompletionProofPaths | null> {
  return (await writeCompletionProofDetailed(evaluation, options)).paths;
}

