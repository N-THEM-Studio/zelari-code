/**
 * tools/eval/extensionAnchors.test.ts — t147 self-checks for the
 * extension/plugin capability baseline.
 *
 * What is pinned here (all offline, all deterministic):
 *  1. the suite manifest hash is STABLE and identifies the (id, version) list;
 *  2. every capability check PASSES against the real src/cli code and reports
 *     observed evidence in `detail` (not a restated expectation);
 *  3. the recorded AnchorRunRecords round-trip through EvalResultStore and
 *     `runGate.compareManifest` decides COMMIT for baseline == candidate —
 *     i.e. `eval:gate` can actually consume this suite;
 *  4. a check that FAILS is recorded as `fail` / `verified:false` and forces
 *     REJECT — the harness has no way to report a green on a red check
 *     (anti-Goodhart).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXTENSION_SUITE,
  EXTENSION_WORKSPACE_ROOT,
  extensionResourcePolicyHash,
  extensionSuiteManifestHash,
  type ExtensionCapabilityCheck,
} from './extensionAnchors.ts';
import { runExtensionSuite } from './runExtensionsBaseline.ts';
import { EvalResultStore } from './resultStore.ts';
import { compareManifest } from './runGate.ts';

const tempDirs: string[] = [];

function tempStoreDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 't147-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('extension capability suite definition (t147)', () => {
  it('derives a stable manifest hash from the (id, version) list', () => {
    const first = extensionSuiteManifestHash();
    const second = extensionSuiteManifestHash();
    expect(first).toBe(second);
    // resultStore.listManifestHashes() only matches <16+ hex> dir names.
    expect(first).toMatch(/^[0-9a-f]{16,}$/);
    expect(extensionResourcePolicyHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(extensionResourcePolicyHash()).not.toBe(first);

    expect(EXTENSION_SUITE.length).toBeGreaterThanOrEqual(5);
    for (const check of EXTENSION_SUITE) {
      expect(check.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(Number.isInteger(check.version)).toBe(true);
      expect(check.version).toBeGreaterThan(0);
      expect(check.description.length).toBeGreaterThan(0);
    }
    expect(new Set(EXTENSION_SUITE.map((c) => c.id)).size).toBe(EXTENSION_SUITE.length);
  });

  it('passes every check against the real loader/hook/bundle code and its evidence is observed', async () => {
    const store = new EvalResultStore(tempStoreDir());
    const hash = extensionSuiteManifestHash();
    const run = await runExtensionSuite({ store, suite: EXTENSION_SUITE, suiteHash: hash });

    for (const record of run.records) {
      expect(record.result, `${record.anchorId}: ${record.detail}`).toBe('pass');
      expect(record.verified).toBe(true);
      expect(record.exitCode).toBe(0);
      expect((record.detail ?? '').length).toBeGreaterThan(10);
    }
    expect(run.failed).toBe(0);
    expect(run.passed).toBe(EXTENSION_SUITE.length);
    expect(run.decision).toBe('COMMIT');
    // Zero cost by construction; wallMs is the only measured number.
    expect(run.records.every((r) => r.cost.inputTokens === 0 && r.cost.modelCostUsd === 0 && r.cost.toolCalls === 0)).toBe(true);
    expect(run.totalWallMs).toBeGreaterThan(0);
    // Fixture workspaces are disposable: each check removes its own dir.
    const leftovers = existsSync(EXTENSION_WORKSPACE_ROOT)
      ? readdirSync(EXTENSION_WORKSPACE_ROOT).filter((name) => name.startsWith(`${run.records[0]?.anchorId}-`))
      : [];
    expect(leftovers).toEqual([]);
  });

  it('writes anchors.jsonl + summary.json that the regression gate consumes as COMMIT', async () => {
    const store = new EvalResultStore(tempStoreDir());
    const hash = extensionSuiteManifestHash();
    const run = await runExtensionSuite({ store, suite: EXTENSION_SUITE, suiteHash: hash });

    expect(store.listManifestHashes()).toEqual([hash]);
    const dir = store.dirFor(hash);
    expect(existsSync(path.join(dir, 'anchors.jsonl'))).toBe(true);
    const summaryShape = JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')) as {
      result: { currentSuite: { passed: number; total: number } };
      gateDecision?: string;
    };
    expect(summaryShape.result.currentSuite).toEqual({ passed: EXTENSION_SUITE.length, total: EXTENSION_SUITE.length });
    expect(summaryShape.gateDecision).toBe('COMMIT');

    const reloaded = store.loadRuns(hash);
    expect(reloaded).toHaveLength(EXTENSION_SUITE.length);
    for (const record of reloaded) {
      expect(record.harnessManifestHash).toBe(hash);
      expect(record.resourcePolicyHash).toBe(extensionResourcePolicyHash());
      expect(record.runId.length).toBeGreaterThan(0);
      expect(Number.isInteger(record.anchorVersion)).toBe(true);
      expect(Number.isNaN(Date.parse(record.recordedAt))).toBe(false);
    }
    expect(store.loadSummary(hash)?.manifestHash).toBe(hash);
    expect(store.latestManifestHash()).toBe(hash);

    // The real acceptance path: eval:gate with baseline == candidate.
    expect(
      compareManifest({
        baselineHash: hash,
        candidateHash: hash,
        baselineStore: store,
        store,
        skipOnMissingBaseline: false,
      }),
    ).toBe('COMMIT');
    expect(run.records).toHaveLength(EXTENSION_SUITE.length);
  });

  it('records a failing check as fail/verified:false and REJECTs (no fake green)', async () => {
    const store = new EvalResultStore(tempStoreDir());
    const failing: ExtensionCapabilityCheck = {
      id: 'synthetic-failing-check',
      version: 1,
      description: 'test double: a capability that is broken on purpose',
      run: async () => ({ ok: false, detail: 'observed: the capability returned the wrong value', wallMs: 1 }),
    };
    const run = await runExtensionSuite({ store, suite: [failing], suiteHash: 'f'.repeat(32) });

    expect(run.passed).toBe(0);
    expect(run.failed).toBe(1);
    expect(run.decision).toBe('REJECT');
    expect(run.records[0]).toMatchObject({
      anchorId: 'synthetic-failing-check',
      result: 'fail',
      verified: false,
      exitCode: 1,
      reason: 'checks-failed',
    });
    expect(store.loadRuns('f'.repeat(32))[0]?.detail).toContain('wrong value');
  });
});

describe('extension capability checks — observed evidence (t147)', () => {
  const check = (id: string): ExtensionCapabilityCheck => {
    const found = EXTENSION_SUITE.find((c) => c.id === id);
    if (!found) throw new Error(`suite is missing ${id}`);
    return found;
  };

  it('an onPreToolUse deny is typed AND the tool body never runs', async () => {
    const result = await check('ext-onpre-deny').run(EXTENSION_WORKSPACE_ROOT);
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toContain('[extension-hook:t147-deny-hook]');
    expect(result.detail).toContain('never ran');
    expect(result.wallMs).toBeGreaterThanOrEqual(0);
  });

  it('the loader is fail-closed: crashing module skipped, lock mismatch typed', async () => {
    const result = await check('ext-loader-fail-closed').run(EXTENSION_WORKSPACE_ROOT);
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toContain('import failed');
    expect(result.detail).toContain('ExtensionLockError');
  });

  it('a JSON lifecycle hook fires on the real PermissionRequest observer seam', async () => {
    const result = await check('ext-lifecycle-observer').run(EXTENSION_WORKSPACE_ROOT);
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toContain('PermissionRequest');
    expect(result.detail).toContain('sessionId: t147-eval');
  });
});
