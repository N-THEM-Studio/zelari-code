import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  resolveSandboxedPath,
  isPathInsideSandbox,
  SandboxViolationError,
} from '../../src/cli/safety/sandboxPath.js';

describe('sandboxPath (Task A2)', () => {
  it('resolves a relative path against the root', () => {
    const root = '/tmp/sandbox-root';
    const resolved = resolveSandboxedPath('foo/bar.txt', { root });
    expect(resolved).toBe(path.join(root, 'foo/bar.txt'));
  });

  it('accepts an absolute path that is inside the root', () => {
    const root = '/tmp/sandbox-root';
    const inner = path.join(root, 'inside.txt');
    expect(resolveSandboxedPath(inner, { root })).toBe(inner);
  });

  it('throws SandboxViolationError for a path that escapes via ..', () => {
    const root = '/tmp/sandbox-root';
    expect(() => resolveSandboxedPath('../../etc/passwd', { root })).toThrow(
      SandboxViolationError,
    );
  });

  it('throws SandboxViolationError for an absolute path outside the root', () => {
    const root = '/tmp/sandbox-root';
    expect(() => resolveSandboxedPath('/etc/passwd', { root })).toThrow(
      SandboxViolationError,
    );
  });

  it('rejects /tmp/sandbox-rootbaz when root is /tmp/sandbox-root', () => {
    // Prefix confusion guard: /tmp/sandbox-root is NOT a prefix of
    // /tmp/sandbox-rootbaz without a trailing separator.
    const root = '/tmp/sandbox-root';
    expect(() => resolveSandboxedPath('/tmp/sandbox-rootbaz/x', { root })).toThrow(
      SandboxViolationError,
    );
  });

  it('isPathInsideSandbox returns false for paths that would throw', () => {
    expect(isPathInsideSandbox('../escape', { root: '/tmp/x' })).toBe(false);
  });

  it('isPathInsideSandbox returns true for allowed paths', async () => {
    // Create a real temp root so we exercise the absolute-path branch.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
    try {
      const inner = path.join(root, 'a.txt');
      expect(isPathInsideSandbox(inner, { root })).toBe(true);
      expect(isPathInsideSandbox('/etc/passwd', { root })).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('throws on empty path', () => {
    expect(() => resolveSandboxedPath('', { root: '/tmp' })).toThrow();
  });
});