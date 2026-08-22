/**
 * src/cli/harnessManifest.ts — builds and emits the canonical harness
 * manifest for the running CLI session (2.6 Track A, doc §6).
 *
 * Pure assembly: raw prompt texts / policy objects go IN, hashes come OUT
 * (never the raw text). Version resolution follows the updater.ts precedent
 * (`__dirname` + `require`, bundle-safe); everything else is injected so the
 * builder stays unit-testable and deterministic.
 */

import {
  HarnessManifestV1Schema,
  harnessInputHash,
  hashHarnessManifest,
  type HarnessManifestV1,
} from '@zelari/core';
import { profileHash, toolManifestHash, type Profile } from '@zelari/core';
import { getCurrentVersion } from './updater.js';

/** Raw behavioural inputs the CLI knows how to collect today. */
export interface HarnessManifestParts {
  profile: Profile;
  /** WorkPhase of this session ('plan' | 'build'). */
  phase: 'plan' | 'build';
  /** Raw prompt texts keyed by role — hashed before entering the manifest. */
  prompts?: Partial<Record<'kraken' | 'gauntlet' | 'council' | 'mission', string>>;
  /** Tool names advertised to the model for this session. */
  toolNames: readonly string[];
  /** Skill ids loaded for this session (empty = none). */
  skillIds?: readonly string[];
  /** Routing policy object (model selection rules) — hashed canonically. */
  routing?: unknown;
  /** Verification engine config — hashed canonically. */
  verification?: unknown;
  /** Completion policy object — hashed canonically. */
  completionPolicy?: unknown;
  /** Compaction policy/config — hashed canonically. */
  compaction?: unknown;
  /**
   * Resource policy (2.6 Track B, doc §11.2) — behavioural, hashed canonically.
   * Defaults to the "unset" marker until Track B wires the real policy.
   */
  resourcePolicy?: unknown;
  coreVersion?: string;
  cliVersion?: string;
}

function resolveCoreVersion(): string {
  try {
    // Same bundle-safe precedent as updater.ts getCurrentVersion().
    const pkgPath = require.resolve('@zelari/core/package.json');
    const pkg = require(pkgPath) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Build + validate + hash the manifest. Throws on invalid assembly. */
export function buildHarnessManifest(parts: HarnessManifestParts): {
  manifest: HarnessManifestV1;
  manifestHash: string;
} {
  const prompts: HarnessManifestV1['prompts'] = {};
  for (const [role, text] of Object.entries(parts.prompts ?? {})) {
    if (typeof text === 'string' && text.length > 0) {
      prompts[role as keyof HarnessManifestV1['prompts']] = harnessInputHash(text);
    }
  }
  const manifest: HarnessManifestV1 = HarnessManifestV1Schema.parse({
    schemaVersion: 1,
    profile: {
      id: parts.profile.id,
      phase: parts.phase,
      hash: profileHash(parts.profile),
    },
    prompts,
    capabilities: {
      toolManifestHash: toolManifestHash(parts.toolNames),
      skillManifestHash: harnessInputHash([...(parts.skillIds ?? [])].sort()),
    },
    policies: {
      routingHash: harnessInputHash(parts.routing ?? { unset: true }),
      verificationHash: harnessInputHash(parts.verification ?? { engine: 'deterministic' }),
      completionPolicyHash: harnessInputHash(parts.completionPolicy ?? { mode: 'strict', required: '*' }),
      compactionHash: harnessInputHash(parts.compaction ?? { version: 1 }),
      resourcePolicyHash: harnessInputHash(parts.resourcePolicy ?? { unset: true }),
    },
    runtime: {
      coreVersion: parts.coreVersion ?? resolveCoreVersion(),
      cliVersion: parts.cliVersion ?? getCurrentVersion(),
    },
  });
  return { manifest, manifestHash: hashHarnessManifest(manifest) };
}

/** Session event payload for `session.harness_manifest` (state-only). */
export function harnessManifestEventData(manifest: HarnessManifestV1, manifestHash: string): Record<string, unknown> {
  return { manifest, manifestHash };
}
