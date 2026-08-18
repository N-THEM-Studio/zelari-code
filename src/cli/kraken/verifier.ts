/**
 * verifier — Kraken selection verifier (Fase 4, ADR-0020).
 *
 * Compares the candidate reports registered this turn (Fase 3) and produces
 * ONE structured {@link KrakenSelectionVerdict}. Design rules:
 *
 *   - Verifier identity DEFAULTS to the exact PARENT model (no cheap-model
 *     auto-pick — judging quality is the point). Overrides: explicit param
 *     (Fase 9 settings) > ZELARI_KRAKEN_SELECT_PROVIDER/MODEL env > parent.
 *   - Structured judging: the model must answer with a
 *     `<selection-verdict>` JSON block, parsed LENIENTLY.
 *   - `needs_more_evidence` is a first-class outcome (ties, weak evidence).
 *   - Fallback NEVER fails the parent turn: a malformed/failed verifier
 *     response degrades to `needs_more_evidence` with `degraded: true` and
 *     the parent proceeds with its own judgment.
 *   - Deterministic short-circuits (no LLM call): zero usable candidates,
 *     single usable candidate.
 *
 * Pure module: the LLM call is injected (`callModel`), so tests never hit
 * the network.
 */

import type { CandidateEntry } from './candidateRegistry.js';

/** Provider + model identity used to judge candidates. */
export interface KrakenVerifierIdentity {
  provider: string;
  model: string;
}

/** Optional explicit override (Fase 9 settings; wins over env). */
export interface KrakenVerifierOverride {
  provider?: string;
  model?: string;
}

/** Outcome of one selection run. Plain JSON — safe to persist/emit. */
export interface KrakenSelectionVerdict {
  status: 'selected' | 'needs_more_evidence';
  /** 1-based index of the winning candidate (null unless status=selected). */
  winnerIndex: number | null;
  /** Why the winner (or why evidence is insufficient). */
  rationale: string;
  /** 0-5 concrete checks the implementation must pass (Fase 6 wiring). */
  requiredChecks: string[];
  /** True when a fallback path (not the verifier LLM) produced this. */
  degraded: boolean;
  /** Set when degraded — why the verifier LLM was bypassed/failed. */
  fallbackReason?: string;
  /** Identity actually used for judging (null on deterministic paths). */
  verifier: KrakenVerifierIdentity | null;
  /** 'llm' = model judged; 'deterministic' = short-circuit. */
  judgedBy: 'llm' | 'deterministic';
}

/**
 * Resolve the verifier identity.
 *
 *   1. explicit override (both provider+model required — partial overrides
 *      are treated as invalid and fall through)
 *   2. env: ZELARI_KRAKEN_SELECT_PROVIDER + ZELARI_KRAKEN_SELECT_MODEL
 *      (model-only keeps the parent provider; provider-only is invalid)
 *   3. parent identity — the DEFAULT (ADR-0020: verifier = parent model)
 */
export function resolveKrakenVerifier(
  parent: KrakenVerifierIdentity,
  env: NodeJS.ProcessEnv = process.env,
  explicit?: KrakenVerifierOverride,
): KrakenVerifierIdentity {
  if (explicit?.provider?.trim() && explicit?.model?.trim()) {
    return { provider: explicit.provider.trim(), model: explicit.model.trim() };
  }
  const envProvider = env.ZELARI_KRAKEN_SELECT_PROVIDER?.trim();
  const envModel = env.ZELARI_KRAKEN_SELECT_MODEL?.trim();
  if (envProvider && envModel) return { provider: envProvider, model: envModel };
  if (envModel) return { provider: parent.provider, model: envModel };
  // Provider-only (env or explicit) is not actionable without a model →
  // documented fallback: inherit the parent exactly.
  return { provider: parent.provider, model: parent.model };
}

// ── Prompt ─────────────────────────────────────────────────────────────────

export const VERIFIER_SYSTEM_PROMPT = [
  'You are the Kraken selection verifier. You compare independent research',
  'reports (candidates) about ONE task and decide which hypothesis is best',
  'supported by OBSERVED EVIDENCE. You do not explore anything yourself —',
  'you judge what the candidates actually observed.',
  '',
  'RULES:',
  '- Evidence decides. A specific observation (file:line, command output,',
  '  test result) outweighs any amount of confident wording.',
  '- An eloquent candidate with no observations must NOT beat a plainly',
  '  worded candidate whose claims are grounded in evidence.',
  '- Degraded observations (timeouts, empty searches, unavailable backends)',
  '  are NOT proof of absence — never treat them as confirmation that',
  '  something does not exist or cannot happen.',
  '- A candidate CONTRADICTED by a concrete observation loses to one',
  '  consistent with it. Weigh listed risks.',
  '- If the leading candidates are equally (un)supported, answer',
  '  needs_more_evidence — do not guess.',
  '- requiredChecks: 0-5 concrete, runnable checks the implementation must',
  '  pass to prove the winning hypothesis (test names, commands, behaviors).',
  '',
  'Answer with EXACTLY this block (valid JSON, no prose before/after):',
  '<selection-verdict>',
  '{',
  '  "status": "selected" | "needs_more_evidence",',
  '  "winnerIndex": <1-based index of the winning candidate, or null>,',
  '  "rationale": "2-4 sentences grounded in the evidence",',
  '  "requiredChecks": ["concrete check", "..."]',
  '}',
  '</selection-verdict>',
].join('\n');

function renderCandidate(entry: CandidateEntry): string {
  if (entry.status === 'malformed') {
    return [
      `## Candidate #${entry.index} — UNUSABLE (malformed report: ${entry.error})`,
      'This candidate cannot win; it is listed for completeness.',
    ].join('\n');
  }
  const lines = [`## Candidate #${entry.index} — ${entry.report.hypothesis || '(no hypothesis stated)'}`];
  if (entry.report.evidence.length === 0) {
    lines.push('Evidence: NONE (unsupported hypothesis)');
  } else {
    lines.push('Evidence:');
    for (const e of entry.report.evidence) {
      const tag = e.degraded ? 'DEGRADED — inconclusive, NOT proof of absence' : 'OK';
      lines.push(`- [${tag}] ${e.claim}${e.basis ? ` (basis: ${e.basis})` : ''}`);
    }
  }
  if (entry.report.risks.length > 0) {
    lines.push('Risks:');
    for (const r of entry.report.risks) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

/** Build the user prompt for the judging call. */
export function buildSelectionPrompt(task: string, candidates: readonly CandidateEntry[]): string {
  return [
    'TASK',
    task || '(the current user task — judge against the candidates below)',
    '',
    'CANDIDATES (read-only explorer reports):',
    ...candidates.map(renderCandidate),
    '',
    'Decide which candidate is best supported by the evidence above.',
  ].join('\n');
}

// ── Verdict parsing ────────────────────────────────────────────────────────

const VERDICT_OPEN = '<selection-verdict>';
const VERDICT_CLOSE = '</selection-verdict>';

function needsMoreEvidence(
  rationale: string,
  fallbackReason?: string,
): KrakenSelectionVerdict {
  return {
    status: 'needs_more_evidence',
    winnerIndex: null,
    rationale,
    requiredChecks: [],
    degraded: true,
    ...(fallbackReason ? { fallbackReason } : {}),
    verifier: null,
    judgedBy: 'deterministic',
  };
}

/**
 * Parse + validate the verifier response against the candidate set.
 * Lenient on shapes, STRICT on semantics: `selected` requires a valid
 * winnerIndex pointing at an OK candidate.
 */
export function parseSelectionVerdict(
  raw: string,
  candidates: readonly CandidateEntry[],
): { ok: true; verdict: KrakenSelectionVerdict } | { ok: false; error: string } {
  const open = raw.lastIndexOf(VERDICT_OPEN);
  const close = raw.lastIndexOf(VERDICT_CLOSE);
  if (open === -1 || close === -1 || close < open) {
    return { ok: false, error: 'missing verdict block' };
  }
  const body = raw.slice(open + VERDICT_OPEN.length, close).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { ok: false, error: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'verdict is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (status !== 'selected' && status !== 'needs_more_evidence') {
    return { ok: false, error: `invalid status (${String(status)})` };
  }
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : '';
  const requiredChecks = (Array.isArray(obj.requiredChecks) ? obj.requiredChecks : [])
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((c) => c.trim())
    .slice(0, 5);

  if (status === 'needs_more_evidence') {
    return {
      ok: true,
      verdict: {
        status,
        winnerIndex: null,
        rationale: rationale || 'Candidates are not sufficiently differentiated by evidence.',
        requiredChecks,
        degraded: false,
        verifier: null,
        judgedBy: 'llm',
      },
    };
  }

  const winner = obj.winnerIndex;
  if (typeof winner !== 'number' || !Number.isInteger(winner)) {
    return { ok: false, error: `selected without integer winnerIndex (${String(winner)})` };
  }
  const entry = candidates.find((c) => c.index === winner);
  if (!entry || entry.status !== 'ok') {
    return { ok: false, error: `winnerIndex ${winner} does not point at a usable candidate` };
  }
  return {
    ok: true,
    verdict: {
      status: 'selected',
      winnerIndex: winner,
      rationale: rationale || 'Selected by evidence comparison.',
      requiredChecks,
      degraded: false,
      verifier: null,
      judgedBy: 'llm',
    },
  };
}

// ── Selection run ──────────────────────────────────────────────────────────

export interface RunKrakenSelectionOpts {
  task: string;
  candidates: readonly CandidateEntry[];
  /** Verifier identity (already resolved — see resolveKrakenVerifier). */
  identity: KrakenVerifierIdentity;
  /**
   * Perform the judging LLM call. Must return the raw model text.
   * Throw on transport failure/timeout — the caller degrades gracefully.
   */
  callModel: (opts: {
    system: string;
    user: string;
    identity: KrakenVerifierIdentity;
  }) => Promise<string>;
}

/**
 * Run one selection. NEVER throws: every failure path degrades to a
 * `needs_more_evidence` verdict so the parent turn always continues.
 */
export async function runKrakenSelection(
  opts: RunKrakenSelectionOpts,
): Promise<KrakenSelectionVerdict> {
  const okEntries = opts.candidates.filter((c): c is Extract<CandidateEntry, { status: 'ok' }> =>
    c.status === 'ok',
  );

  // Deterministic short-circuit: nothing usable to compare.
  if (okEntries.length === 0) {
    return needsMoreEvidence(
      'No usable candidate reports this turn (all malformed). Proceed with your own judgment.',
      'no usable candidates',
    );
  }
  // Deterministic short-circuit: single candidate — nothing to compare.
  if (okEntries.length === 1) {
    return {
      status: 'selected',
      winnerIndex: okEntries[0].index,
      rationale: 'Single usable candidate this turn — selected without a comparison call.',
      requiredChecks: [],
      degraded: false,
      verifier: null,
      judgedBy: 'deterministic',
    };
  }

  const system = VERIFIER_SYSTEM_PROMPT;
  const user = buildSelectionPrompt(opts.task, opts.candidates);
  let raw: string;
  try {
    raw = await opts.callModel({ system, user, identity: opts.identity });
  } catch (err) {
    return needsMoreEvidence(
      `Verifier call failed (${
        err instanceof Error ? err.message : String(err)
      }). Proceed with your own judgment.`,
      'verifier call failed',
    );
  }
  const parsed = parseSelectionVerdict(raw, opts.candidates);
  if (!parsed.ok) {
    return needsMoreEvidence(
      `Verifier response unusable (${parsed.error}). Proceed with your own judgment.`,
      `malformed verifier response: ${parsed.error}`,
    );
  }
  return { ...parsed.verdict, verifier: opts.identity };
}
