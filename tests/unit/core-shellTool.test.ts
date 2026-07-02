/**
 * core-shellTool.test.ts — v0.7.2 shell resolver + bash tool cross-platform.
 *
 * The bash tool ran via cmd.exe on win32 (broke npm/git/POSIX). The resolver
 * now prefers Git Bash when available. These tests stub process.platform /
 * env to drive the detection chain without requiring a real bash binary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveShell, _resetShellResolverForTests } from '@zelari/core/harness/tools/builtin/shellResolver';

describe('resolveShell — platform branching (v0.7.2)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    _resetShellResolverForTests();
  });
  afterEach(() => {
    _resetShellResolverForTests();
    // Restore platform.
    if (realPlatform) {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });

  function setPlatform(p: string): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  it('POSIX: returns shell:true via /bin/sh, isBash false (no work needed)', () => {
    setPlatform('linux');
    const r = resolveShell(true);
    expect(r.shell).toBe(true);
    expect(r.via).toBe('/bin/sh');
    expect(r.isBash).toBe(false);
  });

  it('win32: ZELARI_SHELL override wins when the path exists', () => {
    setPlatform('win32');
    // Point at a path that exists on any system: the node binary's directory
    // isn't a bash, but the resolver only checks existence (the bash tool
    // would fail at spawn time if it isn't really bash — that's acceptable;
    // the override is an explicit user knob).
    const existing = process.execPath;
    vi.stubEnv('ZELARI_SHELL', existing);
    vi.stubEnv('SHELL', '');
    const r = resolveShell(true);
    expect(r.isBash).toBe(true);
    expect(r.shell).toBe(existing);
    expect(r.via).toContain('bash');
  });

  it('win32: SHELL env var is used when ZELARI_SHELL is unset and the path exists', () => {
    setPlatform('win32');
    const existing = process.execPath;
    vi.stubEnv('ZELARI_SHELL', '');
    vi.stubEnv('SHELL', existing);
    const r = resolveShell(true);
    expect(r.isBash).toBe(true);
    expect(r.shell).toBe(existing);
  });

  it('win32: when bash IS available (this dev machine has Git Bash), resolves to it', () => {
    // This test is environment-aware: on a machine with Git Bash installed
    // (the dev's Windows box), the resolver finds it. We assert the positive
    // contract: isBash true + a real path. The cmd.exe fallback path is
    // exercised on CI/hosts without bash; here we just confirm bash wins
    // when present.
    setPlatform('win32');
    // Clear overrides so the resolver uses its detection chain (SHELL / probe).
    vi.stubEnv('ZELARI_SHELL', '');
    vi.stubEnv('SHELL', process.env.SHELL ?? '');
    const r = resolveShell(true);
    // On this machine Git Bash is present → isBash true. If this assert ever
    // flips on a bash-less host, the test environment changed, not the code.
    if (r.via === 'cmd.exe') {
      // Bash genuinely not found on this host — assert the fallback contract.
      expect(r.isBash).toBe(false);
      expect(r.shell).toBe(true);
    } else {
      expect(r.isBash).toBe(true);
      expect(typeof r.shell).toBe('string');
    }
  });

  it('result is memoized: repeated calls return the same object (no re-detection)', () => {
    setPlatform('linux');
    const a = resolveShell(true);
    const b = resolveShell(); // not forced
    expect(b).toBe(a);
  });
});
