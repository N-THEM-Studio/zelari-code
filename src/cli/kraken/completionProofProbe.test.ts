/**
 * completionProofProbe.test — tripwires for the environment-derived
 * attestation inputs (t20). The probe intentionally keeps a LITERAL mirror
 * of the verification adapter registry (adapters carry no id field); these
 * tests make any registry↔mirror drift fail loudly instead of silently
 * changing harness-manifest attestation identity.
 */
import { describe, expect, it } from 'vitest';
import { harnessManifest } from './completionProofProbe.js';
import { VERIFICATION_ADAPTERS } from './verificationAdapters/index.js';

describe('completionProofProbe — harness manifest', () => {
  it('adapter mirror stays in sync with the verification adapter registry', async () => {
    const manifest = await harnessManifest({});
    expect(manifest.adapters).toHaveLength(VERIFICATION_ADAPTERS.length);
  });

  it('adapters are declared in registry order (node first, newest last)', async () => {
    const manifest = await harnessManifest({});
    expect([...manifest.adapters]).toEqual([
      'node',
      'python',
      'rust',
      'go',
      'java',
      'dotnet',
    ]);
  });
});
