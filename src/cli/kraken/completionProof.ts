/**
 * completionProof — harness-hardening P0.3 (× ADR-0023): the completion
 * proof-of-work artifact.
 *
 * Every strict build-gate evaluation (kraken BUILD turn, post-repair
 * re-evaluation, mission close, TUI agent_end) leaves a durable witness on
 * disk: `.zelari/completion-proof.md` for humans and hosts that read prose,
 * `.zelari/completion-proof.json` for machines. The JSON body IS the spine
 * `verification.run` payload (`strictGateEventPayload`) — same source of
 * truth, zero duplication — so the artifact can never disagree with the
 * session log.
 *
 * Discipline:
 * - rendering is deterministic (no clock access; `generatedAt` only when
 *   passed via meta);
 * - writing NEVER fails the parent flow: `writeCompletionProof` swallows
 *   every error and reports it as `null`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strictGateEventPayload, type StrictBuildGateEvaluation } from './verificationBridge.js';
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

/** One `tier · seq N · digest xxxxxxxx…` evidence descriptor per ref. */
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
 * native pack order — the order they joined the evaluation), then unsatisfied
 * ids that produced no result at all (`missing`). Only native criteria expose
 * their text on the evaluation; selection criteria render their stable id.
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

function renderMarkdown(evaluation: StrictBuildGateEvaluation, meta: CompletionProofMeta): string {
  const lines: string[] = [
    '# Completion Proof',
    '',
    'Strict build-gate proof-of-work (ADR-0023). The machine-readable twin of',
    'this document — `completion-proof.json` — is the exact `verification.run`',
    'payload sent to the session spine.',
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
  }

  lines.push('', '---', '', 'Machine record: `completion-proof.json` (same directory).');
  return `${lines.join('\n')}\n`;
}

/**
 * Render the proof pair for a strict build-gate evaluation. `json` is the
 * spine `verification.run` payload verbatim; `markdown` is the human- and
 * host-facing view. Deterministic: no clock or randomness unless
 * `meta.generatedAt` is provided.
 */
export function renderCompletionProof(
  evaluation: StrictBuildGateEvaluation,
  meta: CompletionProofMeta = {},
): CompletionProofRender {
  return {
    markdown: renderMarkdown(evaluation, meta),
    json: JSON.stringify(strictGateEventPayload(evaluation), null, 2),
  };
}

/**
 * Persist `.zelari/completion-proof.{md,json}` under `baseDir` (default
 * `process.cwd()`), creating the directory. NEVER throws: any failure is
 * swallowed and reported as `null` — a proof write must not break the
 * parent run (harness-hardening P0.3).
 */
export async function writeCompletionProof(
  evaluation: StrictBuildGateEvaluation,
  options: WriteCompletionProofOptions = {},
): Promise<CompletionProofPaths | null> {
  try {
    const dir = path.join(options.baseDir ?? process.cwd(), '.zelari');
    await mkdir(dir, { recursive: true });
    const { markdown, json } = renderCompletionProof(evaluation, options.meta);
    const markdownPath = path.join(dir, 'completion-proof.md');
    const jsonPath = path.join(dir, 'completion-proof.json');
    await writeFile(markdownPath, markdown, 'utf8');
    await writeFile(jsonPath, json, 'utf8');
    return { markdownPath, jsonPath };
  } catch {
    return null; // proof writing is best-effort by contract
  }
}
