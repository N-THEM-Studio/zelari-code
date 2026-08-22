/**
 * tools/eval/targetedAnchors.test.ts — §26 classification + targeting:
 * prompt change → behavioral → targeted anchors; runtime bump → structural →
 * full set; no diff → cosmetic → none.
 */

import { describe, expect, it } from 'vitest';
import { classifyHarnessChanges, diffHarnessManifest, harnessInputHash, type HarnessManifestV1 } from '@zelari/core';
import { selectTargetedAnchors } from './targetedAnchors.ts';
import { loadAnchors } from './anchorLoader.ts';
import path from 'node:path';

const ANCHORS_DIR = path.resolve(import.meta.dirname, '../../eval/anchors');

function manifest(resourcePolicy: unknown = { maxToolCalls: 40 }): HarnessManifestV1 {
  return {
    schemaVersion: 1,
    profile: { id: 'kraken/v1', phase: 'build', hash: 'p'.repeat(32) },
    prompts: { kraken: harnessInputHash('k1') },
    capabilities: { toolManifestHash: 't'.repeat(32), skillManifestHash: 's'.repeat(32) },
    policies: {
      routingHash: 'r'.repeat(32),
      verificationHash: 'v'.repeat(32),
      completionPolicyHash: 'c'.repeat(32),
      compactionHash: 'm'.repeat(32),
      resourcePolicyHash: harnessInputHash(resourcePolicy),
    },
    runtime: { coreVersion: '2.5.0', cliVersion: '2.5.0' },
  };
}

describe('classifyHarnessChanges (§16)', () => {
  it('prompt change → behavioral', () => {
    const a = manifest();
    const b = manifest();
    b.prompts = { kraken: harnessInputHash('k2') };
    const cls = classifyHarnessChanges(diffHarnessManifest(a, b));
    expect(cls.overall).toBe('behavioral');
    expect(cls.byField['prompts.kraken']).toBe('behavioral');
  });

  it('runtime bump → structural', () => {
    const a = manifest();
    const b = manifest();
    b.runtime = { coreVersion: '2.6.0', cliVersion: '2.5.0' };
    expect(classifyHarnessChanges(diffHarnessManifest(a, b)).overall).toBe('structural');
  });

  it('no diff → cosmetic (standard CI)', () => {
    expect(classifyHarnessChanges(diffHarnessManifest(manifest(), manifest())).overall).toBe('cosmetic');
  });
});

describe('selectTargetedAnchors (§16.3)', () => {
  const anchors = loadAnchors(ANCHORS_DIR);

  it('resource policy change → only resource-budget anchors', () => {
    const sel = selectTargetedAnchors(manifest({ maxToolCalls: 40 }), manifest({ maxToolCalls: 80 }), anchors);
    expect(sel.overall).toBe('behavioral');
    expect(sel.anchors.every((a) => a.tags.includes('resource-budget'))).toBe(true);
    expect(sel.anchors.length).toBeGreaterThanOrEqual(1);
  });

  it('structural change → full anchor set', () => {
    const a = manifest();
    const b = manifest();
    b.profile = { id: 'kraken/v1', phase: 'plan', hash: 'p'.repeat(32) };
    const sel = selectTargetedAnchors(a, b, anchors);
    expect(sel.overall).toBe('structural');
    expect(sel.anchors).toHaveLength(anchors.length);
  });

  it('cosmetic → no anchors, standard CI', () => {
    const sel = selectTargetedAnchors(manifest(), manifest(), anchors);
    expect(sel.overall).toBe('cosmetic');
    expect(sel.anchors).toHaveLength(0);
  });
});
