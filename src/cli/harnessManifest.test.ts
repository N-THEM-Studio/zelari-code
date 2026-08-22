/**
 * src/cli/harnessManifest.test.ts — builder purity + event payload shape
 * (2.6 Track A). Version resolvers fall back deterministically when
 * `require` is unavailable (ESM test env) — the manifest itself must not.
 */

import { describe, expect, it } from 'vitest';
import { buildHarnessManifest, harnessManifestEventData } from './harnessManifest.js';
import { KRAKEN_V1, MINIMAL_V1 } from '@zelari/core';

const BASE = {
  profile: KRAKEN_V1,
  phase: 'build' as const,
  toolNames: KRAKEN_V1.tools,
  coreVersion: '2.5.0',
  cliVersion: '2.5.0',
};

describe('buildHarnessManifest', () => {
  it('produces the same hash for identical parts', () => {
    const a = buildHarnessManifest({ ...BASE, prompts: { kraken: 'k-prompt' } });
    const b = buildHarnessManifest({ ...BASE, prompts: { kraken: 'k-prompt' } });
    expect(a.manifestHash).toBe(b.manifestHash);
  });

  it('hashes prompt text — raw text never enters the manifest', () => {
    const { manifest } = buildHarnessManifest({ ...BASE, prompts: { kraken: 'SECRET-PROMPT-TEXT' } });
    expect(JSON.stringify(manifest)).not.toContain('SECRET-PROMPT-TEXT');
    expect(manifest.prompts.kraken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes hash when the resource policy changes', () => {
    const a = buildHarnessManifest({ ...BASE, resourcePolicy: { maxToolCalls: 40 } });
    const b = buildHarnessManifest({ ...BASE, resourcePolicy: { maxToolCalls: 60 } });
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });

  it('changes hash when the advertised tool set changes', () => {
    const a = buildHarnessManifest(BASE);
    const b = buildHarnessManifest({ ...BASE, toolNames: MINIMAL_V1.tools });
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });

  it('emits a valid event payload carrying manifest + hash', () => {
    const { manifest, manifestHash } = buildHarnessManifest(BASE);
    const data = harnessManifestEventData(manifest, manifestHash);
    expect(data.manifest).toBe(manifest);
    expect(data.manifestHash).toBe(manifestHash);
  });
});
