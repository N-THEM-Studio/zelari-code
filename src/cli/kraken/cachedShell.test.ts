/**
 * cachedShell.test.ts — Int2b: same command + unchanged tree ⇒ one execution.
 *
 * Real temp git repos (execFile git, like the other worktree/checkpoint
 * suites) because the tree token IS the invalidation signal: a fake `git`
 * would test nothing. Every test starts from a clean module cache.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ShellExecOptions, ShellProvider, ShellResult } from '@zelari/core/runtime';
import type { SessionEventInput } from '@zelari/core/session';
import type { TaskContract } from '@zelari/core';
import type { VerificationResult } from '@zelari/core/verification';
import { __resetVerifyCacheForTests, verifyCacheEnabled, wrapWithVerifyCache } from './cachedShell.js';
import { evaluateNativePack } from './nativeVerification.js';
import { evaluateContractCriteria } from './contractCompiler.js';

/** The deterministic, tree-neutral command both gate sites are pointed at. */
const PROBE_CMD = 'git rev-parse --short HEAD';

interface FakeShell extends ShellProvider {
  calls: number;
  commands: string[];
  /** Mutable: lets a test change what the NEXT real execution would return. */
  result: Partial<ShellResult>;
}

/** Counting shell: never touches the fs, mirrors the ShellProvider contract. */
function fakeShell(initial: Partial<ShellResult> = {}): FakeShell {
  const shell: FakeShell = {
    calls: 0,
    commands: [],
    result: { ...initial },
    async exec(command: string, _options?: ShellExecOptions): Promise<ShellResult> {
      shell.calls += 1;
      shell.commands.push(command);
      return {
        exitCode: 0,
        stdout: `out:${shell.calls}`,
        stderr: '',
        durationMs: 1_234,
        timedOut: false,
        ...shell.result,
      };
    },
  };
  return shell;
}

/** Hermetic env: {} ⇒ cache ON, untouched by the developer's shell. */
const ON = {};

function gitInit(dir: string): void {
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  run('init');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  // The tree token digests porcelain bytes — keep them platform-stable.
  run('config', 'core.autocrlf', 'false');
}

function commitAll(dir: string, msg: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', msg], { stdio: 'ignore' });
}

/** HEAD moves, the porcelain tree stays clean — isolates the HEAD token. */
function emptyCommit(dir: string, msg: string): void {
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', msg], { stdio: 'ignore' });
}

describe('wrapWithVerifyCache (Int2b gate cache)', () => {
  let repo: string;

  beforeEach(() => {
    __resetVerifyCacheForTests();
    repo = mkdtempSync(path.join(tmpdir(), 'verify-cache-'));
    gitInit(repo);
    writeFileSync(path.join(repo, 'seed.txt'), 'original\n');
    commitAll(repo, 'initial');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('(a) same command + unchanged tree → underlying runs once, hit is flagged', async () => {
    const inner = fakeShell();
    const shell = wrapWithVerifyCache(inner, { root: repo, env: ON });

    const first = await shell.exec('npm run typecheck');
    // What the second real execution WOULD have returned — proves the hit.
    inner.result = { stdout: 'DIFFERENT', exitCode: 7 };
    const second = await shell.exec('npm run typecheck');

    expect(inner.calls).toBe(1);
    expect(first.cached).toBeUndefined(); // miss keeps the provider's result as-is
    expect(second.cached).toBe(true);
    expect(second.stdout).toBe(first.stdout);
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe(first.stderr);
    expect(second.durationMs).toBeGreaterThanOrEqual(0);
    expect(second.durationMs).toBeLessThan(1_234); // real elapsed, not the stored one

    // A cached FAIL stays FAIL (never re-interpreted).
    const failInner = fakeShell({ exitCode: 1, stdout: 'boom' });
    const failShell = wrapWithVerifyCache(failInner, { root: repo, env: ON });
    expect((await failShell.exec('npm test')).exitCode).toBe(1);
    failInner.result = { exitCode: 0, stdout: 'green now' };
    const cachedFail = await failShell.exec('npm test');
    expect(failInner.calls).toBe(1);
    expect(cachedFail.exitCode).toBe(1);
    expect(cachedFail.cached).toBe(true);

    // Callers cannot mutate a cache entry through the returned object.
    second.stdout = 'MUTATED';
    expect((await shell.exec('npm run typecheck')).stdout).toBe(first.stdout);
  });

  it('(b) a write in the repo (tree change) → re-executed', async () => {
    const inner = fakeShell();
    // Evaluation 1 — the first gate.
    const first = wrapWithVerifyCache(inner, { root: repo, env: ON });
    await first.exec('npm run typecheck');
    expect(inner.calls).toBe(1);

    // The repair writes to the tree (untracked, not ignored)…
    writeFileSync(path.join(repo, 'repair.txt'), 'fixed\n');

    // …then the post-repair gate builds a NEW decorator, like production does.
    const second = wrapWithVerifyCache(inner, { root: repo, env: ON });
    const after = await second.exec('npm run typecheck');
    expect(inner.calls).toBe(2);
    expect(after.cached).toBeUndefined();
  });

  it('(c) a new HEAD (commit) → re-executed', async () => {
    const inner = fakeShell();
    await wrapWithVerifyCache(inner, { root: repo, env: ON }).exec('npm test');
    emptyCommit(repo, 'fix');

    const after = await wrapWithVerifyCache(inner, { root: repo, env: ON }).exec('npm test');
    expect(inner.calls).toBe(2);
    expect(after.cached).toBeUndefined();
  });

  it('(d) ZELARI_VERIFY_CACHE=0 → identity wrapper, nothing cached', async () => {
    for (const off of ['0', 'off', 'false', 'OFF']) {
      expect(verifyCacheEnabled({ ZELARI_VERIFY_CACHE: off })).toBe(false);
    }
    expect(verifyCacheEnabled({})).toBe(true);
    expect(verifyCacheEnabled({ ZELARI_VERIFY_CACHE: '1' })).toBe(true);

    const inner = fakeShell();
    const shell = wrapWithVerifyCache(inner, { root: repo, env: { ZELARI_VERIFY_CACHE: '0' } });
    expect(shell).toBe(inner); // identity — no wrapper, no git calls

    const a = await shell.exec('npm run typecheck');
    const b = await shell.exec('npm run typecheck');
    expect(inner.calls).toBe(2);
    expect(a.cached).toBeUndefined();
    expect(b.cached).toBeUndefined();
  });

  it('(e) LRU bound of 32: oldest entry is evicted, newest still hits', async () => {
    const inner = fakeShell();
    const shell = wrapWithVerifyCache(inner, { root: repo, env: ON });

    for (let i = 0; i < 33; i += 1) await shell.exec(`echo cmd-${i}`);
    expect(inner.calls).toBe(33);

    await shell.exec('echo cmd-32'); // newest → still resident
    expect(inner.calls).toBe(33);

    await shell.exec('echo cmd-0'); // oldest → evicted, must re-execute
    expect(inner.calls).toBe(34);
  });

  it('(f) cwd outside any git repo → always executes, never crashes', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'verify-cache-nogit-'));
    try {
      const inner = fakeShell();
      const shell = wrapWithVerifyCache(inner, { root: plain, env: ON });
      const a = await shell.exec('npm test');
      const b = await shell.exec('npm test');
      expect(inner.calls).toBe(2);
      expect(a.cached).toBeUndefined();
      expect(b.cached).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('(g) separate decorator instances share the MODULE-level cache', async () => {
    const inner = fakeShell();
    const firstGate = wrapWithVerifyCache(inner, { root: repo, env: ON });
    const postRepairGate = wrapWithVerifyCache(inner, { root: repo, env: ON });
    expect(firstGate).not.toBe(postRepairGate);

    await firstGate.exec('npm run build');
    const second = await postRepairGate.exec('npm run build');

    expect(inner.calls).toBe(1);
    expect(second.cached).toBe(true);
  });

  it('(h) cwd and timeoutMs are part of the key', async () => {
    const inner = fakeShell();
    const shell = wrapWithVerifyCache(inner, { root: repo, env: ON });

    await shell.exec('npm test');
    await shell.exec('npm test', { cwd: 'packages/core' }); // different cwd
    await shell.exec('npm test', { timeoutMs: 1_000 }); // different timeout
    expect(inner.calls).toBe(3);

    // …and the exact same triple hits.
    await shell.exec('npm test');
    await shell.exec('npm test', { cwd: 'packages/core' });
    await shell.exec('npm test', { timeoutMs: 1_000 });
    expect(inner.calls).toBe(3);
  });

  it('(i) timeouts and signal kills are never cached', async () => {
    const timedOut = fakeShell({ timedOut: true, exitCode: null, stdout: '' });
    const a = await wrapWithVerifyCache(timedOut, { root: repo, env: ON }).exec('npm test');
    const b = await wrapWithVerifyCache(timedOut, { root: repo, env: ON }).exec('npm test');
    expect(timedOut.calls).toBe(2);
    expect(a.cached).toBeUndefined();
    expect(b.cached).toBeUndefined();

    const killed = fakeShell({ exitCode: null }); // signal, not a timeout
    await wrapWithVerifyCache(killed, { root: repo, env: ON }).exec('npm test');
    await wrapWithVerifyCache(killed, { root: repo, env: ON }).exec('npm test');
    expect(killed.calls).toBe(2);
  });
});

/**
 * Wiring: the DEFAULT provider of each gate site is decorated, and because the
 * LRU is module-level the two sites (native pack, contract `Verify:` criteria)
 * share observations — this is what makes the post-repair and end-of-mission
 * evaluations cheap for real.
 */
describe('cachedShell wiring through the gate constructors', () => {
  let repo: string;

  beforeEach(() => {
    __resetVerifyCacheForTests();
    repo = mkdtempSync(path.join(tmpdir(), 'verify-cache-wire-'));
    gitInit(repo);
    writeFileSync(path.join(repo, 'seed.txt'), 'original\n');
    commitAll(repo, 'initial');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** The one result backed by a real command observation. */
  const commandResult = (results: VerificationResult[] | undefined): VerificationResult | undefined =>
    results?.find((r) => r.evidence.some((e) => e.tier === 'command-output'));

  const collector = (): { events: SessionEventInput[]; emit: (i: SessionEventInput) => Promise<unknown> } => {
    const events: SessionEventInput[] = [];
    return { events, emit: async (input) => { events.push(input); return { seq: events.length }; } };
  };

  it('(j) evaluateNativePack: the 2nd evaluation of an unchanged tree is served cached', async () => {
    const env = { ZELARI_VERIFY_TYPECHECK_CMD: PROBE_CMD };
    const first = collector();
    const second = collector();

    const before = await evaluateNativePack({ cwd: repo, env, emit: first.emit });
    const after = await evaluateNativePack({ cwd: repo, env, emit: second.emit });

    const beforeResult = commandResult(before?.results);
    const afterResult = commandResult(after?.results);
    expect(beforeResult?.status).toBe('pass');
    expect(afterResult?.status).toBe('pass'); // same verdict…
    expect(afterResult?.evidence[0]?.digest).toBe(beforeResult?.evidence[0]?.digest); // …same digest…
    expect(beforeResult?.detail ?? '').not.toContain('cached'); // 1st run is a real execution
    expect(afterResult?.detail).toContain('cached — tree unchanged since last run');

    const evidenceEvents = (events: SessionEventInput[]) =>
      events.filter((e) => e.kind === 'verification.evidence');
    expect(evidenceEvents(first.events).some((e) => (e.data as { cached?: boolean })?.cached === true)).toBe(false);
    expect(evidenceEvents(second.events).filter((e) => (e.data as { cached?: boolean })?.cached === true)).toHaveLength(1);
  });

  it("(k) cross-site: a contract Verify command reuses the pack's observation", async () => {
    const env = { ZELARI_VERIFY_TYPECHECK_CMD: PROBE_CMD };
    const before = await evaluateNativePack({ cwd: repo, env });
    expect(commandResult(before?.results)?.detail ?? '').not.toContain('cached');

    const contract: TaskContract = {
      version: 1,
      goal: 'ship the feature',
      constraints: [],
      acceptanceCriteria: [
        {
          id: 'ac-1',
          text: 'HEAD resolves',
          source: 'user',
          required: true,
          verificationHint: { kind: 'command', value: PROBE_CMD },
        },
      ],
      source: { userSeq: 1 },
    };
    const compiled = await evaluateContractCriteria(contract, { cwd: repo });
    const result = commandResult(compiled?.results);
    expect(result?.status).toBe('pass');
    // Served from the pack's entry: separate decorator, same module LRU.
    expect(result?.detail).toContain('cached — tree unchanged since last run');
  });

  it('(l) ZELARI_VERIFY_CACHE=0 turns the wiring off end to end', async () => {
    const env = { ZELARI_VERIFY_TYPECHECK_CMD: PROBE_CMD, ZELARI_VERIFY_CACHE: '0' };
    const first = await evaluateNativePack({ cwd: repo, env });
    const second = await evaluateNativePack({ cwd: repo, env });
    expect(commandResult(first?.results)?.detail ?? '').not.toContain('cached');
    expect(commandResult(second?.results)?.detail ?? '').not.toContain('cached');
  });
});
