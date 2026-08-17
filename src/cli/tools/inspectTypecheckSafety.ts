/**
 * inspectTypecheckSafety — S3.5 "typecheck artifact safety" guard.
 *
 * `inspect_command(typecheck)` must never leave build artifacts in the
 * workspace. `tsc --noEmit` on `incremental`/`composite` projects writes a
 * `.tsbuildinfo` file (TypeScript issue #30661: "incremental is on by default
 * if composite is on... new build artifacts in unexpected places for people
 * using --noEmit today"), so the caller redirects it to the OS temp dir AND
 * this module fingerprints the workspace before/after to catch ANY artifact
 * class — including ones we did not predict.
 *
 * Fingerprint = `git status --porcelain` + sorted list of every `*.tsbuildinfo`
 * under the root (node_modules/.git excluded). Any delta ⇒ the caller reports
 * `status: 'degraded'` + `artifactsWritten` and triggers cleanup.
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Directories never scanned for tsbuildinfo artifacts. */
const SCAN_SKIP = new Set(['node_modules', '.git']);

export interface WorkspaceFingerprint {
  /** `git status --porcelain` output, or a marker when git is unusable. */
  gitStatus: string;
  /** Sorted relative paths of every `*.tsbuildinfo` under root. */
  tsbuildinfoFiles: string[];
}

export interface ArtifactDelta {
  /** tsbuildinfo files that appeared during the run (relative paths). */
  newTsbuildinfo: string[];
  /** True when `git status --porcelain` changed (any tracked-file delta). */
  gitStatusChanged: boolean;
}

/** Recursively list `*.tsbuildinfo` under `root` (node_modules/.git skipped). */
export async function scanTsbuildinfo(root: string): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions, races) — not our artifact class
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_SKIP.has(entry.name)) stack.push(p);
      } else if (entry.name.endsWith('.tsbuildinfo')) {
        found.push(path.relative(root, p).split(path.sep).join('/'));
      }
    }
  }
  found.sort();
  return found;
}

/** `git status --porcelain` in `root`; marker strings when git is unusable. */
async function gitStatusPorcelain(root: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain'], { cwd: root, shell: false });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve('<git-unavailable>'));
    child.on('close', (code) => resolve(code === 0 ? out : `<git-exit-${code ?? 'none'}>`));
  });
}

/** Snapshot the workspace state before/after a typecheck run. */
export async function fingerprintWorkspace(root: string): Promise<WorkspaceFingerprint> {
  const [gitStatus, tsbuildinfoFiles] = await Promise.all([
    gitStatusPorcelain(root),
    scanTsbuildinfo(root),
  ]);
  return { gitStatus, tsbuildinfoFiles };
}

/** Compare pre/post fingerprints; empty delta = workspace untouched. */
export function diffFingerprints(pre: WorkspaceFingerprint, post: WorkspaceFingerprint): ArtifactDelta {
  const preSet = new Set(pre.tsbuildinfoFiles);
  return {
    newTsbuildinfo: post.tsbuildinfoFiles.filter((f) => !preSet.has(f)),
    gitStatusChanged: post.gitStatus !== pre.gitStatus,
  };
}

/** Best-effort removal of artifacts written during the run. */
export async function cleanupArtifacts(
  root: string,
  relPaths: string[],
): Promise<{ cleaned: string[]; failed: string[] }> {
  const cleaned: string[] = [];
  const failed: string[] = [];
  for (const rel of relPaths) {
    try {
      await fs.unlink(path.join(root, rel));
      cleaned.push(rel);
    } catch {
      failed.push(rel);
    }
  }
  return { cleaned, failed };
}

/**
 * Classify a tsc failure as a project-shape refusal (composite/incremental
 * incompatibility at the compiler level — an error about HOW the project is
 * built, not a type error). Returns the loud reason, or null when the output
 * looks like ordinary diagnostics.
 */
export function classifyTypecheckRefusal(output: string): string | null {
  if (/composite/i.test(output) && /(may not|cannot|disallow|disable)/i.test(output)) {
    return (
      'the TypeScript compiler refused to run on this composite/incremental project shape ' +
      '(tsc-level error about the build setup, not a type error) — inspect_command will not ' +
      'fake an empty result; run the project typecheck script directly if you need it'
    );
  }
  return null;
}
