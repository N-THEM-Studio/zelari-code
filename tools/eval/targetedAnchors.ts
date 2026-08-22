/**
 * tools/eval/targetedAnchors.ts — manifest diff → targeted anchor selection
 * (2.6 Track A, doc §16.3). A behavioural change runs only the anchors whose
 * tags intersect the changed field groups; cosmetic changes run nothing
 * (standard CI); structural changes run everything + invariants.
 */

import { classifyHarnessChanges, diffHarnessManifest, type HarnessManifestV1 } from '@zelari/core';
import type { AnchorManifest } from './types.ts';

/** Anchor tags that each manifest field group targets. */
const FIELD_TO_TAGS: Readonly<Record<string, string[]>> = {
  'prompts.kraken': ['kraken', 'local-bugfix', 'multi-file'],
  'prompts.gauntlet': ['gauntlet'],
  'prompts.council': ['council'],
  'prompts.mission': ['mission'],
  'capabilities.toolManifestHash': ['multi-file', 'resource-budget', 'kraken'],
  'capabilities.skillManifestHash': ['skills'],
  'policies.routingHash': ['kraken', 'mission'],
  'policies.verificationHash': ['verification'],
  'policies.completionPolicyHash': ['verification'],
  'policies.compactionHash': ['compaction', 'recovery'],
  'policies.resourcePolicyHash': ['resource-budget'],
};

export interface TargetedAnchorSelection {
  overall: 'behavioral' | 'structural' | 'cosmetic';
  /** Anchors to run (all of them for structural/cosmetic-structural mixes). */
  anchors: AnchorManifest[];
  /** Why each anchor was selected (debug/report). */
  rationale: string;
}

export function selectTargetedAnchors(
  oldManifest: HarnessManifestV1,
  newManifest: HarnessManifestV1,
  anchors: readonly AnchorManifest[],
): TargetedAnchorSelection {
  const diff = diffHarnessManifest(oldManifest, newManifest);
  const classification = classifyHarnessChanges(diff);
  // 2.6.1 (plan §17): read the change SET, never `overall` — a structural
  // change keeps the full structural gate even when behavioral fields moved
  // in the same diff, and structural coverage can never shrink.
  const { structural, behavioral, cosmetic } = classification.changeSet;

  if (structural.length > 0) {
    return {
      overall: 'structural',
      anchors: [...anchors],
      rationale: `structural change (${structural.join(', ')}) — full anchor set + session invariants${behavioral.length > 0 ? ` (plus behavioral: ${behavioral.join(', ')})` : ''}`,
    };
  }
  // Unknown/unmapped field: assume behavioural — Tier 0 + every behavioral
  // tag match. NEVER zero anchors on an unmapped change (plan §17).
  const unknownFields = cosmetic.filter((f) => !(f in FIELD_TO_TAGS));
  if (unknownFields.length > 0) {
    const tier0 = anchors.filter((a) => a.tier === 0);
    const wanted = new Set<string>();
    for (const field of behavioral) for (const tag of FIELD_TO_TAGS[field] ?? []) wanted.add(tag);
    const targeted = anchors.filter((a) => a.tags.some((t) => wanted.has(t)));
    const merged = [...new Map([...tier0, ...targeted].map((a) => [a.id, a])).values()];
    return {
      overall: 'behavioral',
      anchors: merged,
      rationale: `unknown harness field (${unknownFields.join(', ')}) — Tier 0 + behavioral anchors as conservative floor (${merged.length}/${anchors.length})`,
    };
  }
  if (behavioral.length === 0) {
    return {
      overall: 'cosmetic',
      anchors: [],
      rationale: `cosmetic change (${diff.changed.join(', ') || 'no diff'}) — standard CI only`,
    };
  }

  // Behavioural: union of tags targeted by changed fields.
  const wantedTags = new Set<string>();
  for (const field of behavioral) {
    for (const tag of FIELD_TO_TAGS[field] ?? []) wantedTags.add(tag);
  }
  const targeted = anchors.filter((a) => a.tags.some((t) => wantedTags.has(t)));
  return {
    overall: 'behavioral',
    anchors: targeted,
    rationale: `behavioral change (${behavioral.join(', ')}) → tags [${[...wantedTags].sort().join(', ')}] → ${targeted.length}/${anchors.length} anchors`,
  };
}
