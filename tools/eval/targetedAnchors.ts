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

  if (classification.overall === 'structural') {
    return {
      overall: 'structural',
      anchors: [...anchors],
      rationale: `structural change (${diff.changed.join(', ')}) — full anchor set + session invariants`,
    };
  }
  if (classification.overall === 'cosmetic') {
    return {
      overall: 'cosmetic',
      anchors: [],
      rationale: `cosmetic change (${diff.changed.join(', ') || 'no diff'}) — standard CI only`,
    };
  }

  // Behavioural: union of tags targeted by changed fields.
  const wantedTags = new Set<string>();
  for (const field of diff.changed) {
    for (const tag of FIELD_TO_TAGS[field] ?? []) wantedTags.add(tag);
  }
  const targeted = anchors.filter((a) => a.tags.some((t) => wantedTags.has(t)));
  return {
    overall: 'behavioral',
    anchors: targeted,
    rationale: `behavioral change (${diff.changed.join(', ')}) → tags [${[...wantedTags].sort().join(', ')}] → ${targeted.length}/${anchors.length} anchors`,
  };
}
