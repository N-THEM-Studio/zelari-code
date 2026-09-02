/**
 * tools/eval/evolveValidate.test.ts — Fase 2.2 — validation runner tests.
 * Covers: the event-sourced fold in resolveProposalForValidation (unknown
 * id → undefined; effective status from the LAST record; source fields
 * from the LAST record that HAS a requiredValidation array — minimal
 * decision records never shadow them; empty ask lists), runValidations
 * with an INJECTED runner (pass/fail/spawn-error/timeout outcomes; ok IFF
 * exitCode === 0; sequential order; cwd plumbing; a throwing runner fails
 * closed; never rejects), evidenceString ('exit 0' IFF ok; spawn-error
 * rendering), and suggestedDecideCommand determinism + shape.
 */

import { describe, expect, it } from 'vitest';
import { type StoredProposal } from './evolvePropose.ts';
import {
  buildEvalValidationRow,
  EVAL_VALIDATION_MIN_RUNS,
  type CommandRunner,
  evidenceString,
  resolveProposalForValidation,
  runValidations,
  suggestedDecideCommand,
} from './evolveValidate.ts';

/** A realistic proposal record as the Fase 2.0 engine would append it. */
function proposalRecord(partial: Partial<StoredProposal> & { id: string }): StoredProposal {
  return {
    createdAt: '2025-07-01T09:30:00.000Z',
    status: 'proposed',
    operator: 'revise_tool_description',
    surface: 'tool:read_file',
    fingerprint: 'revise_tool_description|tool:read_file|read_file',
    evidence: { kinds: ['tool-misuse'], count: 4, sessions: ['s1'] },
    rationale: 'rationale',
    patchHint: 'hint',
    requiredValidation: ['npm run typecheck', 'npm run test:eval'],
    ...partial,
  };
}

/** A MINIMAL decision record — repeats the id WITHOUT surface/operator/requiredValidation. */
function minimalDecision(id: string, status: string): StoredProposal {
  return { id, status, decision: true, decidedAt: '2025-07-02T10:00:00.000Z' } as unknown as StoredProposal;
}

/** Runner stub returning canned results in order; records every call. */
function scriptedRunner(
  results: Array<{ exitCode: number | null; durationMs: number; spawnError?: string }>,
  calls?: { commands: string[]; cwds: string[] },
): CommandRunner {
  let i = 0;
  return (command, cwd) => {
    calls?.commands.push(command);
    calls?.cwds.push(cwd);
    return Promise.resolve(results[i++] ?? { exitCode: null, durationMs: 0, spawnError: 'script exhausted' });
  };
}

describe('resolveProposalForValidation — event-sourced fold', () => {
  it('unknown id (or empty id / empty store) → undefined', () => {
    const records = [proposalRecord({ id: 'p-0001' })];
    expect(resolveProposalForValidation(records, 'p-9999')).toBeUndefined();
    expect(resolveProposalForValidation([], 'p-0001')).toBeUndefined();
    expect(resolveProposalForValidation(records, '')).toBeUndefined();
  });

  it('single proposal record folds to identity: source === status record, asks preserved', () => {
    const rec = proposalRecord({ id: 'p-0001' });
    const resolved = resolveProposalForValidation([rec], 'p-0001');
    expect(resolved!.effectiveStatus).toBe('proposed');
    expect(resolved!.statusRecord).toBe(rec);
    expect(resolved!.sourceRecord).toBe(rec);
    expect(resolved!.surface).toBe('tool:read_file');
    expect(resolved!.operator).toBe('revise_tool_description');
    expect(resolved!.requiredValidation).toEqual(['npm run typecheck', 'npm run test:eval']);
  });

  it('minimal decision record AFTER the proposal: status folds, source fields survive (no shadowing)', () => {
    const proposed = proposalRecord({ id: 'p-0001' });
    const decision = minimalDecision('p-0001', 'applied');
    const resolved = resolveProposalForValidation([proposed, decision], 'p-0001');
    expect(resolved!.effectiveStatus).toBe('applied');
    expect(resolved!.statusRecord).toBe(decision);
    expect(resolved!.sourceRecord).toBe(proposed);
    expect(resolved!.surface).toBe('tool:read_file');
    expect(resolved!.operator).toBe('revise_tool_description');
    expect(resolved!.requiredValidation).toEqual(['npm run typecheck', 'npm run test:eval']);
  });

  it('withdrawn decision is the effective status; asks still come from the proposal record', () => {
    const proposed = proposalRecord({ id: 'p-0001' });
    const resolved = resolveProposalForValidation([proposed, minimalDecision('p-0001', 'withdrawn')], 'p-0001');
    expect(resolved!.effectiveStatus).toBe('withdrawn');
    expect(resolved!.sourceRecord).toBe(proposed);
    expect(resolved!.requiredValidation).toEqual(['npm run typecheck', 'npm run test:eval']);
  });

  it('review surface: empty requiredValidation array is a real source (resolved with [])', () => {
    const rec = proposalRecord({ id: 'p-0002', surface: 'verification:outcomes', operator: 'needs_human_review', requiredValidation: [] });
    const resolved = resolveProposalForValidation([rec], 'p-0002');
    expect(resolved).toBeDefined();
    expect(resolved!.requiredValidation).toEqual([]);
    expect(resolved!.sourceRecord).toBe(rec);
  });

  it('records exist but NONE has a requiredValidation array → asks [], sourceRecord undefined', () => {
    const resolved = resolveProposalForValidation([minimalDecision('p-0003', 'proposed')], 'p-0003');
    expect(resolved).toBeDefined();
    expect(resolved!.effectiveStatus).toBe('proposed');
    expect(resolved!.requiredValidation).toEqual([]);
    expect(resolved!.sourceRecord).toBeUndefined();
  });
});

describe('runValidations — sequential, fail-closed, never throws', () => {
  const OPTS = { cwd: 'Z:/tmp/whatever', timeoutMs: 600000 };

  it('ok IFF exitCode === 0; commands run sequentially in order with the given cwd', async () => {
    const calls = { commands: [] as string[], cwds: [] as string[] };
    const outcomes = await runValidations(['cmd-a', 'cmd-b', 'cmd-c'], {
      ...OPTS,
      run: scriptedRunner(
        [
          { exitCode: 0, durationMs: 10 },
          { exitCode: 1, durationMs: 20 },
          { exitCode: 0, durationMs: 30 },
        ],
        calls,
      ),
    });
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(outcomes.map((o) => o.durationMs)).toEqual([10, 20, 30]);
    expect(calls.commands).toEqual(['cmd-a', 'cmd-b', 'cmd-c']);
    expect(calls.cwds).toEqual([OPTS.cwd, OPTS.cwd, OPTS.cwd]);
  });

  it('non-zero exit is honestly failed with the exit code preserved', async () => {
    const [o] = await runValidations(['npm run test'], {
      ...OPTS,
      run: scriptedRunner([{ exitCode: 7, durationMs: 1234 }]),
    });
    expect(o!.ok).toBe(false);
    expect(o!.exitCode).toBe(7);
    expect(o!.durationMs).toBe(1234);
    expect(o!.spawnError).toBeUndefined();
  });

  it('spawn error (exitCode null + spawnError) → ok false, fail-closed', async () => {
    const [o] = await runValidations(['npm run missing'], {
      ...OPTS,
      run: scriptedRunner([{ exitCode: null, durationMs: 3, spawnError: 'spawn npm ENOENT' }]),
    });
    expect(o!.ok).toBe(false);
    expect(o!.exitCode).toBeNull();
    expect(o!.spawnError).toBe('spawn npm ENOENT');
  });

  it('timeout outcome (exitCode null, process killed) → ok false, never ok', async () => {
    const [o] = await runValidations(['npm run slow'], {
      ...OPTS,
      run: scriptedRunner([{ exitCode: null, durationMs: 5000, spawnError: 'timeout after 600000ms (process killed)' }]),
    });
    expect(o!.ok).toBe(false);
    expect(o!.exitCode).toBeNull();
  });

  it('a runner that THROWS folds into a failed outcome — runValidations never rejects', async () => {
    const outcomes = await runValidations(['cmd-x'], {
      ...OPTS,
      run: () => Promise.reject(new Error('boom')),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.exitCode).toBeNull();
    expect(outcomes[0]!.spawnError).toBe('boom');
  });

  it('empty ask list → no outcomes, runner never called', async () => {
    let calls = 0;
    const outcomes = await runValidations([], {
      ...OPTS,
      run: () => {
        calls += 1;
        return Promise.resolve({ exitCode: 0, durationMs: 0 });
      },
    });
    expect(outcomes).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('evidenceString — contains "exit 0" IFF ok', () => {
  it('ok outcome → exact format with "exit 0"', () => {
    const s = evidenceString('npm run typecheck', { command: 'npm run typecheck', exitCode: 0, ok: true, durationMs: 1234 });
    expect(s).toBe('npm run typecheck → exit 0 (1234ms)');
    expect(s.includes('exit 0')).toBe(true);
  });

  it('failed outcome → "exit <code>", NOT containing "exit 0"', () => {
    const s = evidenceString('npm run test', { command: 'npm run test', exitCode: 1, ok: false, durationMs: 5678 });
    expect(s).toBe('npm run test → exit 1 (5678ms)');
    expect(s.includes('exit 0')).toBe(false);
  });

  it('spawn-error outcome → "exit spawn-error", NOT containing "exit 0"', () => {
    const s = evidenceString('npm run x', {
      command: 'npm run x',
      exitCode: null,
      ok: false,
      durationMs: 3,
      spawnError: 'spawn npm ENOENT',
    });
    expect(s).toBe('npm run x → exit spawn-error (3ms)');
    expect(s.includes('exit 0')).toBe(false);
  });
});

describe('suggestedDecideCommand — deterministic and copy-pasteable', () => {
  it('same inputs → byte-identical output', () => {
    const evidence = ['npm run typecheck → exit 0 (1ms)', 'npm run test:eval → exit 1 (2ms)'];
    expect(suggestedDecideCommand('p-0001', evidence)).toBe(suggestedDecideCommand('p-0001', evidence));
  });

  it('shape: id + applied + <ref> placeholder on line 1, one quoted --evidence per entry, in order', () => {
    const s = suggestedDecideCommand('p-0001', ['npm run typecheck → exit 0 (12ms)', 'npm run test:eval → exit 0 (34ms)']);
    const lines = s.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('npm run evolve:decide -- --id p-0001 --decision applied --ref <ref> \\');
    expect(lines[1]).toBe('  --evidence "npm run typecheck → exit 0 (12ms)" \\');
    expect(lines[2]).toBe('  --evidence "npm run test:eval → exit 0 (34ms)"');
  });
});

describe('buildEvalValidationRow — Fase 3.0 measured-eval row', () => {
  it('anti-fabricated-green: default command carries --strict --fail-insufficient --min-runs 3', () => {
    const row = buildEvalValidationRow({ candidate: 'abc123' });
    expect(row).toBeDefined();
    expect(row?.command).toContain('npm run eval:measured --');
    expect(row?.command).toContain('--baseline latest');
    expect(row?.command).toContain('--candidate abc123');
    expect(row?.command).toContain('--strict');
    expect(row?.command).toContain('--fail-insufficient');
    expect(row?.command).toContain(`--min-runs ${EVAL_VALIDATION_MIN_RUNS}`);
    expect(EVAL_VALIDATION_MIN_RUNS).toBe(3);
    expect(row?.source).toBe('default');
  });

  it('baseline defaults to latest; explicit baseline is honored verbatim', () => {
    expect(buildEvalValidationRow({ candidate: 'c1' })?.baseline).toBe('latest');
    expect(buildEvalValidationRow({ baseline: 'deadbeef', candidate: 'c1' })?.command).toContain('--baseline deadbeef');
  });

  it('no candidate AND no command → undefined (nothing honest to run; CLI turns it into usage exit 2)', () => {
    expect(buildEvalValidationRow({})).toBeUndefined();
    expect(buildEvalValidationRow({ baseline: 'deadbeef' })).toBeUndefined();
    expect(buildEvalValidationRow({ candidate: '' })).toBeUndefined();
  });

  it('command override wins: used verbatim, never templated, source recorded as override', () => {
    const row = buildEvalValidationRow({ command: 'npm run eval:measured -- --baseline b1 --candidate c1', candidate: 'ignored' });
    expect(row?.command).toBe('npm run eval:measured -- --baseline b1 --candidate c1');
    expect(row?.source).toBe('override');
    expect(row?.candidate).toBe('ignored');
    expect(row?.baseline).toBe('latest');
  });

  it('e2e (pure): the row measured through runValidations is honest on pass AND fail', async () => {
    const row = buildEvalValidationRow({ candidate: 'c1' });
    expect(row).toBeDefined();
    const pass = await runValidations([row!.command], { cwd: '.', timeoutMs: 1000, run: scriptedRunner([{ exitCode: 0, durationMs: 5 }]) });
    expect(pass[0]?.ok).toBe(true);
    expect(evidenceString(row!.command, pass[0])).toContain('exit 0');
    const fail = await runValidations([row!.command], { cwd: '.', timeoutMs: 1000, run: scriptedRunner([{ exitCode: 1, durationMs: 5 }]) });
    expect(fail[0]?.ok).toBe(false);
    expect(evidenceString(row!.command, fail[0]).includes('exit 0')).toBe(false);
  });
});
