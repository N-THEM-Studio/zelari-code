/*
 * tools/eval/runGate.test.ts — F11 `--candidate all` semantics (2.6.2).
 *
 * Mixed-profile suites split across manifest dirs; the gate must compare
 * EVERY recorded manifest so no profile's anchors drop out of the decision:
 *  - compareManifest: baseline pass → candidate fail = REJECT
 *  - compareManifest: same outcomes = COMMIT
 *  - skipOnMissingBaseline: unknown baseline hash = SKIP (new harness)
 *  - listManifestHashes: one entry per recorded profile manifest
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareManifest } from './runGate.ts';
import { EvalResultStore } from './resultStore.ts';
import { runAnchorSuite } from './runAnchors.ts';
import { loadAnchorFile } from './anchorLoader.ts';
import type { AgentRunner } from './anchorRunner.ts';

const FIX_EXPORT_ANCHOR = path.resolve(
  import.meta.dirname,
  '../../eval/anchors/local-bugfix/js-fix-export.anchor.json',
);

/**
 * Two anchors with IDENTICAL solvable fixtures but DIFFERENT profiles, so one
 * suite seeds TWO manifest dirs (minimal/v1 + kraken/v1) — the `all` case.
 */
function twoProfileAnchorDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runGate-suite-'));
  const original = loadAnchorFile(FIX_EXPORT_ANCHOR);
  writeFileSync(path.join(dir, `${original.id}.anchor.json`), JSON.stringify(original), 'utf8');
  const twin = { ...original, id: 'gate-kraken-twin', profile: 'kraken/v1' };
  writeFileSync(path.join(dir, `${twin.id}.anchor.json`), JSON.stringify(twin), 'utf8');
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

/** Simulates an agent that claims success but changes nothing → checks fail. */
const brokenRunner: AgentRunner = () => ({ ok: true, toolCalls: 0, wallMs: 1 });

async function seedSuite(store: EvalResultStore, runner: AgentRunner): Promise<string[]> {
  const anchorsDir = twoProfileAnchorDir();
  const result = await runAnchorSuite({ store, runner, anchorsDir, tiers: [0] });
  return [...new Set(result.records.map((r) => r.harnessManifestHash))];
}

describe('compareManifest — mixed-profile retention (F11 --candidate all)', () => {
  it('REJECTs every manifest whose anchors regressed (baseline pass → candidate fail)', async () => {
    const baselineStore = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'gate-base-')));
    const candidateStore = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'gate-cand-')));
    const hashes = await seedSuite(baselineStore, fixingRunner);
    await seedSuite(candidateStore, brokenRunner);
    expect(hashes.length).toBe(2); // minimal/v1 + kraken/v1 → two manifest dirs

    for (const hash of hashes) {
      const outcome = compareManifest({
        baselineHash: hash,
        candidateHash: hash,
        baselineStore,
        store: candidateStore,
        skipOnMissingBaseline: true,
      });
      expect(outcome).toBe('REJECT');
    }
  });

  it('COMMITs when outcomes match, and lists every recorded manifest', async () => {
    const baselineStore = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'gate-base-')));
    const candidateStore = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'gate-cand-')));
    const hashes = await seedSuite(baselineStore, fixingRunner);
    await seedSuite(candidateStore, fixingRunner);

    const listed = candidateStore.listManifestHashes().sort();
    expect(listed).toEqual([...hashes].sort());

    for (const hash of hashes) {
      expect(
        compareManifest({
          baselineHash: hash,
          candidateHash: hash,
          baselineStore,
          store: candidateStore,
          skipOnMissingBaseline: true,
        }),
      ).toBe('COMMIT');
    }
  });

  it('SKIPs manifests with no baseline runs when skipOnMissingBaseline (new harness)', () => {
    const baselineStore = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'gate-base-')));
    const candidateStore = new EvalResultStore(mkdtempSync(path.join(tmpdir(), 'gate-cand-')));
    const unknown = 'f'.repeat(64);
    expect(
      compareManifest({
        baselineHash: unknown,
        candidateHash: unknown,
        baselineStore,
        store: candidateStore,
        skipOnMissingBaseline: true,
      }),
    ).toBe('SKIP');
  });
});
