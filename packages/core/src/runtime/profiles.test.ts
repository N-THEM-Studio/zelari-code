import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PROFILES,
  MINIMAL_V1,
  KRAKEN_V1,
  UnknownProfileError,
  resolveProfile,
  toolManifestHash,
} from './profiles.js';
import { isExperimentalEnabled } from '../experimental.js';

describe('profiles', () => {
  it('minimal/v1 is the immutable baseline capability set', () => {
    expect(MINIMAL_V1.tools).toEqual(['read_file', 'edit_file', 'bash', 'grep_content', 'list_files']);
    expect(MINIMAL_V1.orchestration).toEqual({ kraken: false, council: false, subagents: false, mission: false });
    expect(MINIMAL_V1.verification.strictCompletion).toBe(true);
  });

  it('kraken/v1 extends minimal with write/delegation tools and orchestration', () => {
    expect(KRAKEN_V1.orchestration.kraken).toBe(true);
    expect(KRAKEN_V1.orchestration.subagents).toBe(true);
    for (const tool of MINIMAL_V1.tools) {
      expect(KRAKEN_V1.tools).toContain(tool);
    }
  });

  it('resolveProfile fails loudly on unknown ids', () => {
    expect(() => resolveProfile('nope/v1')).toThrow(UnknownProfileError);
    try {
      resolveProfile('nope/v1');
    } catch (err) {
      expect((err as UnknownProfileError).known).toEqual(Object.keys(BUILT_IN_PROFILES));
    }
  });

  it('toolManifestHash is order-independent and profile-distinct', () => {
    expect(toolManifestHash(['b', 'a'])).toBe(toolManifestHash(['a', 'b']));
    expect(toolManifestHash(MINIMAL_V1.tools)).not.toBe(toolManifestHash(KRAKEN_V1.tools));
    expect(toolManifestHash(MINIMAL_V1.tools)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('experimental flags', () => {
  it('all flags default OFF', () => {
    expect(isExperimentalEnabled('bon', {})).toBe(false);
    expect(isExperimentalEnabled('bon', { ZELARI_EXPERIMENTAL: '' })).toBe(false);
  });

  it('CSV opt-in is case-insensitive and ignores unknown values', () => {
    const env = { ZELARI_EXPERIMENTAL: 'BoN, remote-sandbox' };
    expect(isExperimentalEnabled('bon', env)).toBe(true);
    expect(isExperimentalEnabled('remote-sandbox', env)).toBe(true);
    expect(isExperimentalEnabled('e2b-provider', env)).toBe(false);
  });
});
