/**
 * tools/eval/runAnchors.test.ts — F11 store seeding (2.6.2).
 *
 * Covers the CI retention-gate pipeline pieces that live OUTSIDE runGate:
 *  - deep suite provenance (names + available specs, stable, profile-sensitive)
 *  - runAnchorSuite seeds anchors.jsonl + summary.json coherently
 *  - the store resolves `--baseline latest` via latestManifestHash()
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeSuiteProvenance, runAnchorSuite } from './runAnchors.ts';
import { EvalResultStore } from './resultStore.ts';
import { loadAnchorFile } from './anchorLoader.ts';
import type { AgentRunner } from './anchorRunner.ts';

const FIX_EXPORT_ANCHOR = path.resolve(
  import.meta.dirname,
  '../../eval/anchors/local-bugfix/js-fix-export.anchor.json',
);

/** Copies the js-fix-export anchor into an isolated one-anchor suite dir. */
function isolatedAnchorDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runAnchors-suite-'));
  const anchor = loadAnchorFile(FIX_EXPORT_ANCHOR);
  writeFileSync(path.join(dir, `${anchor.id}.anchor.json`), JSON.stringify(anchor), 'utf8');
  return dir;
}

/** Simulates an agent that actually fixes the workspace (writes the fix). */
const fixingRunner: AgentRunner = (anchor, workspaceDir) => {
  const target = anchor.fixture.files[0];
  if (target?.path === 'sum.js') {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(
      require('node:path').join(workspaceDir, 'sum.js'),
      target.content.replace('a - b', 'a + b'),
      'utf8',
    );
  }
  return { ok: true, toolCalls: 2, wallMs: 50 };
};

describe('computeSuiteProvenance (deep names+specs hash)', () => {
  it('produces stable non-empty hex hashes', () => {
    const a = computeSuiteProvenance('minimal/v1');
    const b = computeSuiteProvenance('minimal/v1');
    expect(a.harnessManifestHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(a.resourcePolicyHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(a).toEqual(b);
  });

  it('is profile-sensitive (different tool sets → different manifest hash)', () => {
    const minimal = computeSuiteProvenance('minimal/v1');
    const kraken = computeSuiteProvenance('kraken/v1');
    expect(minimal.harnessManifestHash).not.toBe(kraken.harnessManifestHash);
  });
});

describe('runAnchorSuite → result store seeding (F11)', () => {
  it('seeds anchors.jsonl + summary.json coherently (no duplicate records)', async () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), 'runAnchors-store-'));
    const store = new EvalResultStore(storeDir);
    const result = await runAnchorSuite({
      store,
      runner: fixingRunner,
      anchorsDir: isolatedAnchorDir(),
      tiers: [0],
    });

    expect(result.records).toHaveLength(1);
    expect(result.passed).toBe(1);
    expect(result.failed + result.blocked).toBe(0);

    const persisted = store.loadRuns(result.manifestHash);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].anchorId).toBe('js-fix-export-bugfix');
    expect(persisted[0].result).toBe('pass');
    expect(persisted[0].verified).toBe(true);
    // Deep provenance flowed into the record (never the bare-name fallback shape).
    expect(persisted[0].harnessManifestHash).toBe(result.manifestHash);

    const summary = store.loadSummary(result.manifestHash);
    expect(summary?.manifestHash).toBe(result.manifestHash);
    expect(summary?.result.currentSuite).toEqual({ passed: 1, total: 1 });
    expect(summary?.result.anchors.total).toBe(1);
  });

  it('latestManifestHash() resolves the seeded suite (CI --baseline latest)', async () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), 'runAnchors-store-'));
    const store = new EvalResultStore(storeDir);
    expect(store.latestManifestHash()).toBeUndefined();
    const result = await runAnchorSuite({
      store,
      runner: fixingRunner,
      anchorsDir: isolatedAnchorDir(),
      tiers: [0],
    });
    expect(store.latestManifestHash()).toBe(result.manifestHash);
  });
});

/** Echo-style stub (as the CLI `--runner echo`): the agent "runs" and changes nothing. */
const echoRunner: AgentRunner = () => ({ ok: true, toolCalls: 1, wallMs: 1 });

/** Two already-green copies of the bootstrap anchor — the fixture is pre-solved,
 * so the echo runner's no-op still passes the deterministic checks. */
function repeatAnchorDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runAnchors-repeat-'));
  const anchor = loadAnchorFile(FIX_EXPORT_ANCHOR);
  for (const id of ['repeat-anchor-a', 'repeat-anchor-b']) {
    writeFileSync(
      path.join(dir, `${id}.anchor.json`),
      JSON.stringify({
        ...anchor,
        id,
        fixture: {
          ...anchor.fixture,
          files: anchor.fixture.files.map((f) =>
            f.path === 'sum.js' ? { ...f, content: f.content.replace('a - b', 'a + b') } : f,
          ),
        },
      }),
      'utf8',
    );
  }
  return dir;
}

describe('runAnchorSuite --repeat (t65, Fase 0.1)', () => {
  it('repeat: 3 → 6 records, each anchorId exactly 3 times, store keeps all N', async () => {
    const store = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'runAnchors-store-')));
    const result = await runAnchorSuite({
      store,
      runner: echoRunner,
      anchorsDir: repeatAnchorDir(),
      tiers: [0],
      repeat: 3,
    });
    expect(result.records).toHaveLength(6);
    expect(new Set(result.records.map((r) => r.runId)).size).toBe(6);
    for (const anchorId of ['repeat-anchor-a', 'repeat-anchor-b']) {
      expect(result.records.filter((r) => r.anchorId === anchorId)).toHaveLength(3);
    }
    expect(result.passed).toBe(6);
    // Append-only store: every repeated run is persisted.
    expect(store.loadRuns(result.manifestHash)).toHaveLength(6);
    // Self-comparison is unchanged by repeats — the gate's id Map dedupes.
    expect(result.summary.result.anchors.total).toBe(2);
  });

  it('repeat: 0 throws BEFORE any run (fail-closed)', async () => {
    const store = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'runAnchors-store-')));
    await expect(
      runAnchorSuite({ store, runner: echoRunner, anchorsDir: repeatAnchorDir(), tiers: [0], repeat: 0 }),
    ).rejects.toThrow('repeat must be an integer >= 1');
  });

  it('default (no repeat) → 1 record per anchor', async () => {
    const store = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'runAnchors-store-')));
    const result = await runAnchorSuite({ store, runner: echoRunner, anchorsDir: repeatAnchorDir(), tiers: [0] });
    expect(result.records).toHaveLength(2);
    for (const anchorId of ['repeat-anchor-a', 'repeat-anchor-b']) {
      expect(result.records.filter((r) => r.anchorId === anchorId)).toHaveLength(1);
    }
  });
});
