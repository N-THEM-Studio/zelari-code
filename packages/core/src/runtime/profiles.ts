/**
 * runtime/profiles.ts — versioned capability profiles (ADR-0022).
 *
 * A profile is an immutable, versioned capability set + orchestration mount.
 * `minimal/v1` is the benchmark baseline (P6: smallest orchestration);
 * `kraken/v1` the default product profile. The tool manifest hash makes
 * same-task/same-profile runs comparable.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ProfileSchema = z.object({
  /** `<name>/v<N>` — immutable once published. */
  id: z.string().regex(/^[a-z0-9-]+\/v\d+$/, 'profile id must be <name>/v<N>'),
  version: z.literal(1),
  description: z.string().min(1),
  tools: z.array(z.string().min(1)).min(1),
  orchestration: z.object({
    kraken: z.boolean(),
    council: z.boolean(),
    subagents: z.boolean(),
    mission: z.boolean(),
  }),
  verification: z.object({
    deterministicEngine: z.boolean(),
    llmVerifier: z.boolean(),
    strictCompletion: z.boolean(),
  }),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const MINIMAL_TOOLS = ['read_file', 'edit_file', 'bash', 'grep_content', 'list_files'] as const;

export const MINIMAL_V1: Profile = Object.freeze({
  id: 'minimal/v1',
  version: 1,
  description: 'Baseline single-agent loop: no orchestration, deterministic verification only.',
  tools: [...MINIMAL_TOOLS],
  orchestration: { kraken: false, council: false, subagents: false, mission: false },
  verification: { deterministicEngine: true, llmVerifier: false, strictCompletion: true },
});

export const KRAKEN_V1: Profile = Object.freeze({
  id: 'kraken/v1',
  version: 1,
  description: 'Default product profile: Kraken execution engine + tentacles + deterministic verification.',
  tools: [...MINIMAL_TOOLS, 'write_file', 'apply_diff', 'task', 'web_search', 'browser_check'],
  orchestration: { kraken: true, council: false, subagents: true, mission: false },
  verification: { deterministicEngine: true, llmVerifier: false, strictCompletion: true },
});

export const COUNCIL_V1: Profile = Object.freeze({
  id: 'council/v1',
  version: 1,
  description: 'Council deliberation profile (design phase): members on the session spine, no Kraken executor.',
  tools: [...MINIMAL_TOOLS, 'write_file'],
  orchestration: { kraken: false, council: true, subagents: false, mission: false },
  verification: { deterministicEngine: true, llmVerifier: false, strictCompletion: true },
});

export const MISSION_V1: Profile = Object.freeze({
  id: 'mission/v1',
  version: 1,
  description: 'Long-horizon mission profile: Kraken execution + council design + evidence-based completion.',
  tools: [...KRAKEN_V1.tools],
  orchestration: { kraken: true, council: true, subagents: true, mission: true },
  verification: { deterministicEngine: true, llmVerifier: false, strictCompletion: true },
});

export const BUILT_IN_PROFILES: Readonly<Record<string, Profile>> = Object.freeze({
  [MINIMAL_V1.id]: MINIMAL_V1,
  [KRAKEN_V1.id]: KRAKEN_V1,
  [COUNCIL_V1.id]: COUNCIL_V1,
  [MISSION_V1.id]: MISSION_V1,
});

export class UnknownProfileError extends Error {
  readonly code = 'UNKNOWN_PROFILE';
  constructor(
    public readonly requested: string,
    public readonly known: string[],
  ) {
    super(`Unknown profile "${requested}". Known profiles: ${known.join(', ')}`);
    this.name = 'UnknownProfileError';
  }
}

/** Resolve a built-in profile by id (fails loudly on typos). */
export function resolveProfile(id: string): Profile {
  const profile = BUILT_IN_PROFILES[id];
  if (!profile) throw new UnknownProfileError(id, Object.keys(BUILT_IN_PROFILES));
  return profile;
}

/** sha256 of the sorted tool names — recorded in the session header. */
export function toolManifestHash(tools: readonly string[]): string {
  const manifest = [...tools].sort().join(',');
  return createHash('sha256').update(manifest).digest('hex');
}
