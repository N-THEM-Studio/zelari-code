/**
 * tools/eval/anchorLoader.ts — loads + validates anchor manifests from disk
 * (2.6 Track A, doc §7). JSON + zod, zero deps. Deterministic ordering.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { AnchorManifestSchema, type AnchorManifest } from './types.ts';

export function loadAnchorFile(filePath: string): AnchorManifest {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  return AnchorManifestSchema.parse(raw);
}

/** Load every `*.anchor.json` under a directory tree (deterministic order). */
export function loadAnchors(dir: string): AnchorManifest[] {
  const anchors: AnchorManifest[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.anchor.json')) anchors.push(loadAnchorFile(full));
    }
  };
  walk(dir);
  // Stable order: tier asc, then id.
  return anchors.sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
}

/** Filter by tier (Tier 0 = PR smoke, 1 = merge gate, 2 = nightly). */
export function anchorsOfTier(anchors: readonly AnchorManifest[], tier: 0 | 1 | 2): AnchorManifest[] {
  return anchors.filter((a) => a.tier === tier);
}
