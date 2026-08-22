/**
 * runtime/harnessManifest.ts — canonical harness fingerprint (2.6 Track A, doc §6).
 *
 * The effective behaviour of Zelari depends on more than model+profile:
 * prompts, tool descriptions, skills, routing, verification/completion/
 * compaction/resource policies. Two runs with the same model can be
 * semantically different. The manifest captures that behaviour as a
 * canonical, versioned, hashable object:
 *
 *   - behavioural fields carry HASHES, never raw text (stable size, no
 *     prompt content leakage into eval reports);
 *   - hashing reuses `stableStringify`/`sha256Hex` from requestSnapshot
 *     (AGENTS.MD: zero deps; one canonical serializer);
 *   - no timestamps, no per-run volatile values — same harness build →
 *     same hash (§6.4). Runtime versions are per-build constants and are
 *     included on purpose: a release bump IS a harness candidate.
 *
 * Session integration: one state-only `session.harness_manifest` event per
 * session start (payload {manifest, manifestHash}) — never model-surface.
 */

import { z } from 'zod';
import { sha256Hex, stableStringify } from '../core/requestSnapshot.js';

export const HARNESS_MANIFEST_SCHEMA_VERSION = 1;

/** Hashes of the effective prompts (raw text never enters the manifest). */
export const HarnessPromptsSchema = z.object({
  kraken: z.string().min(1).optional(),
  gauntlet: z.string().min(1).optional(),
  council: z.string().min(1).optional(),
  mission: z.string().min(1).optional(),
});

export const HarnessManifestV1Schema = z.object({
  schemaVersion: z.literal(HARNESS_MANIFEST_SCHEMA_VERSION),
  profile: z.object({
    id: z.string().min(1),
    /** WorkPhase of the session that recorded the manifest. */
    phase: z.enum(['plan', 'build']),
    /** Hash of the full profile (see profileHash in profiles.ts). */
    hash: z.string().min(1),
  }),
  prompts: HarnessPromptsSchema,
  capabilities: z.object({
    toolManifestHash: z.string().min(1),
    skillManifestHash: z.string().min(1),
  }),
  policies: z.object({
    routingHash: z.string().min(1),
    verificationHash: z.string().min(1),
    completionPolicyHash: z.string().min(1),
    compactionHash: z.string().min(1),
    /** Behavioural since 2.6 Track B: budget policy shapes execution. */
    resourcePolicyHash: z.string().min(1),
  }),
  runtime: z.object({
    coreVersion: z.string().min(1),
    cliVersion: z.string().min(1),
  }),
});
export type HarnessManifestV1 = z.infer<typeof HarnessManifestV1Schema>;

/**
 * Deterministic manifest hash: canonical serialization (keys sorted
 * recursively), no timestamps. Same harness build → same hash.
 */
export function hashHarnessManifest(manifest: HarnessManifestV1): string {
  return sha256Hex(stableStringify(manifest));
}

/** Hash any behavioural input (prompt text, policy object) canonically. */
export function harnessInputHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** Field-level diff between two manifests (dotted paths of changed leaves). */
export interface HarnessManifestDiff {
  /** Dotted paths whose values differ, in deterministic order. */
  changed: string[];
}

function collectPaths(
  base: string,
  a: unknown,
  b: unknown,
  out: string[],
  depth = 0,
): void {
  if (depth > 6) return;
  if (stableStringify(a) === stableStringify(b)) return;
  const objA = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : null;
  const objB = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  if (objA && objB) {
    for (const key of [...new Set([...Object.keys(objA), ...Object.keys(objB)])].sort()) {
      collectPaths(base ? `${base}.${key}` : key, objA[key], objB[key], out, depth + 1);
    }
    return;
  }
  out.push(base);
}

/** Diff two manifests into sorted dotted paths (e.g. `prompts.kraken`). */
export function diffHarnessManifest(
  oldManifest: HarnessManifestV1,
  newManifest: HarnessManifestV1,
): HarnessManifestDiff {
  const changed: string[] = [];
  collectPaths('', oldManifest, newManifest, changed);
  return { changed: changed.sort() };
}

/**
 * 2.6 (doc section 16): harness change classification. Maps diff paths to
 * behavioural / structural / cosmetic classes driving the gate policy:
 *   behavioural -> anchor gate
 *   structural  -> anchor gate + invariants
 *   cosmetic    -> standard CI
 */
export type HarnessChangeClass = 'behavioral' | 'structural' | 'cosmetic';

const FIELD_CLASSES: ReadonlyArray<{ prefix: string; cls: HarnessChangeClass }> = [
  { prefix: 'prompts', cls: 'behavioral' },
  { prefix: 'capabilities.toolManifestHash', cls: 'behavioral' },
  { prefix: 'capabilities.skillManifestHash', cls: 'behavioral' },
  { prefix: 'policies.routingHash', cls: 'behavioral' },
  { prefix: 'policies.verificationHash', cls: 'behavioral' },
  { prefix: 'policies.completionPolicyHash', cls: 'structural' },
  { prefix: 'policies.compactionHash', cls: 'behavioral' },
  { prefix: 'policies.resourcePolicyHash', cls: 'behavioral' },
  { prefix: 'profile', cls: 'structural' },
  { prefix: 'runtime', cls: 'structural' },
  { prefix: 'schemaVersion', cls: 'structural' },
];

export interface HarnessChangeClassification {
  /** Highest-severity class present (behavioral > structural > cosmetic). */
  overall: HarnessChangeClass;
  byField: Record<string, HarnessChangeClass>;
  /**
   * 2.6.1 (plan §17): the FULL change set, per class. `overall` alone let a
   * behavioral change shadow a concurrent structural one — policy consumers
   * must read `changeSet` (structural present ⇒ structural gate, additive).
   */
  changeSet: HarnessChangeSet;
}

/** Plan §17: per-class field lists, nothing collapsed away. */
export interface HarnessChangeSet {
  structural: string[];
  behavioral: string[];
  cosmetic: string[];
}

export function classifyHarnessChanges(diff: HarnessManifestDiff): HarnessChangeClassification {
  const byField: Record<string, HarnessChangeClass> = {};
  for (const field of diff.changed) {
    const hit = FIELD_CLASSES.find((m) => field === m.prefix || field.startsWith(m.prefix + '.'));
    byField[field] = hit ? hit.cls : 'cosmetic';
  }
  const changeSet: HarnessChangeSet = { structural: [], behavioral: [], cosmetic: [] };
  for (const field of diff.changed) {
    changeSet[byField[field]!].push(field);
  }
  const order: Record<HarnessChangeClass, number> = { behavioral: 3, structural: 2, cosmetic: 1 };
  const overall = (Object.values(byField) as HarnessChangeClass[]).reduce<HarnessChangeClass>(
    (acc, cls) => (order[cls] > order[acc] ? cls : acc),
    'cosmetic',
  );
  return { overall, byField, changeSet };
}
