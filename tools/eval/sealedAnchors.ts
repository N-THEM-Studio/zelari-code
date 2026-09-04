/**
 * tools/eval/sealedAnchors.ts — anchor sealing (W2/t45, docs/EVALS.md #1).
 *
 * Sealing freezes the sha256 of chosen anchors (Tier-0 by convention) into
 * eval/anchors/sealed.json. scripts/verify-principles.mjs recomputes every
 * hash in CI: a sealed anchor whose BYTES change fails the merge gate —
 * the evolution loop may PROPOSE new anchors, never edit sealed ones
 * (ADR-0036 proposer/judge separation; the seal manifest is judge state).
 *
 * Pure core (computeSealManifest / verifySeal) + one writer that rewrites
 * ONLY the manifest — anchor files are never touched from here. To change a
 * sealed anchor deliberately: --unseal <id>, edit, --seal <id>, and the
 * published hash in docs/EVALS.md must be updated in the same change.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SEAL_VERSION = 1;
/** Seal manifest location, relative to the anchors dir. */
export const SEALED_REL = 'sealed.json';

/** Manifest path for a given anchors dir. */
export function sealPath(anchorDir: string): string {
  return path.join(anchorDir, SEALED_REL);
}

export interface SealedAnchor {
  id: string;
  /** POSIX path relative to the anchors dir (forward slashes, repo-stable). */
  file: string;
  sha256: string;
  tier: number;
  sealedAt: string;
}

export interface SealManifest {
  version: number;
  sealedAt: string;
  anchors: SealedAnchor[];
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Platform-independent anchor text: strip a UTF-8 BOM and normalize CRLF/CR
 * to LF BEFORE hashing. Sealed hashes must survive checkouts with different
 * `core.autocrlf` settings (sealed on Windows CRLF, verified on CI LF broke
 * every seal at once — post-v2.30.0 CI fix). Byte drift that matters (real
 * content edits) is untouched by this normalization.
 */
export function normalizeAnchorText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, '\n');
}

/** sha256 of an anchor file's NORMALIZED content (the only hashing path). */
export function sha256AnchorFile(file: string): string {
  return sha256Text(normalizeAnchorText(readFileSync(file, 'utf8')));
}

export interface AnchorFileRef {
  id: string;
  tier: number;
  /** POSIX path relative to the anchors dir. */
  relPath: string;
}

/** Every parsable `*.anchor.json` under the tree (deterministic order). */
export function listAnchorFiles(anchorDir: string): AnchorFileRef[] {
  if (!existsSync(anchorDir)) return [];
  const out: AnchorFileRef[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.anchor.json')) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(path.join(dir, entry.name), 'utf8'));
          if (parsed !== null && typeof parsed === 'object') {
            const o = parsed as { id?: unknown; tier?: unknown };
            if (typeof o.id === 'string' && typeof o.tier === 'number') {
              out.push({ id: o.id, tier: o.tier, relPath: `${prefix}${entry.name}` });
            }
          }
        } catch {
          // unparsable anchor file — skipped (the loader is the strict path)
        }
      }
    }
  };
  walk(anchorDir, '');
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Build the union of an existing manifest and the ids to seal NOW (hashing
 * their current bytes). Unknown id -> Error. Idempotent per id: already
 * sealed with the SAME hash -> kept as recorded; DIFFERENT hash -> Error
 * (drift is exactly what sealing exists to catch — unseal first).
 */
export function computeSealManifest(
  anchorDir: string,
  ids: readonly string[],
  sealedAt: string,
  existing: SealManifest | null,
): SealManifest {
  const files = listAnchorFiles(anchorDir);
  const byId = new Map(files.map((f) => [f.id, f]));
  const anchors: SealedAnchor[] = existing ? existing.anchors.map((a) => ({ ...a })) : [];
  const indexOf = (id: string) => anchors.findIndex((a) => a.id === id);
  for (const id of ids) {
    const ref = byId.get(id);
    if (!ref) {
      throw new Error(
        `unknown anchor id '${id}' — run --list to see every anchor id under ${anchorDir}`,
      );
    }
    const sha = sha256AnchorFile(path.join(anchorDir, ref.relPath));
    const at = indexOf(id);
    if (at >= 0) {
      if (anchors[at].sha256 !== sha) {
        throw new Error(
          `anchor '${id}' is already sealed with a different content hash — sealed anchors must not change (docs/EVALS.md #1); unseal deliberately first`,
        );
      }
      continue; // already sealed, same bytes — idempotent noop
    }
    anchors.push({ id, file: ref.relPath, sha256: sha, tier: ref.tier, sealedAt });
  }
  anchors.sort((a, b) => a.id.localeCompare(b.id));
  return { version: SEAL_VERSION, sealedAt: existing?.sealedAt ?? sealedAt, anchors };
}

/** Remove ids from a manifest (never touches anchor bytes). Unknown id -> Error. */
export function unsealIds(manifest: SealManifest, ids: readonly string[]): SealManifest {
  const known = new Set(manifest.anchors.map((a) => a.id));
  for (const id of ids) {
    if (!known.has(id)) {
      throw new Error(`anchor '${id}' is not sealed — nothing to unseal`);
    }
  }
  return {
    ...manifest,
    anchors: manifest.anchors.filter((a) => !ids.includes(a.id)),
  };
}

export function readSealManifest(file: string): SealManifest | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as SealManifest).anchors)) {
      return parsed as SealManifest;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSealManifest(
  file: string,
  manifest: SealManifest,
  opts: { dryRun?: boolean } = {},
): { written: boolean; path: string } {
  if (opts.dryRun === true) return { written: false, path: file };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { written: true, path: file };
}

export interface SealVerification {
  ok: boolean;
  sealedCount: number;
  problems: string[];
}

/**
 * Recompute every sealed hash against the bytes on disk. A null manifest
 * (nothing sealed yet) verifies ok with sealedCount 0.
 */
export function verifySeal(anchorDir: string, manifest: SealManifest | null): SealVerification {
  if (manifest === null) return { ok: true, sealedCount: 0, problems: [] };
  const problems: string[] = [];
  for (const a of manifest.anchors) {
    const abs = path.join(anchorDir, a.file);
    if (!existsSync(abs)) {
      problems.push(`sealed anchor '${a.id}': file missing (${a.file})`);
      continue;
    }
    try {
      const sha = sha256AnchorFile(abs);
      if (sha !== a.sha256) {
        problems.push(
          `sealed anchor '${a.id}' DRIFTED — content changed after sealing (${a.file}); unseal+reseal deliberately or revert (docs/EVALS.md #1)`,
        );
      }
    } catch (err) {
      problems.push(`sealed anchor '${a.id}': unreadable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { ok: problems.length === 0, sealedCount: manifest.anchors.length, problems };
}

/** Aggregate hash of the whole manifest — the value published in docs/EVALS.md. */
export function sealManifestHash(manifest: SealManifest): string {
  return sha256Text(JSON.stringify(manifest.anchors));
}
