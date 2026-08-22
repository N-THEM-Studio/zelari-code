/**
 * runtime/harnessManifest.test.ts — 2.6 Track A tests (doc §6.8).
 *
 * - same harness build → same hash (canonical serialization);
 * - prompt / tool / resource-policy change → different hash;
 * - key order in inputs never flips the hash;
 * - diff produces stable dotted paths.
 */

import { describe, expect, it } from 'vitest';
import {
  diffHarnessManifest,
  hashHarnessManifest,
  harnessInputHash,
  type HarnessManifestV1,
} from './harnessManifest.js';
import { KRAKEN_V1, MINIMAL_V1, profileHash, toolManifestHash } from './profiles.js';

function buildManifest(overrides: Partial<HarnessManifestV1> = {}): HarnessManifestV1 {
  return {
    schemaVersion: 1,
    profile: { id: 'kraken/v1', phase: 'build', hash: profileHash(KRAKEN_V1) },
    prompts: { kraken: harnessInputHash('kraken prompt v1') },
    capabilities: {
      toolManifestHash: toolManifestHash(KRAKEN_V1.tools),
      skillManifestHash: harnessInputHash(['skill-a']),
    },
    policies: {
      routingHash: harnessInputHash({ model: 'a' }),
      verificationHash: harnessInputHash({ engine: 'deterministic' }),
      completionPolicyHash: harnessInputHash({ mode: 'strict' }),
      compactionHash: harnessInputHash({ version: 1 }),
      resourcePolicyHash: harnessInputHash({ maxToolCalls: 40, verificationReserve: 6 }),
    },
    runtime: { coreVersion: '2.5.0', cliVersion: '2.5.0' },
    ...overrides,
  };
}

describe('hashHarnessManifest', () => {
  it('is deterministic for the same harness build', () => {
    const a = buildManifest();
    const b = buildManifest();
    expect(hashHarnessManifest(a)).toBe(hashHarnessManifest(b));
  });

  it('is stable against key insertion order in nested objects', () => {
    const a = buildManifest();
    const b: HarnessManifestV1 = {
      ...a,
      policies: {
        completionPolicyHash: a.policies.completionPolicyHash,
        compactionHash: a.policies.compactionHash,
        resourcePolicyHash: a.policies.resourcePolicyHash,
        routingHash: a.policies.routingHash,
        verificationHash: a.policies.verificationHash,
      },
    };
    expect(hashHarnessManifest(a)).toBe(hashHarnessManifest(b));
  });

  it('changes when a prompt changes', () => {
    const base = buildManifest();
    const changed = buildManifest({
      prompts: { kraken: harnessInputHash('kraken prompt v2') },
    });
    expect(hashHarnessManifest(base)).not.toBe(hashHarnessManifest(changed));
  });

  it('changes when the tool manifest changes', () => {
    const base = buildManifest();
    const changed = buildManifest({
      capabilities: { ...base.capabilities, toolManifestHash: toolManifestHash(MINIMAL_V1.tools) },
    });
    expect(hashHarnessManifest(base)).not.toBe(hashHarnessManifest(changed));
  });

  it('changes when the resource policy changes', () => {
    const base = buildManifest();
    const changed = buildManifest({
      policies: {
        ...base.policies,
        resourcePolicyHash: harnessInputHash({ maxToolCalls: 60, verificationReserve: 6 }),
      },
    });
    expect(hashHarnessManifest(base)).not.toBe(hashHarnessManifest(changed));
  });

  it('changes when the profile changes', () => {
    const base = buildManifest();
    const changed = buildManifest({
      profile: { id: 'minimal/v1', phase: 'build', hash: profileHash(MINIMAL_V1) },
    });
    expect(hashHarnessManifest(base)).not.toBe(hashHarnessManifest(changed));
  });
});

describe('profileHash', () => {
  it('is stable for the same profile object and differs across profiles', () => {
    expect(profileHash(KRAKEN_V1)).toBe(profileHash(KRAKEN_V1));
    expect(profileHash(KRAKEN_V1)).not.toBe(profileHash(MINIMAL_V1));
    expect(profileHash(KRAKEN_V1)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('diffHarnessManifest', () => {
  it('returns empty for identical manifests', () => {
    expect(diffHarnessManifest(buildManifest(), buildManifest()).changed).toEqual([]);
  });

  it('reports dotted paths for changed leaves only', () => {
    const base = buildManifest();
    const changed = buildManifest({
      prompts: { kraken: harnessInputHash('v2') },
      policies: { ...base.policies, routingHash: harnessInputHash({ model: 'b' }) },
    });
    expect(diffHarnessManifest(base, changed).changed).toEqual([
      'policies.routingHash',
      'prompts.kraken',
    ]);
  });

  it('reports a path for added prompt keys', () => {
    const base = buildManifest();
    const changed = buildManifest({
      prompts: { ...base.prompts, gauntlet: harnessInputHash('gauntlet v1') },
    });
    expect(diffHarnessManifest(base, changed).changed).toEqual(['prompts.gauntlet']);
  });
});
