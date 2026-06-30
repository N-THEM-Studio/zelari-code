/**
 * sandboxPath — enforce that filesystem tool paths stay inside an allowed
 * root directory (default: process.cwd()).
 *
 * Prevents the agent from escaping its working directory by using
 * `..` segments or absolute paths outside the sandbox.
 *
 * Task A2 of AnathemaCoder v3-A.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3.md (Task A2)
 */
import path from 'node:path';

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

/**
 * Resolve a user-supplied path against an allowed root, throwing
 * SandboxViolationError if the result escapes the root.
 *
 * - Absolute paths are taken as-is but must be inside the root.
 * - Relative paths are joined to the root.
 * - Symlink resolution is the caller's responsibility (the FS tool
 *   resolves on read/write); this function only checks textual containment
 *   after normalization.
 */
export function resolveSandboxedPath(
  userPath: string,
  options: { root?: string } = {},
): string {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new SandboxViolationError('Empty path', userPath, '');
  }
  const root = path.resolve(options.root ?? process.cwd());
  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(root, userPath);

  // Normalize for comparison: ensure trailing separator for prefix check
  // so `/foo/bar` does not match `/foo/barbaz`.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new SandboxViolationError(
      `Path escapes sandbox root: ${userPath} → ${resolved} (root: ${root})`,
      userPath,
      resolved,
    );
  }
  return resolved;
}

/**
 * Lightweight check that does NOT throw — returns true if the path
 * would be allowed by resolveSandboxedPath.
 */
export function isPathInsideSandbox(
  userPath: string,
  options: { root?: string } = {},
): boolean {
  try {
    resolveSandboxedPath(userPath, options);
    return true;
  } catch {
    return false;
  }
}