/**
 * tools/eval/evolveValidate.ts — Fase 2.2 — evolution VALIDATION core
 * (EXECUTES a stored proposal's requiredValidation asks and renders the
 * ready-to-use `--evidence` strings evolve:decide consumes; MEASURES —
 * never mutates the proposals store, never creates worktrees).
 *
 * Position in the pipeline: evolve:propose (2.0) writes proposals →
 * evolve:validate (2.2, this file) runs each requiredValidation command
 * and turns the measured outcomes into evidence strings → evolve:decide
 * (2.1) records the human decision behind its fail-closed evidence gates.
 * The runner is a measuring instrument, not an actor: outcomes are
 * reported honestly — a failed or unspawnable command is NEVER dressed up
 * as a pass (fail-closed: an unmeasured command is never ok) — and
 * nothing is ever written back. The human gate is structural: this file
 * only produces the INPUTS for an operator's decision.
 *
 * The core is pure — no I/O, no clock: runValidations takes an INJECTED
 * runner (tests never spawn real processes; durationMs comes from the
 * runner, never from Date.now). resolveProposalForValidation folds the
 * event-sourced store exactly like effectiveStatusById: the LAST record
 * wins for status; source fields come from the LAST record that actually
 * HAS a requiredValidation array — minimal decision records (Fase 2.1)
 * repeat the id without the ask list and must not shadow it.
 */

import { type StoredProposal } from './evolvePropose.ts';

/** Result of ONE measured command. `ok` is fail-closed: true IFF exitCode === 0. */
export interface ValidationOutcome {
  command: string;
  /** null when the command never produced an exit code (spawn failure / timeout kill). */
  exitCode: number | null;
  ok: boolean;
  durationMs: number;
  /** Why no exit code exists (spawn failure reason / 'timeout after Nms'). */
  spawnError?: string;
}

/** The injected runner's result — the pure core never measures time itself. */
export interface CommandRunResult {
  exitCode: number | null;
  durationMs: number;
  spawnError?: string;
}

export type CommandRunner = (command: string, cwd: string) => Promise<CommandRunResult>;

/** The proposal an id resolves to, with the event-sourced fold already applied. */
export interface ResolvedProposal {
  id: string;
  /** LAST record's status in file order (same fold as effectiveStatusById). */
  effectiveStatus: string;
  surface: string;
  operator: string;
  /** String entries of the source record's requiredValidation array ([] when absent). */
  requiredValidation: string[];
  /** LAST record for the id — carries the effective status. */
  statusRecord: StoredProposal;
  /** LAST record for the id that HAS a requiredValidation array (undefined when none does). */
  sourceRecord: StoredProposal | undefined;
}

/**
 * Fold the store records for ONE id (file order). Effective status = LAST
 * record's status; source fields (surface/operator/requiredValidation) =
 * LAST record that actually HAS a requiredValidation array, so a minimal
 * decision record appended later cannot shadow the proposal's ask list.
 * No record for the id → undefined. Records exist but none carries the
 * ask list → resolved with requiredValidation [] (the CLI then says
 * honestly that human review is the operator).
 */
export function resolveProposalForValidation(records: StoredProposal[], id: string): ResolvedProposal | undefined {
  if (typeof id !== 'string' || id === '') return undefined;
  let statusRecord: StoredProposal | undefined;
  let sourceRecord: StoredProposal | undefined;
  for (const r of records) {
    if (r === null || typeof r !== 'object' || r.id !== id) continue;
    statusRecord = r;
    if (Array.isArray(r.requiredValidation)) sourceRecord = r;
  }
  if (statusRecord === undefined) return undefined;
  const src = sourceRecord;
  return {
    id,
    effectiveStatus: String(statusRecord.status),
    surface: src !== undefined ? String(src.surface ?? '') : '',
    operator: src !== undefined ? String(src.operator ?? '') : '',
    requiredValidation:
      src !== undefined && Array.isArray(src.requiredValidation)
        ? src.requiredValidation.filter((v): v is string => typeof v === 'string')
        : [],
    statusRecord,
    sourceRecord: src,
  };
}

export interface RunValidationsOpts {
  cwd: string;
  timeoutMs: number;
  run: CommandRunner;
}

/**
 * Run each command SEQUENTIALLY through the injected runner; NEVER throws
 * on command failure — every command yields exactly one outcome, and an
 * outcome is ok IFF its exit code is 0. A spawn failure has exitCode null
 * → ok false (fail-closed); even a runner that THROWS folds into a failed
 * outcome so the report is always complete.
 */
export async function runValidations(commands: string[], opts: RunValidationsOpts): Promise<ValidationOutcome[]> {
  const outcomes: ValidationOutcome[] = [];
  for (const command of commands) {
    try {
      const r = await opts.run(command, opts.cwd);
      const exitCode = typeof r.exitCode === 'number' ? r.exitCode : null;
      const outcome: ValidationOutcome = {
        command,
        exitCode,
        ok: exitCode === 0,
        durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : 0,
      };
      if (typeof r.spawnError === 'string') outcome.spawnError = r.spawnError;
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        command,
        exitCode: null,
        ok: false,
        durationMs: 0,
        spawnError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

/**
 * The evidence string for one outcome:
 * `<command> → exit <exitCode|spawn-error> (<durationMs>ms)`. Contains the
 * literal substring 'exit 0' IFF the outcome is ok — exactly the heuristic
 * decide() warns on — so evidence produced here flows through
 * evolve:decide warning-free when (and only when) the command really passed.
 */
export function evidenceString(command: string, outcome: ValidationOutcome): string {
  const exitToken = outcome.exitCode === 0 ? '0' : outcome.exitCode === null ? 'spawn-error' : String(outcome.exitCode);
  return `${command} → exit ${exitToken} (${outcome.durationMs}ms)`;
}

/**
 * Deterministic, copy-pasteable evolve:decide invocation: one
 * `--evidence "<string>"` flag per line, `<ref>` left for the operator to
 * fill. Uses the decide CLI's actual flag (`--decision`, runEvolveDecide.ts)
 * so the pasted command really runs.
 */
export function suggestedDecideCommand(id: string, evidenceStrings: string[]): string {
  const lines: string[] = [`npm run evolve:decide -- --id ${id} --decision applied --ref <ref>`];
  for (const e of evidenceStrings) lines.push(`  --evidence "${e}"`);
  return lines.join(' \\\n');
}

/**
 * Fase 3.0 — minimum runs demanded by the default eval row. Kept as a
 * named constant so tests can pin the anti-fabricated-green shape.
 */
export const EVAL_VALIDATION_MIN_RUNS = 3;

/** Input for the Fase 3.0 measured-eval validation row (all optional; see semantics below). */
export interface EvalValidationInput {
  /** Baseline manifest hash or 'latest' — defaults to 'latest' when empty/absent. */
  baseline?: string;
  /** Candidate manifest hash — REQUIRED unless `command` overrides everything. */
  candidate?: string;
  /** Full command override — used VERBATIM (the anti-fabricated-green escape hatch for custom pipelines). */
  command?: string;
}

/** The measured-eval row `--with-eval` appends to the validation sequence. */
export interface EvalValidationRow {
  /** The exact command to measure (run like any other requiredValidation entry). */
  command: string;
  /** Baseline as resolved here ('latest' or the explicit hash) — context for the report. */
  baseline: string;
  /** Candidate hash; '' when a `command` override replaced the templated invocation. */
  candidate: string;
  /** 'default' = templated (safe) invocation; 'override' = operator-supplied command. */
  source: 'default' | 'override';
}

/**
 * Build the Fase 3.0 measured-eval validation row. Returns undefined when
 * there is nothing honest to run (no candidate AND no command override) —
 * the CLI turns that into a usage error rather than fabricating a row.
 *
 * Anti-fabricated-green: the DEFAULT command is templated with
 * `--strict --fail-insufficient --min-runs 3` so an unmeasurable delta
 * (insufficient-n) exits 1 instead of reading as green; only an explicit
 * `--eval-command` can bypass that, and the row then records
 * source:'override' so the report says so.
 */
export function buildEvalValidationRow(input: EvalValidationInput): EvalValidationRow | undefined {
  const baseline =
    input.baseline === undefined || input.baseline === '' ? 'latest' : input.baseline;
  if (input.command !== undefined && input.command !== '') {
    return { command: input.command, baseline, candidate: input.candidate ?? '', source: 'override' };
  }
  if (input.candidate === undefined || input.candidate === '') return undefined;
  return {
    command: `npm run eval:measured -- --baseline ${baseline} --candidate ${input.candidate} --strict --fail-insufficient --min-runs ${EVAL_VALIDATION_MIN_RUNS}`,
    baseline,
    candidate: input.candidate,
    source: 'default',
  };
}
