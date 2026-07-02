/**
 * workspace/paths.ts — Workspace root resolution.
 *
 * Default: project-local `.zelari/` (auto-gitignored).
 * Fallback: `~/.zelari-code/workspace/<project-hash>/` if cwd not writable.
 *
 * The fallback ensures the workspace always works — even in read-only
 * directories (Docker containers, system dirs, etc.).
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  accessSync,
  constants,
  realpathSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/**
 * Resolve the workspace root. Returns the first writable option:
 * 1. `<cwd>/.zelari/` if cwd is writable
 * 2. `~/.zelari-code/workspace/<project-hash>/` otherwise
 *
 * Side effect: creates the directory + auto-gitignore if missing.
 */
export function resolveWorkspaceRoot(
  projectRoot: string = process.cwd(),
): string {
  const candidates = [
    join(projectRoot, ".zelari"),
    join(homedir(), ".zelari-code", "workspace", hashProject(projectRoot)),
  ];

  for (const candidate of candidates) {
    if (isWritableDir(projectRoot) || candidate !== candidates[0]) {
      ensureWorkspaceDir(candidate);
      return candidate;
    }
  }
  // Last resort: first candidate (will likely fail on write but we tried)
  ensureWorkspaceDir(candidates[0]);
  return candidates[0];
}

/** Hash a project path to a stable short id (used in global fallback path). */
function hashProject(projectPath: string): string {
  return createHash("sha1")
    .update(realpathSync(projectPath))
    .digest("hex")
    .slice(0, 12);
}

/** Check if a directory is writable (creates if missing). */
function isWritableDir(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false; // don't create, just check
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Create workspace dir + auto-gitignore (if inside a git repo). */
function ensureWorkspaceDir(workspaceDir: string): void {
  mkdirSync(workspaceDir, { recursive: true });

  // Auto-gitignore ONLY if workspace is project-local AND inside a git repo
  if (
    workspaceDir.endsWith("/.zelari") &&
    existsSync(join(workspaceDir, "..", ".git"))
  ) {
    const gitignorePath = join(workspaceDir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, "*\n!.gitignore\n");
    }
  }
}

/** All standard workspace subdirs. */
export const WORKSPACE_SUBDIRS = [
  'decisions',
  'reviews',
  'docs',
  'risks', // file, not dir
  'plan.md', // file, not dir
  'workspace.json', // file, index
] as const;

/** Get the absolute path to a standard workspace file. */
export function workspaceFile(
  rootDir: string,
  kind: "plan" | "risks" | "index",
): string {
  switch (kind) {
    case "plan":
      return join(rootDir, "plan.md");
    case "risks":
      return join(rootDir, "risks.md");
    case "index":
      return join(rootDir, "workspace.json");
  }
}

/** Get the absolute path to a numbered artifact in a subdir. */
export function workspaceArtifact(
  rootDir: string,
  subdir: "decisions" | "reviews" | "docs",
  slug: string,
): string {
  return join(rootDir, subdir, `${slug}.md`);
}

/** Get human-readable project name from path (basename). */
export function projectName(projectRoot: string = process.cwd()): string {
  return basename(realpathSync(projectRoot));
}
