/**
 * eval-seedBaseline.test.ts — WS7 slice 0: the honest baseline seeder.
 *
 * The rule under test is the GOLDEN RULE, not the happy path:
 *   - `checkSeedPrereqs` mirrors runAnchors' own credential predicate;
 *   - `runSeed` writes NOTHING — no label dir, no store dir, no tag — when the
 *     provider is not configured (exit 3), and refuses to overwrite an
 *     existing baseline tag BEFORE running a single anchor (exit 2);
 *   - a successful run's manifest numbers come from the run's own records,
 *     the label dir is written, and the tag is created locally.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSeedManifest,
  checkSeedPrereqs,
  parseSeedArgs,
  readSeedManifest,
  runSeed,
  SEED_MANIFEST_FILE,
  type SeedGit,
  type SeedSuiteRunner,
} from '../../tools/eval/runSeedBaseline.ts';
import type { AnchorRunRecord } from '../../tools/eval/types.ts';
import type { SuiteRunResult } from '../../tools/eval/runAnchors.ts';

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

let tmpRoot: string | undefined;
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

function mkTmp(): string {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'seed-baseline-'));
  // A fake CLI entry so the ONLY variable under test is the provider gate:
  // checkSeedPrereqs hard-requires bin/zelari-code.js relative to cwd.
  mkdirSync(path.join(tmpRoot, 'bin'), { recursive: true });
  writeFileSync(path.join(tmpRoot, 'bin', 'zelari-code.js'), '// fake entry\n', 'utf8');
  return tmpRoot;
}

/** A fake repo: HEAD resolvable, tags tracked in memory. */
function fakeGit(existing: readonly string[] = []): { git: SeedGit; created: string[] } {
  const tags = new Set(existing);
  const created: string[] = [];
  return {
    created,
    git: {
      headSha: () => 'a'.repeat(40),
      tagExists: (t) => tags.has(t),
      createTag: (t, _message) => {
        if (tags.has(t)) return { ok: false, error: 'tag exists' };
        tags.add(t);
        created.push(t);
        return { ok: true };
      },
    },
  };
}

const record = (anchorId: string, result: AnchorRunRecord['result']): AnchorRunRecord => ({
  runId: `r-${anchorId}`,
  anchorId,
  anchorVersion: 1,
  harnessManifestHash: 'f'.repeat(16),
  resourcePolicyHash: 'e'.repeat(16),
  result,
  verified: result === 'pass',
  cost: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, toolCalls: 1, wallMs: 1, modelCostUsd: 0, toolCostUsd: 0, totalUsd: 0 } as unknown as AnchorRunRecord['cost'],
  exitCode: result === 'pass' ? 0 : 1,
  recordedAt: FIXED_NOW,
});

const fakeSuite = (records: AnchorRunRecord[]): SeedSuiteRunner =>
  async () => ({
    manifestHash: 'f'.repeat(16),
    records,
    passed: records.filter((r) => r.result === 'pass').length,
    failed: records.filter((r) => r.result === 'fail').length,
    blocked: records.filter((r) => r.result === 'blocked').length,
    summary: {} as SuiteRunResult['summary'],
  });

describe('parseSeedArgs', () => {
  it('defaults to tier 0 and derives a lowercase timestamped label', () => {
    const args = parseSeedArgs([], () => FIXED_NOW);
    expect(args.tiers).toEqual([0]);
    expect(args.label).toBe('seed-t0-2026-01-01t00-00-00');
    expect(args.tag).toBe(true);
    expect(args.strict).toBe(false);
    // The derived default must satisfy the SAME slug rule as --label.
    expect(args.label).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  });

  it('rejects a label that is not a safe slug and one that looks like a manifest hash', () => {
    expect(() => parseSeedArgs(['--label', '../escape'])).toThrow(/slug/);
    expect(() => parseSeedArgs(['--label', 'A'.repeat(20)])).toThrow(/slug/);
    expect(() => parseSeedArgs(['--label', 'a'.repeat(16)])).toThrow(/manifest hash/);
  });

  it('rejects a non-positive --limit and honours --no-tag / --strict', () => {
    expect(() => parseSeedArgs(['--limit', '0'])).toThrow(/limit/);
    expect(parseSeedArgs(['--limit', '2', '--no-tag', '--strict', '--tier', '1'])).toMatchObject({
      limit: 2,
      tag: false,
      strict: true,
      tiers: [1],
    });
  });
});

describe('checkSeedPrereqs', () => {
  // Repo root from THIS file: on CI the suite runs with cwd = packages/core
  // (`npm test --workspace=@zelari/core`), and the default CLI entry
  // (bin/zelari-code.js) only resolves from the repo root.
  const cwd = fileURLToPath(new URL('../../', import.meta.url));

  it('fails with an explicit reason when no provider credential is present', () => {
    const p = checkSeedPrereqs({ env: {}, cwd, gitSha: 'a'.repeat(40) });
    expect(p.ok).toBe(false);
    expect(p.missing.join('\n')).toMatch(/provider not configured/);
    expect(p.satisfiedBy).toBeUndefined();
  });

  it('accepts any of the runner credential vars and reports the NAME only', () => {
    for (const name of ['ZELARI_API_KEY', 'ZELARI_LOCAL_CLI', 'ZELARI_EVAL_ALLOW_HEADLESS']) {
      const p = checkSeedPrereqs({ env: { [name]: 'secret-value' }, cwd, gitSha: 'a'.repeat(40) });
      expect(p.ok).toBe(true);
      expect(p.satisfiedBy).toBe(name);
      expect(JSON.stringify(p)).not.toContain('secret-value');
    }
  });

  it('flags a missing CLI entry and an unresolvable git HEAD', () => {
    const p = checkSeedPrereqs({
      env: { ZELARI_API_KEY: 'k' },
      cwd,
      gitSha: null,
      cliEntry: 'bin/definitely-not-here.js',
    });
    expect(p.ok).toBe(false);
    expect(p.missing.join('\n')).toMatch(/CLI entry point missing/);
    expect(p.missing.join('\n')).toMatch(/git HEAD is unresolvable/);
  });

  it('treats an empty-string credential as absent', () => {
    const p = checkSeedPrereqs({ env: { ZELARI_API_KEY: '' }, cwd, gitSha: 'a'.repeat(40) });
    expect(p.ok).toBe(false);
  });
});

describe('buildSeedManifest', () => {
  it('takes every number from the records and nulls env attribution it does not have', () => {
    const args = parseSeedArgs(['--label', 'base-1', '--tier', '0']);
    const m = buildSeedManifest({
      args,
      createdAt: FIXED_NOW,
      gitSha: 'b'.repeat(40),
      satisfiedBy: 'ZELARI_API_KEY',
      available: 4,
      manifestHash: 'f'.repeat(16),
      storeDir: 'eval/results',
      records: [record('a1', 'pass'), record('a2', 'fail'), record('a3', 'blocked')],
    });
    expect(m.counts).toEqual({ passed: 1, failed: 1, blocked: 1, total: 3 });
    expect(m.anchorIds).toEqual(['a1', 'a2', 'a3']);
    expect(m.subset).toEqual({ tiers: [0], limit: null, selected: 3, available: 4 });
    expect(m.attribution).toEqual({ providerEnv: null, modelEnv: null });
    expect(m.tag).toBe('eval-baseline/base-1');
  });
});

describe('runSeed — the golden rule', () => {
  it('writes NOTHING and exits 3 when the provider is not configured', async () => {
    const root = mkTmp();
    const resultsRoot = path.join(root, 'eval', 'results');
    const { git, created } = fakeGit();
    const errors: string[] = [];
    const code = await runSeed({
      cwd: root,
      env: {}, // no credentials
      args: parseSeedArgs(['--label', 'no-provider', '--store', resultsRoot]),
      git,
      errlog: (l) => errors.push(l),
      log: () => undefined,
      suite: fakeSuite([record('a1', 'pass')]),
    });
    expect(code).toBe(3);
    expect(existsSync(resultsRoot)).toBe(false); // no store, no label dir
    expect(created).toEqual([]); // no tag
    expect(errors.join('\n')).toMatch(/baseline non seedata/);
  });

  it('refuses to overwrite an existing baseline tag before running anything', async () => {
    const root = mkTmp();
    const resultsRoot = path.join(root, 'eval', 'results');
    const { git, created } = fakeGit(['eval-baseline/dup']);
    let ran = false;
    const errors: string[] = [];
    const code = await runSeed({
      cwd: root,
      env: { ZELARI_API_KEY: 'k' },
      args: parseSeedArgs(['--label', 'dup', '--store', resultsRoot]),
      git,
      errlog: (l) => errors.push(l),
      log: () => undefined,
      suite: async (input) => {
        ran = true;
        return fakeSuite([])(input);
      },
    });
    expect(code).toBe(2);
    expect(ran).toBe(false); // the suite never started
    expect(existsSync(resultsRoot)).toBe(false);
    expect(created).toEqual([]);
    expect(errors.join('\n')).toMatch(/already exists/);
  });

  it('seeds the label dir + manifest and creates the local tag on success', async () => {
    const root = mkTmp();
    const resultsRoot = path.join(root, 'eval', 'results');
    const { git, created } = fakeGit();
    const code = await runSeed({
      cwd: root,
      env: { ZELARI_API_KEY: 'k', ZELARI_MODEL: 'test-model' },
      args: parseSeedArgs(['--label', 'base-ok', '--store', resultsRoot, '--tier', '0']),
      git,
      log: () => undefined,
      errlog: () => undefined,
      suite: fakeSuite([record('a1', 'pass'), record('a2', 'pass')]),
    });
    expect(code).toBe(0);
    const labelDir = path.join(resultsRoot, 'base-ok');
    expect(existsSync(path.join(labelDir, SEED_MANIFEST_FILE))).toBe(true);
    expect(existsSync(path.join(labelDir, 'anchors.jsonl'))).toBe(true);
    const manifest = readSeedManifest(labelDir);
    expect(manifest.manifestHash).toBe('f'.repeat(16));
    expect(manifest.counts).toEqual({ passed: 2, failed: 0, blocked: 0, total: 2 });
    expect(manifest.attribution.modelEnv).toBe('test-model');
    // anchors.jsonl in the label dir is the SAME record set the store kept.
    const lines = readFileSync(path.join(labelDir, 'anchors.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(created).toEqual(['eval-baseline/base-ok']);
  });

  it('reports a tag failure honestly (exit 1) instead of pretending it succeeded', async () => {
    const root = mkTmp();
    const resultsRoot = path.join(root, 'eval', 'results');
    const { git } = fakeGit();
    const errors: string[] = [];
    const code = await runSeed({
      cwd: root,
      env: { ZELARI_API_KEY: 'k' },
      args: parseSeedArgs(['--label', 'tag-fail', '--store', resultsRoot]),
      git: { ...git, createTag: () => ({ ok: false, error: 'permission denied' }) },
      errlog: (l) => errors.push(l),
      log: () => undefined,
      suite: fakeSuite([record('a1', 'pass')]),
    });
    expect(code).toBe(1);
    expect(existsSync(path.join(resultsRoot, 'tag-fail', SEED_MANIFEST_FILE))).toBe(true);
    expect(errors.join('\n')).toMatch(/permission denied/);
  });

  it('--strict exits 1 when the measured suite was not fully green', async () => {
    const root = mkTmp();
    const resultsRoot = path.join(root, 'eval', 'results');
    const code = await runSeed({
      cwd: root,
      env: { ZELARI_API_KEY: 'k' },
      args: parseSeedArgs(['--label', 'strict-fail', '--store', resultsRoot, '--strict', '--no-tag']),
      git: fakeGit().git,
      log: () => undefined,
      errlog: () => undefined,
      suite: fakeSuite([record('a1', 'pass'), record('a2', 'fail')]),
    });
    expect(code).toBe(1);
  });
});
