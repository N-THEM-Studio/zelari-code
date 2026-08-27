/**
 * sandboxPath — enforce that filesystem tool paths stay inside an allowed
 * root directory (default: process.cwd()).
 *
 * Task A2 of AnathemaCoder v3-A; symlink-safe resolution added by P0.D (t18).
 *
 * Two-layer containment:
 *  1. TEXTUAL — normalize `..` segments and absolute forms, then prefix-match
 *     against the root. Fast path (zero syscalls), catches obvious escapes.
 *  2. SYMLINK-SAFE — realpath the DEEPEST EXISTING ANCESTOR of the target
 *     and require its REAL location to sit inside the REAL root
 *     (`fs.realpathSync` of the root). Defeats junction/symlink escapes
 *     — including chains a→b→outside and cross-drive junctions on win32 —
 *     that textual checks cannot see. Comparison folds character case only
 *     on platforms whose default FS is case-insensitive (win32, darwin);
 *     linux keeps exact comparison.
 *
 * Return-value stability: the resolver still returns the LEXICALLY resolved
 * path so rewritten tool args stay byte-identical across versions; a link
 * escape surfaces as SandboxViolationError instead of a silently different
 * target. When the sandbox root itself does not exist there is nothing
 * between it and the target that could be a link, so layer 2 degrades to
 * layer 1 (documented behaviour, keeps legacy fake-root usage working).
 *
 * TOCTOU 〔PW §5〕: `verifyContainment()` re-runs layer 2 on fresh syscalls.
 * Callers that mutate the FS may call it as the LAST step right before a
 * write to catch links swapped after an earlier permission check. The CLI
 * guarantee itself lives in `wrapWithSandbox` (toolRegistry.ts): resolve →
 * execute are adjacent, so for write_file/edit_file/apply_diff/read_file the
 * verified resolution IS the last step before the factory touches disk.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3.md (Task A2)
 */
import path from 'node:path';
import fs from 'node:fs';

export class SandboxViolationError extends Error {
  constructor(
    message: string,
    public readonly attemptedPath: string,
    public readonly resolvedPath: string,
  ) {
    super(message);
    this.name = 'SandboxViolationError';
  }
}

/** Platforms whose default filesystem is case-insensitive. */
const CASE_FOLDING_PLATFORMS = ['win32', 'darwin'];

/** True when path comparison must fold character case (win32/darwin only). */
const IS_CASE_FOLDING = CASE_FOLDING_PLATFORMS.includes(process.platform);

export interface SandboxOptions {
  /** Allowed root directory; defaults to process.cwd(). */
  root?: string;
}

/** Fold case only where the default filesystem is case-insensitive. */
function normalizedCase(p: string): string {
  return IS_CASE_FOLDING ? p.toLowerCase() : p;
}

/**
 * True when `candidate` equals or sits under `base`. Case folding is applied
 * ONLY on case-insensitive platforms (guard: process.platform). Cross-drive
 * targets on win32 fail here naturally — `C:\...` never starts with `E:\`.
 */
function isWithin(candidate: string, base: string): boolean {
  const c = normalizedCase(candidate);
  const b = normalizedCase(base);
  if (c === b) return true;
  const baseWithSep = b.endsWith(path.sep) ? b : b + path.sep;
  return c.startsWith(baseWithSep);
}

function escapeError(
  userPath: string,
  attempted: string,
  real: string,
  realRoot: string,
): SandboxViolationError {
  return new SandboxViolationError(
    `Path escapes sandbox root through a symlink/junction: ${userPath} → real ${real} is outside real root ${realRoot}`,
    userPath,
    attempted,
  );
}

/**
 * TEXTUAL containment check (layer 1) — unchanged Task A2 semantics.
 */
function assertLexicalContainment(
  resolved: string,
  root: string,
  userPath: string,
): void {
  // Ensure trailing separator for prefix check so `/foo/bar` does not match
  // `/foo/barbaz`.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new SandboxViolationError(
      `Path escapes sandbox root: ${userPath} → ${resolved} (root: ${root})`,
      userPath,
      resolved,
    );
  }
}

/**
 * SYMLINK-SAFE check (layer 2). Walks up from the lexically-resolved target
 * until realpath succeeds (deepest existing ancestor — fs.realpathSync
 * resolves whole chains natively, e.g. a→b→outside), verifies its REAL
 * location stays inside the REAL root, then re-applies textual containment
 * for the not-yet-existing suffix below that ancestor (it lands next to a
 * verified-inside parent, so this holds trivially — kept explicit as defense
 * in depth).
 *
 * Unexpected FS errors (EPERM & co.) degrade to layer 1 rather than crashing
 * unrelated operations — same failure surface as pre-P0.D.
 */
function assertRealAncestorContained(
  resolvedLexical: string,
  realRoot: string,
  userPath: string,
): void {
  let probe = resolvedLexical;
  let realProbe: string | null = null;
  for (;;) {
    if (probe === path.dirname(probe)) break; // filesystem apex reached
    try {
      realProbe = fs.realpathSync(probe);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        probe = path.dirname(probe);
        continue;
      }
      return; // degrade to textual layer only
    }
  }
  if (realProbe === null) return; // fully nonexistent chain → layer 1 already passed
  if (!isWithin(realProbe, realRoot)) {
    throw escapeError(userPath, resolvedLexical, realProbe, realRoot);
  }
  // Containment re-check for the non-existent remainder of the path.
  const suffix = resolvedLexical.startsWith(probe)
    ? resolvedLexical.slice(probe.length)
    : '';
  if (suffix.length > 0 && !isWithin(realProbe + suffix, realRoot)) {
    throw escapeError(userPath, resolvedLexical, realProbe + suffix, realRoot);
  }
}

function resolveSandboxedCore(
  userPath: string,
  options: SandboxOptions = {},
): string {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new SandboxViolationError('Empty path', userPath, '');
  }
  const root = path.resolve(options.root ?? process.cwd());
  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(root, userPath);

  // Layer 1: lexical containment after normalization.
  assertLexicalContainment(resolved, root, userPath);

  // Layer 2: symlink/junction safety. Skipped when the root itself does not
  // exist (ENOENT) — no ancestor between a nonexistent root and the target
  // can hold a link yet, and legacy fake-root callers keep working.
  let realRoot: string | null = null;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return resolved;
  }
  assertRealAncestorContained(resolved, realRoot, userPath);
  return resolved;
}

/**
 * Resolve a user-supplied path against an allowed root, throwing
 * SandboxViolationError if the result escapes the root.
 *
 * - Absolute paths are taken as-is but must be inside the root.
 * - Relative paths are joined to the root.
 * - P0.D: symlinks/junctions are now resolved via realpath of the deepest
 *   existing ancestor; any link resolving OUTSIDE the real root is rejected.
 *   Internal links (inside the workspace) keep working. The returned value
 *   is still the lexically normalized path.
 */
export function resolveSandboxedPath(
  userPath: string,
  options: SandboxOptions = {},
): string {
  return resolveSandboxedCore(userPath, options);
}

/**
 * Explicit name for the symlink-safe resolver (P0.D t18) — IDENTICAL
 * behavior to resolveSandboxedPath since P0.D upgraded it in place so every
 * existing caller inherits safety transparently (zero call-site churn).
 * Kept as a stable, self-documenting export for new call sites and tests.
 */
export const resolveSandboxedPathReal: typeof resolveSandboxedPath =
  resolveSandboxedPath;

/**
 * TOCTOU re-check 〔PW §5〕: re-run BOTH layers on fresh syscalls for an
 * ALREADY-resolved absolute path. Call this immediately before performing a
 * filesystem mutation when state may have changed since the original
 * resolveSandboxedPath call (e.g. a directory swapped for a junction between
 * the permission check and the write). Throws SandboxViolationError if the
 * candidate would now leave the real root; returns normally otherwise.
 */
export function verifyContainment(
  resolvedAbsolute: string,
  options: SandboxOptions = {},
): void {
  if (typeof resolvedAbsolute !== 'string' || resolvedAbsolute.length === 0) {
    throw new SandboxViolationError('Empty path', resolvedAbsolute, '');
  }
  const root = path.resolve(options.root ?? process.cwd());
  const resolved = path.resolve(resolvedAbsolute);
  assertLexicalContainment(resolved, root, resolvedAbsolute);
  let realRoot: string | null = null;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return; // root vanished / nonexistent → textual layer is all we have
  }
  assertRealAncestorContained(resolved, realRoot, resolvedAbsolute);
}

/**
 * Lightweight check that does NOT throw — returns true if the path
 * would be allowed by resolveSandboxedPath (symlink-aware since P0.D).
 */
export function isPathInsideSandbox(
  userPath: string,
  options: SandboxOptions = {},
): boolean {
  try {
    resolveSandboxedPath(userPath, options);
    return true;
  } catch {
    return false;
  }
}
