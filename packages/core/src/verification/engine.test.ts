import { describe, expect, it } from 'vitest';
import { VerificationEngine } from './engine.js';
import {
  DEFAULT_COMMAND_CONCURRENCY,
  isVerifyParallelEnabled,
  resolveCommandConcurrency,
} from './commandConcurrency.js';
import { MemoryFsProvider, MemoryShellProvider } from '../runtime/memoryProviders.js';
import type { Criterion, VerificationResult } from './types.js';
import type { SessionEventInput } from '../session/types.js';
import type { ShellProvider } from '../runtime/providers.js';

/** Int2a: a shell that sleeps per call and records peak concurrency. */
function delayedShell(delayMs: number): {
  shell: ShellProvider;
  peak: () => number;
  calls: string[];
} {
  let inFlight = 0;
  let peak = 0;
  const calls: string[] = [];
  const shell: ShellProvider = {
    async exec(command: string) {
      calls.push(command);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      const bad = command.includes('bad');
      return {
        exitCode: bad ? 1 : 0,
        stdout: `${command}: ${bad ? 'boom' : 'ok'}`,
        stderr: bad ? 'assertion' : '',
        durationMs: delayMs,
        timedOut: false,
      };
    },
  };
  return { shell, peak: () => peak, calls };
}

/** Int2a: N command criteria (`c0`, `c1`, …) over the given commands. */
function commandCriteria(commands: readonly string[]): Criterion[] {
  return commands.map((command, i) => ({
    id: `c${i}`,
    text: command,
    source: 'task' as const,
    required: true,
    check: { kind: 'command' as const, command },
  }));
}

/** Int2a: pin the verify env vars for one test, then restore them verbatim. */
async function withVerifyEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = ['ZELARI_VERIFY_PARALLEL', 'ZELARI_VERIFY_CONCURRENCY'];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) {
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function result(criterionId: string, status: VerificationResult['status'], evidence = 1): VerificationResult {
  return {
    criterionId,
    status,
    source: 'deterministic-engine',
    evidence: Array.from({ length: evidence }, () => ({
      tier: 'command-output',
      ref: 'cmd',
      capturedAt: 0,
    })),
    evaluatedAt: 0,
    durationMs: 0,
  };
}

describe('VerificationEngine (deterministic, zero LLM)', () => {
  it('passes/fails command checks on exit code and stdout substring', async () => {
    const shell = new MemoryShellProvider([
      { match: 'ok-cmd', result: { exitCode: 0, stdout: 'all good (3 passed)' } },
      { match: 'bad-exit', result: { exitCode: 1, stderr: 'boom' } },
      { match: 'no-substring', result: { exitCode: 0, stdout: 'something else' } },
    ]);
    const engine = new VerificationEngine({ shell });
    const criteria: Criterion[] = [
      { id: 'a', text: 'ok', source: 'task', required: true, check: { kind: 'command', command: 'ok-cmd', expectStdoutIncludes: '3 passed' } },
      { id: 'b', text: 'bad', source: 'task', required: true, check: { kind: 'command', command: 'bad-exit' } },
      { id: 'c', text: 'missing substring', source: 'task', required: true, check: { kind: 'command', command: 'no-substring', expectStdoutIncludes: 'NOPE' } },
    ];
    const results = await engine.evaluate(criteria);
    expect(results.map((r) => r.status)).toEqual(['pass', 'fail', 'fail']);
    expect(results[0]?.evidence[0]).toMatchObject({ tier: 'command-output' });
    expect(results[0]?.evidence[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(results[0]?.evidence[0]?.ref).toContain('ok-cmd');
    expect(results[1]?.detail).toContain('exit 1');
  });

  it('command timeout is unknown, not fail and not pass', async () => {
    const shell = new MemoryShellProvider([
      { match: 'slow', result: { exitCode: null, timedOut: true, stdout: '' } },
    ]);
    const engine = new VerificationEngine({ shell });
    const [r] = await engine.evaluate([
      { id: 't', text: 'timeout', source: 'task', required: true, check: { kind: 'command', command: 'slow', timeoutMs: 50 } },
    ]);
    expect(r?.status).toBe('unknown');
    expect(r?.detail).toContain('timed out');
  });

  it('file checks: exists / contains (substring and regex) / absent', async () => {
    const fs = new MemoryFsProvider({ 'src/a.ts': 'export const ANSWER = 42;', 'old.txt': 'legacy' });
    const engine = new VerificationEngine({ fs });
    const criteria: Criterion[] = [
      { id: 'e', text: 'exists', source: 'task', required: true, check: { kind: 'file-exists', path: 'src/a.ts' } },
      { id: 'c1', text: 'contains literal', source: 'task', required: true, check: { kind: 'file-contains', path: 'src/a.ts', pattern: 'ANSWER = 42' } },
      { id: 'c2', text: 'contains regex', source: 'task', required: true, check: { kind: 'file-contains', path: 'src/a.ts', pattern: 'ANSWER\\s*=\\s*42' } },
      { id: 'a1', text: 'absent', source: 'task', required: true, check: { kind: 'file-absent', path: 'gone.txt' } },
      { id: 'a2', text: 'still present', source: 'task', required: true, check: { kind: 'file-absent', path: 'old.txt' } },
    ];
    const results = await engine.evaluate(criteria);
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'fail']);
  });

  it('a criterion without a check is unknown — never pass', async () => {
    const engine = new VerificationEngine({});
    const [r] = await engine.evaluate([
      { id: 'x', text: 'unverifiable', source: 'task', required: true },
    ]);
    expect(r?.status).toBe('unknown');
    expect(r?.detail).toContain('unknown ≠ pass');
  });

  it('missing providers are unknown, and evidence is traceable', async () => {
    const engine = new VerificationEngine({});
    const [cmd, file] = await engine.evaluate([
      { id: 'c', text: 'cmd', source: 'task', required: true, check: { kind: 'command', command: 'x' } },
      { id: 'f', text: 'file', source: 'task', required: true, check: { kind: 'file-exists', path: 'x' } },
    ]);
    expect(cmd?.status).toBe('unknown');
    expect(file?.status).toBe('unknown');
  });

  it('emits a verification.run event on the session spine', async () => {
    const emitted: SessionEventInput[] = [];
    const shell = new MemoryShellProvider([{ match: 'ok', result: { exitCode: 0, stdout: '' } }]);
    const engine = new VerificationEngine(
      { shell },
      { emit: async (input) => { emitted.push(input); } },
    );
    await engine.evaluate(
      [{ id: 'a', text: 'ok', source: 'task', required: true, check: { kind: 'command', command: 'ok' } }],
      { packId: 'zelari-coding/v1' },
    );
    // F3: the observation lands first (verification.evidence), then the run summary.
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.kind).toBe('verification.evidence');
    expect(emitted[1]?.kind).toBe('verification.run');
    const data = emitted[1]?.data as { source: string; packId?: string; results: unknown[] };
    expect(data.source).toBe('deterministic-engine');
    expect(data.packId).toBe('zelari-coding/v1');
    expect(data.results).toHaveLength(1);
  });

  it('quality.scope-discipline is advisory: concern → unknown, not fail', async () => {
    const engine = new VerificationEngine({});
    const [r] = await engine.evaluate(
      [
        {
          id: 'quality.scope-discipline',
          text: 'minimal diff',
          source: 'criteria-pack',
          required: false,
        },
      ],
      { scope: { changedFiles: ['js/a.js', 'progress.html'], expectedFiles: ['js/a.js'] } },
    );
    expect(r?.status).toBe('unknown');
    expect(r?.detail).toContain('progress.html');
  });

  it('Int2b: a cached observation is annotated, never reinterpreted', async () => {
    const emitted: SessionEventInput[] = [];
    const shell: ShellProvider = {
      async exec() {
        return {
          exitCode: 1,
          stdout: 'boom (3 failed)',
          stderr: 'assertion',
          durationMs: 0,
          timedOut: false,
          cached: true,
        };
      },
    };
    const engine = new VerificationEngine(
      { shell },
      {
        emit: async (input) => {
          emitted.push(input);
          return { seq: 7 };
        },
      },
    );
    const [r] = await engine.evaluate([
      { id: 'c', text: 'tests', source: 'task', required: true, check: { kind: 'command', command: 'npm test' } },
    ]);
    // Verdict untouched: a cached FAIL is still FAIL, same digest, same anchor.
    expect(r?.status).toBe('fail');
    expect(r?.evidence[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r?.evidence[0]?.seq).toBe(7);
    expect(r?.evidence[0]?.ref).toContain('exit 1');
    expect(r?.detail).toContain('exit 1 (expected 0)');
    expect(r?.detail).toContain('cached — tree unchanged since last run');
    // Provenance lands on the spine payload as an additive optional field.
    const evidence = emitted.find((e) => e.kind === 'verification.evidence');
    expect(evidence?.data).toMatchObject({ observation: 'command', command: 'npm test', cached: true });

    // A cached pass gets the note too (no other detail to append to).
    const passShell: ShellProvider = {
      async exec() {
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 0, timedOut: false, cached: true };
      },
    };
    const [ok] = await new VerificationEngine({ shell: passShell }).evaluate([
      { id: 'p', text: 'ok', source: 'task', required: true, check: { kind: 'command', command: 'npm run typecheck' } },
    ]);
    expect(ok?.status).toBe('pass');
    expect(ok?.detail).toContain('cached — tree unchanged since last run');
  });

  it('Int2b: cached vs uncached observations give identical statuses and digests', async () => {
    const makeShell = (cached: boolean): ShellProvider => ({
      async exec(command: string) {
        return {
          exitCode: command.includes('ok') ? 0 : 2,
          stdout: command.includes('ok') ? 'all good' : 'boom',
          stderr: '',
          durationMs: 5,
          timedOut: false,
          ...(cached ? { cached: true } : {}),
        };
      },
    });
    const criteria: Criterion[] = [
      { id: 'a', text: 'ok', source: 'task', required: true, check: { kind: 'command', command: 'npm run ok' } },
      { id: 'b', text: 'bad', source: 'task', required: true, check: { kind: 'command', command: 'npm run bad' } },
    ];
    const plain = await new VerificationEngine({ shell: makeShell(false) }).evaluate(criteria);
    const cached = await new VerificationEngine({ shell: makeShell(true) }).evaluate(criteria);

    expect(cached.map((r) => r.status)).toEqual(plain.map((r) => r.status));
    expect(cached.map((r) => r.evidence.map((e) => e.digest))).toEqual(
      plain.map((r) => r.evidence.map((e) => e.digest)),
    );
    // Without the decorator nothing changes at all — no suffix, no field.
    expect(plain.every((r) => !(r.detail ?? '').includes('cached'))).toBe(true);
    expect(cached.every((r) => (r.detail ?? '').includes('cached — tree unchanged since last run'))).toBe(true);
  });

  // ── Int2a: bounded parallel evaluation of command criteria ───────────────

  it('Int2a: 3 command criteria ×100ms run concurrently with fan-out 3, results in order', async () => {
    const emitted: SessionEventInput[] = [];
    const { shell, peak } = delayedShell(100);
    const started = Date.now();
    const results = await new VerificationEngine(
      { shell },
      {
        commandConcurrency: 3,
        emit: async (input) => {
          emitted.push(input);
        },
      },
    ).evaluate(commandCriteria(['cmd-a', 'cmd-b', 'cmd-c']), { packId: 'zelari-coding/v1' });
    expect(Date.now() - started).toBeLessThan(250);
    expect(peak()).toBe(3);
    const order = ['c0', 'c1', 'c2'];
    expect(results.map((r) => r.criterionId)).toEqual(order);
    // The run summary keeps the criteria order even though evidence events
    // interleave (each ref is anchored to its own seq, not to a position).
    const run = emitted.find((e) => e.kind === 'verification.run');
    const payload = (run?.data as { results: Array<{ criterionId: string }> }).results;
    expect(payload.map((r) => r.criterionId)).toEqual(order);
  });

  it('Int2a: fan-out 1 (kill-switch) keeps the sequential 3 ×100ms wall-clock', async () => {
    const { shell, peak } = delayedShell(100);
    const started = Date.now();
    const results = await new VerificationEngine({ shell }, { commandConcurrency: 1 }).evaluate(
      commandCriteria(['cmd-a', 'cmd-b', 'cmd-c']),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(peak()).toBe(1);
    expect(results.map((r) => r.criterionId)).toEqual(['c0', 'c1', 'c2']);
  });

  it('Int2a: the fan-out is honoured — 6 criteria at concurrency 2 never exceed 2 in flight', async () => {
    const { shell, peak, calls } = delayedShell(40);
    const started = Date.now();
    const results = await new VerificationEngine({ shell }, { commandConcurrency: 2 }).evaluate(
      commandCriteria(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']),
    );
    expect(peak()).toBe(2);
    expect(calls).toHaveLength(6);
    expect(results.map((r) => r.criterionId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
    // ≈3 waves of 40ms instead of 6 serialized ones (loose bound: slow CI).
    expect(Date.now() - started).toBeLessThan(240);
  });

  it('Int2a: sequential and parallel runs agree on every status, digest, ref and detail', async () => {
    const criteria = commandCriteria(['npm run typecheck', 'npm run test', 'npm run build', 'npm run bad']);
    const makeShell = (): ShellProvider => ({
      async exec(command: string) {
        const bad = command.includes('bad');
        return {
          exitCode: bad ? 2 : 0,
          stdout: `${command}: ${bad ? 'boom' : 'ok'}`,
          stderr: bad ? 'assertion' : '',
          durationMs: 1,
          timedOut: false,
        };
      },
    });
    const shape = (results: VerificationResult[]) =>
      results.map((r) => ({
        criterionId: r.criterionId,
        status: r.status,
        detail: r.detail,
        evidence: r.evidence.map((e) => ({ tier: e.tier, ref: e.ref, digest: e.digest })),
      }));
    const sequential = await new VerificationEngine({ shell: makeShell() }, { commandConcurrency: 1 }).evaluate(criteria);
    const parallel = await new VerificationEngine({ shell: makeShell() }, { commandConcurrency: 4 }).evaluate(criteria);
    expect(shape(parallel)).toEqual(shape(sequential));
    // Sanity: the pack really contains a fail, so invariance is not vacuous.
    expect(sequential.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'fail']);
  });

  it('Int2a: default (no option, no env) is sequential — parallelism is opt-in', async () => {
    await withVerifyEnv({ ZELARI_VERIFY_PARALLEL: undefined, ZELARI_VERIFY_CONCURRENCY: undefined }, async () => {
      const { shell, peak } = delayedShell(100);
      const started = Date.now();
      await new VerificationEngine({ shell }).evaluate(commandCriteria(['cmd-a', 'cmd-b', 'cmd-c']));
      expect(Date.now() - started).toBeGreaterThanOrEqual(280);
      expect(peak()).toBe(1);
    });
  });

  it('Int2a: ZELARI_VERIFY_PARALLEL=1 enables the fan-out, =0 is the kill-switch', async () => {
    await withVerifyEnv({ ZELARI_VERIFY_PARALLEL: '1', ZELARI_VERIFY_CONCURRENCY: '3' }, async () => {
      const { shell, peak } = delayedShell(100);
      const started = Date.now();
      const results = await new VerificationEngine({ shell }).evaluate(commandCriteria(['cmd-a', 'cmd-b', 'cmd-c']));
      expect(Date.now() - started).toBeLessThan(250);
      expect(peak()).toBe(3);
      expect(results.map((r) => r.criterionId)).toEqual(['c0', 'c1', 'c2']);
    });
    await withVerifyEnv({ ZELARI_VERIFY_PARALLEL: '0', ZELARI_VERIFY_CONCURRENCY: '3' }, async () => {
      const { shell, peak } = delayedShell(100);
      const started = Date.now();
      await new VerificationEngine({ shell }).evaluate(commandCriteria(['cmd-a', 'cmd-b', 'cmd-c']));
      expect(Date.now() - started).toBeGreaterThanOrEqual(280);
      // A concurrency value alone never turns parallelism on.
      expect(peak()).toBe(1);
    });
  });

  it('Int2a: the env resolver defaults to OFF (1) and clamps the concurrency', () => {
    expect(isVerifyParallelEnabled({})).toBe(false);
    expect(resolveCommandConcurrency({})).toBe(1);
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_CONCURRENCY: '8' })).toBe(1);
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_PARALLEL: '0', ZELARI_VERIFY_CONCURRENCY: '8' })).toBe(1);
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_PARALLEL: 'off' })).toBe(1);
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_PARALLEL: 'TRUE', ZELARI_VERIFY_CONCURRENCY: '2' })).toBe(2);
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_PARALLEL: 'on' })).toBe(DEFAULT_COMMAND_CONCURRENCY);
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_PARALLEL: '1', ZELARI_VERIFY_CONCURRENCY: '2.7' })).toBe(2);
    // Garbage falls back to the default — never unbounded, never 0 (deadlock).
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_PARALLEL: 'yes', ZELARI_VERIFY_CONCURRENCY: 'nope' })).toBe(
      DEFAULT_COMMAND_CONCURRENCY,
    );
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_PARALLEL: 'yes', ZELARI_VERIFY_CONCURRENCY: '0' })).toBe(
      DEFAULT_COMMAND_CONCURRENCY,
    );
    expect(resolveCommandConcurrency({ ZELARI_VERIFY_PARALLEL: '1', ZELARI_VERIFY_CONCURRENCY: '-3' })).toBe(
      DEFAULT_COMMAND_CONCURRENCY,
    );
  });

  it('Int2a: a throwing shell fails the parallel run closed, exactly like the sequential one', async () => {
    const emitted: SessionEventInput[] = [];
    const shell: ShellProvider = {
      async exec() {
        throw new Error('provider exploded');
      },
    };
    const engine = new VerificationEngine(
      { shell },
      {
        commandConcurrency: 3,
        emit: async (input) => {
          emitted.push(input);
        },
      },
    );
    await expect(engine.evaluate(commandCriteria(['a', 'b', 'c']))).rejects.toThrow('provider exploded');
    // No run summary is emitted — the run never "completed".
    expect(emitted.some((e) => e.kind === 'verification.run')).toBe(false);
  });
});
