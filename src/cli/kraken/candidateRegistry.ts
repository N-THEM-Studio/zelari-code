/**
 * candidateRegistry — per-turn registry of Kraken candidate tentacles
 * (Fase 3, ADR-0020).
 *
 * A "candidate" is an explore-only tentacle spawned to research ONE
 * independent hypothesis. Its conclusion must end with a structured
 * `<candidate-report>` JSON block; this module parses it LENIENTLY:
 * malformed reports are preserved with `status: 'malformed'` (degraded
 * evidence is evidence about the candidate, never silently dropped).
 *
 * In-memory, per-process, reset each parent turn via
 * {@link resetKrakenCandidates} (same lifecycle as `resetTaskSpawnCount`).
 * The future `kraken_select` tool (Fase 4) will read from here.
 *
 * v1 invariant (ADR-0020): candidates are explore-only — zero candidate
 * implementations. The registry never stores edits or patches.
 */

/** One piece of evidence backing (or weakening) a hypothesis. */
export interface CandidateEvidence {
  /** What the evidence claims. */
  claim: string;
  /** Where it comes from (tool, file:line, command). */
  basis: string;
  /**
   * True when the observation was degraded/inconclusive (timeout, zero
   * files walked, unavailable backend). Degraded ≠ proof of absence.
   */
  degraded: boolean;
}

/** Parsed structured report of one candidate tentacle. */
export interface CandidateReport {
  /** The hypothesis this candidate investigated (normalized claim). */
  hypothesis: string;
  /** Evidence gathered, tagged with provenance + degraded flags. */
  evidence: CandidateEvidence[];
  /** Known risks / open questions the parent should weigh. */
  risks: string[];
  /** True when the report mentioned at least one degraded observation. */
  hasDegradedEvidence: boolean;
}

export type CandidateEntry =
  | {
      status: 'ok';
      index: number;
      description: string;
      report: CandidateReport;
      /** Raw conclusion text (for audits / debugging). */
      raw: string;
    }
  | {
      status: 'malformed';
      index: number;
      description: string;
      /** Parse failure reason (missing block, invalid JSON, …). */
      error: string;
      raw: string;
    };

/** Max candidates per parent turn (v1: 3 — ADR-0020 §candidate cap). */
export const KRAKEN_CANDIDATE_CAP = 3;

/** Feature flag: candidate contracts are alpha-gated (default OFF). */
export function isKrakenSelectionEnabled(): boolean {
  return process.env.ZELARI_KRAKEN_SELECTION === '1';
}

import type { KrakenSelectionVerdict } from './verifier.js';
import type { KrakenCheckResult, TentacleToolTrace } from './verifyReport.js';

type CandidateGlobal = {
  __zelariKrakenCandidates?: CandidateEntry[];
  /** Fase 4: verdict of the kraken_select call for THIS turn (if any). */
  __zelariKrakenSelection?: KrakenSelectionVerdict | null;
  /** Fase 7: per-check results of the LATEST verify tentacle this turn. */
  __zelariKrakenCheckResults?: KrakenCheckResult[] | null;
  /** 2.1 T5: raw tool executions captured by that same verify tentacle. */
  __zelariVerifyToolTrace?: TentacleToolTrace[] | null;
};

function store(): CandidateEntry[] {
  const g = globalThis as unknown as CandidateGlobal;
  if (!g.__zelariKrakenCandidates) g.__zelariKrakenCandidates = [];
  return g.__zelariKrakenCandidates;
}

/** Reset the per-turn candidate registry (call at each parent user turn). */
export function resetKrakenCandidates(): void {
  const g = globalThis as unknown as CandidateGlobal;
  g.__zelariKrakenCandidates = [];
  g.__zelariKrakenSelection = null;
  g.__zelariKrakenCheckResults = null;
  g.__zelariVerifyToolTrace = null;
}

/** Store the kraken_select verdict for this turn (Fase 6/8 consume it). */
export function setKrakenSelection(verdict: KrakenSelectionVerdict): void {
  const g = globalThis as unknown as CandidateGlobal;
  g.__zelariKrakenSelection = verdict;
}

/** Verdict of this turn's kraken_select call, or null when none ran. */
export function getKrakenSelection(): KrakenSelectionVerdict | null {
  const g = globalThis as unknown as CandidateGlobal;
  return g.__zelariKrakenSelection ?? null;
}

/**
 * Required checks of THIS turn's selection (Fase 6, ADR-0020).
 *
 * Only a `selected` verdict carries proof obligations: the checks belong to
 * the winning candidate's path. A needs_more_evidence verdict leaves the
 * judgment (and any acceptance) to the parent — its checks stay advisory
 * (already visible in the kraken_select result text).
 */
export function krakenRequiredChecks(): string[] {
  const verdict = getKrakenSelection();
  if (!verdict || verdict.status !== 'selected') return [];
  return verdict.requiredChecks;
}

/**
 * Fase 7 (ADR-0020): store the per-check results of the latest verify
 * tentacle. Called by the task tool for EVERY verify tentacle when the
 * turn has required checks — a later tentacle replaces earlier results
 * (the runtime counter follows the latest verification state).
 */
export function setKrakenCheckResults(
  results: KrakenCheckResult[],
  toolTrace?: readonly TentacleToolTrace[],
): void {
  const g = globalThis as unknown as CandidateGlobal;
  g.__zelariKrakenCheckResults = results;
  // 2.1 T5: keep the raw tool executions alongside the notes so the strict
  // gate can anchor evidence to real tool output instead of re-emitted notes.
  g.__zelariVerifyToolTrace = toolTrace ? [...toolTrace] : null;
}

/**
 * Per-check results of the latest verify tentacle this turn, or null when
 * no verify tentacle reported (yet).
 */
export function getKrakenCheckResults(): KrakenCheckResult[] | null {
  const g = globalThis as unknown as CandidateGlobal;
  const results = g.__zelariKrakenCheckResults;
  return results ? [...results] : null;
}

/**
 * 2.1 T5: raw tool executions captured by the latest verify tentacle this
 * turn (null when none ran or the tentacle executed no tools). Consumed by
 * the verification bridge to anchor EvidenceRefs to real tool output.
 */
export function getLastVerifyToolTrace(): TentacleToolTrace[] | null {
  const g = globalThis as unknown as CandidateGlobal;
  const trace = g.__zelariVerifyToolTrace;
  return trace ? [...trace] : null;
}

/**
 * Passed-check counter (Fase 7): how many required checks carry an explicit
 * `pass`. `unknown` NEVER counts — a degraded observation is not proof
 * (§23). undefined when no verify report landed yet this turn.
 */
export function krakenChecksPassed(): number | undefined {
  const results = getKrakenCheckResults();
  if (!results) return undefined;
  return results.filter((r) => r.status === 'pass').length;
}

/** Candidates registered this turn (defensive copy). */
export function krakenCandidates(): readonly CandidateEntry[] {
  return [...store()];
}

/**
 * Try to reserve a candidate slot. Returns the 1-based index, or an error
 * string when the cap is reached (caller turns it into a typedErr).
 */
export function reserveCandidateSlot(): { index: number } | { error: string } {
  const n = store().length;
  if (n >= KRAKEN_CANDIDATE_CAP) {
    return {
      error:
        `task: candidate cap reached (${KRAKEN_CANDIDATE_CAP}). ` +
        'Compare the existing candidates instead of spawning more.',
    };
  }
  return { index: n + 1 };
}

const REPORT_OPEN = '<candidate-report>';
const REPORT_CLOSE = '</candidate-report>';

/**
 * Extract + parse the structured report from a candidate conclusion.
 * Lenient by design:
 *   - no block            → malformed('missing report block')
 *   - invalid JSON        → malformed('invalid JSON')
 *   - missing fields      → filled with safe defaults (empty arrays / '')
 *   - evidence items      → degraded defaults to false; extra keys dropped
 */
export function parseCandidateReport(raw: string): { ok: true; report: CandidateReport } | { ok: false; error: string } {
  const open = raw.lastIndexOf(REPORT_OPEN);
  const close = raw.lastIndexOf(REPORT_CLOSE);
  if (open === -1 || close === -1 || close < open) {
    return { ok: false, error: 'missing report block' };
  }
  const body = raw.slice(open + REPORT_OPEN.length, close).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'report is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const evidence: CandidateEvidence[] = Array.isArray(obj.evidence)
    ? obj.evidence
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => ({
          claim: typeof e.claim === 'string' ? e.claim : '',
          basis: typeof e.basis === 'string' ? e.basis : '',
          degraded: e.degraded === true,
        }))
        .filter((e) => e.claim.trim().length > 0)
    : [];
  const risks: string[] = Array.isArray(obj.risks)
    ? obj.risks.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];
  return {
    ok: true,
    report: {
      hypothesis: typeof obj.hypothesis === 'string' ? obj.hypothesis.trim() : '',
      evidence,
      risks,
      hasDegradedEvidence: evidence.some((e) => e.degraded),
    },
  };
}

/** Register a finished candidate (parsed or malformed). */
/** Input shape of {@link registerCandidate} (index optional, auto-assigned). */
export type CandidateRegistration =
  | (Omit<Extract<CandidateEntry, { status: 'ok' }>, 'index'> & { index?: number })
  | (Omit<Extract<CandidateEntry, { status: 'malformed' }>, 'index'> & { index?: number });

export function registerCandidate(entry: CandidateRegistration): CandidateEntry {
  const withIndex = { ...entry, index: entry.index ?? store().length + 1 } as CandidateEntry;
  store().push(withIndex);
  return withIndex;
}

/**
 * Instructions appended to the explore system prompt when the tentacle is a
 * candidate: diversity + structured payload + observation integrity.
 */
export const CANDIDATE_INSTRUCTIONS = [
  'You are CANDIDATE #{index} of at most {cap}: one independent hypothesis',
  'about the task, researched in parallel with other candidates.',
  'DIVERSITY: focus on ONE hypothesis and pursue it honestly — do not try to',
  'cover every angle. A narrower, well-evidenced hypothesis beats a broad guess.',
  'OBSERVATION INTEGRITY: mark degraded or inconclusive observations explicitly',
  '(timeout, zero files walked, unavailable backend) — degraded is NOT proof',
  'of absence.',
  'END your final message with EXACTLY this block (valid JSON, no prose after):',
  '<candidate-report>',
  '{',
  '  "hypothesis": "one-sentence hypothesis you investigated",',
  '  "evidence": [',
  '    { "claim": "what you found", "basis": "tool + file:line or command", "degraded": false }',
  '  ],',
  '  "risks": ["open questions / weaknesses"]',
  '}',
  '</candidate-report>',
].join('\n');

/** Render the instructions for one candidate index. */
export function candidateInstructions(index: number, cap = KRAKEN_CANDIDATE_CAP): string {
  return CANDIDATE_INSTRUCTIONS.replaceAll('{index}', String(index)).replaceAll('{cap}', String(cap));
}
