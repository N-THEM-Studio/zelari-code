/*
 * tools/eval/runEvolveValidate.ts — Fase 2.2 — evolution validation CLI
 * (advisory; MEASURES a stored proposal's requiredValidation asks and
 * renders ready-to-use `--evidence` strings for evolve:decide. It NEVER
 * mutates the proposals store and NEVER creates worktrees — the human
 * gate is structural: this tool only produces the measured inputs).
 *
 *   node --experimental-strip-types tools/eval/runEvolveValidate.ts \
 *     --id <p-NNNN> [--cwd <dir>] [--store <file>] [--timeout-ms <n>] [--json]
 *
 * Store: <cwd>/.zelari/evolution/proposals.jsonl (override --store) —
 * READ-ONLY here; this runner writes nothing, anywhere. Commands run
 * through the shell (npm run needs it, notably on Windows) in --cwd,
 * sequentially, with a PER-COMMAND timeout. A killed or unspawnable
 * command has no exit code → reported as ok:false (fail-closed).
 *
 * ADVISORY semantics (like runEvidenceReport.ts): exit 0 once the
 * measurement report is produced — pass/fail of the validation commands
 * does NOT change the exit (an honest ✗ is a success of the tool). Exit 2
 * ONLY for usage/validation errors (missing --id, bad flag values,
 * unknown id).
 */

import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { parseProposalStore, type StoredProposal } from './evolvePropose.ts';
import {
  buildEvalValidationRow,
  type CommandRunner,
  type EvalValidationRow,
  evidenceString,
  resolveProposalForValidation,
  runValidations,
  suggestedDecideCommand,
  type ValidationOutcome,
} from './evolveValidate.ts';

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** True when `--name` is present but its value is missing (absent or another flag). Usage error. */
function flagWithoutValue(name: string): boolean {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && (i + 1 >= argv.length || argv[i + 1].startsWith('--'));
}

function usage(): string {
  return 'usage: runEvolveValidate.ts --id <p-NNNN> [--cwd <dir>] [--store <file>] [--timeout-ms <n>] [--json] [--with-eval [--eval-baseline <hash|latest>] [--eval-candidate <hash>] [--eval-command <cmd>]]';
}

// Local store reader (same tolerant behavior as runEvolveDecide.ts — CLI
// files do not import CLI files): missing store → empty; unreadable → empty.
function readStore(file: string): { records: StoredProposal[]; malformed: number } {
  if (!existsSync(file)) return { records: [], malformed: 0 };
  try {
    return parseProposalStore(readFileSync(file, 'utf-8').split(/\r?\n/));
  } catch {
    return { records: [], malformed: 0 };
  }
}

/**
 * The real runner: one child process per command THROUGH THE SHELL (`npm
 * run` needs a shell, notably on Windows). The timeout is PER COMMAND; a
 * killed or unspawnable command resolves (never rejects) with exitCode
 * null + spawnError — the core folds that to ok:false.
 */
function execRunner(timeoutMs: number): CommandRunner {
  return (command, dir) =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      exec(command, { cwd: dir, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err) => {
        const durationMs = Date.now() - startedAt;
        if (err === null) {
          resolve({ exitCode: 0, durationMs });
          return;
        }
        const code: unknown = (err as NodeJS.ErrnoException).code;
        if (typeof code === 'number') {
          // The command RAN and exited non-zero — an honestly measured failure.
          resolve({ exitCode: code, durationMs });
          return;
        }
        // No exit code: spawn failure (ENOENT…) or timeout kill — fail-closed.
        const reason =
          err.killed === true
            ? `timeout after ${timeoutMs}ms (process killed)`
            : (err.message.split(/\r?\n/, 1)[0] ?? 'spawn failed');
        resolve({ exitCode: null, durationMs, spawnError: reason });
      });
    });
}

function statusWarning(id: string, effectiveStatus: string): string | undefined {
  return effectiveStatus !== 'proposed'
    ? `warning: effective status of ${id} is '${effectiveStatus}' — not 'proposed'; this proposal was already decided (measurement only — nothing written)`
    : undefined;
}

async function validateMode(storePath: string, json: boolean): Promise<number> {
  const id = arg('id') ?? '';
  const dir = path.resolve(arg('cwd') ?? cwd());
  const timeoutRaw = arg('timeout-ms');
  let timeoutMs = 600000;
  if (timeoutRaw !== undefined) {
    const parsed = Number.parseInt(timeoutRaw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      console.error(`runEvolveValidate: --timeout-ms must be a positive integer (got '${timeoutRaw}')`);
      console.error(usage());
      return 2;
    }
    timeoutMs = parsed;
  }

  const { records, malformed } = readStore(storePath);
  const resolved = resolveProposalForValidation(records, id);
  if (resolved === undefined) {
    console.error(
      `runEvolveValidate: unknown proposal id '${id}' — no record with that id in the store (store: ${storePath}); run evolve:decide --list to see recorded ids`,
    );
    console.error(usage());
    return 2;
  }
  const warning = statusWarning(id, resolved.effectiveStatus);

  // Fase 3.0 — the measured anchor gate as one more honestly-measured row.
  const withEval = argv.includes('--with-eval');
  const evalRow: EvalValidationRow | undefined = withEval
    ? buildEvalValidationRow({
        baseline: arg('eval-baseline'),
        candidate: arg('eval-candidate'),
        command: arg('eval-command'),
      })
    : undefined;
  if (withEval && evalRow === undefined) {
    console.error(
      'runEvolveValidate: --with-eval requires --eval-candidate <manifestHash> (or an explicit --eval-command override)',
    );
    console.error(usage());
    return 2;
  }

  if (resolved.requiredValidation.length === 0 && evalRow === undefined) {
    const note = 'no automated validation for this surface — human review IS the operator';
    if (json) {
      console.log(
        JSON.stringify(
          {
            id,
            effectiveStatus: resolved.effectiveStatus,
            surface: resolved.surface,
            operator: resolved.operator,
            requiredValidation: [],
            outcomes: [],
            warnings: warning === undefined ? [] : [warning],
            note,
          },
          null,
          2,
        ),
      );
    } else {
      const lines: string[] = [];
      lines.push('=== zelari evolve:validate — Fase 2.2 (measures; never mutates the store, never creates worktrees) ===');
      lines.push(`${id}  ${resolved.effectiveStatus.padEnd(8)}  ${resolved.operator || '?'}  ${resolved.surface || '?'}`);
      lines.push(note);
      if (warning !== undefined) lines.push(warning);
      console.log(lines.join('\n'));
    }
    return 0;
  }

  const commands =
    evalRow === undefined ? resolved.requiredValidation : [...resolved.requiredValidation, evalRow.command];
  const outcomes = await runValidations(commands, {
    cwd: dir,
    timeoutMs,
    run: execRunner(timeoutMs),
  });
  const evidence = outcomes.map((o) => evidenceString(o.command, o));
  const passed = outcomes.filter((o) => o.ok).length;
  const withoutExit = outcomes.filter((o) => o.exitCode === null).length;
  const suggested = suggestedDecideCommand(id, evidence);

  if (json) {
    console.log(
      JSON.stringify(
        {
          id,
          effectiveStatus: resolved.effectiveStatus,
          surface: resolved.surface,
          operator: resolved.operator,
          cwd: dir,
          timeoutMs,
          storePath,
          malformed,
          requiredValidation: resolved.requiredValidation,
          outcomes,
          evidence,
          suggestedCommand: suggested,
          evalRow,
          warnings: warning === undefined ? [] : [warning],
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push('=== zelari evolve:validate — Fase 2.2 (measures; never mutates the store, never creates worktrees) ===');
  lines.push(`${id}  ${resolved.effectiveStatus.padEnd(8)}  ${resolved.operator || '?'}  ${resolved.surface || '?'}  (cwd: ${dir})`);
  for (const o of outcomes as ValidationOutcome[]) {
    const suffix = o.spawnError !== undefined ? ` — ${o.spawnError}` : '';
    lines.push(`${o.ok ? '✓' : '✗'} ${evidenceString(o.command, o)}${suffix}`);
  }
  if (evalRow !== undefined) {
    const target =
      evalRow.source === 'override'
        ? evalRow.command
        : `baseline ${evalRow.baseline} → candidate ${evalRow.candidate}`;
    lines.push(`eval row (Fase 3.0, measured like any other command): ${target}`);
  }
  lines.push(`=== ${outcomes.length} command(s): ${passed} passed, ${outcomes.length - passed} failed (${withoutExit} without exit code) ===`);
  if (warning !== undefined) lines.push(warning);
  if (resolved.effectiveStatus === 'proposed') {
    lines.push(`# isolation recipe (printed, never executed — validate off your working tree if you prefer):`);
    lines.push(`#   git worktree add .zelari/worktrees/evolve-${id} -b evolve/${id} HEAD`);
    lines.push(`#   npm run evolve:validate -- --id ${id} --cwd .zelari/worktrees/evolve-${id}`);
  }
  lines.push('suggested decision command (evidence above is MEASURED — review honestly; fill <ref>):');
  lines.push('');
  lines.push(suggested);
  lines.push('');
  lines.push(`store: ${storePath} (read-only — this runner wrote nothing)`);
  console.log(lines.join('\n'));
  // Measurement report produced → success, regardless of ✓/✗ (advisory Fase 2.2).
  return 0;
}

async function main(): Promise<number> {
  for (const valueFlag of ['id', 'cwd', 'store', 'timeout-ms', 'eval-baseline', 'eval-candidate', 'eval-command']) {
    if (flagWithoutValue(valueFlag)) {
      console.error(`runEvolveValidate: --${valueFlag} requires a value`);
      console.error(usage());
      return 2;
    }
  }
  if (!argv.includes('--id')) {
    console.error('runEvolveValidate: --id <p-NNNN> is required');
    console.error(usage());
    return 2;
  }
  const storePath = path.resolve(arg('store') ?? path.join(cwd(), '.zelari', 'evolution', 'proposals.jsonl'));
  const json = argv.includes('--json');
  return validateMode(storePath, json);
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  // Exit only AFTER the async validations complete — a synchronous exit(0)
  // would kill the process before the report is printed (see runAnchors.ts).
  main().then(
    (code) => exit(code),
    (err: unknown) => {
      console.error(`runEvolveValidate: ${(err as Error).message}`);
      exit(2);
    },
  );
}
