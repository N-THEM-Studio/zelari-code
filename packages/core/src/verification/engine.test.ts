import { describe, expect, it } from 'vitest';
import { VerificationEngine } from './engine.js';
import { MemoryFsProvider, MemoryShellProvider } from '../runtime/memoryProviders.js';
import type { Criterion, VerificationResult } from './types.js';
import type { SessionEventInput } from '../session/types.js';

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
});
