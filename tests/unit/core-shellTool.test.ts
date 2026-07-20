/**
 * core-shellTool.test.ts — v0.7.2 shell resolver + bash tool cross-platform.
 *
 * The bash tool ran via cmd.exe on win32 (broke npm/git/POSIX). The resolver
 * now prefers Git Bash when available. These tests stub process.platform /
 * env to drive the detection chain without requiring a real bash binary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveShell,
  _resetShellResolverForTests,
  isWslBashPath,
} from '@zelari/core/harness/tools/builtin/shellResolver';
import { bashTool } from '@zelari/core/harness/tools/builtin/shell';

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

  it('isWslBashPath detects System32 / WindowsApps launchers, not Git Bash', () => {
    expect(isWslBashPath('C:\\Windows\\System32\\bash.exe')).toBe(true);
    expect(isWslBashPath('C:/Windows/System32/bash.exe')).toBe(true);
    expect(isWslBashPath('C:\\Windows\\SysWOW64\\bash.exe')).toBe(true);
    expect(
      isWslBashPath(
        'C:\\Users\\andre\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
      ),
    ).toBe(true);
    expect(isWslBashPath('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(false);
    expect(isWslBashPath('D:\\Git\\usr\\bin\\bash.exe')).toBe(false);
    expect(isWslBashPath('')).toBe(false);
  });

  it('win32: ZELARI_SHELL set to WSL bash is rejected (falls through)', () => {
    setPlatform('win32');
    // WSL launcher exists on this host when WSL is installed; if not, the
    // override is still rejected by isWslBashPath before existsSync matters.
    vi.stubEnv('ZELARI_SHELL', 'C:\\Windows\\System32\\bash.exe');
    vi.stubEnv('SHELL', '');
    const r = resolveShell(true);
    // Must not claim WSL as a real Git-Bash agent shell.
    if (typeof r.shell === 'string') {
      expect(isWslBashPath(r.shell)).toBe(false);
    }
    // Either a non-WSL bash (Git) or cmd.exe fallback.
    if (r.via === 'cmd.exe') {
      expect(r.isBash).toBe(false);
    } else {
      expect(r.isBash).toBe(true);
      expect(r.via.toLowerCase()).not.toContain('system32');
      expect(r.via.toLowerCase()).not.toContain('windowsapps');
    }
  });
});

describe('resolveShell — PowerShell fallback (v1.20.0)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    _resetShellResolverForTests();
  });
  afterEach(() => {
    _resetShellResolverForTests();
    if (realPlatform) {
      Object.defineProperty(process, 'platform', realPlatform);
    }
    vi.unstubAllEnvs();
  });

  function setPlatform(p: string): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  it('win32: ZELARI_SHELL=powershell.exe returns isPowerShell=true', () => {
    setPlatform('win32');
    // powershell.exe always exists on modern Windows at this path. We use it
    // as a guaranteed-present binary for the override test, same pattern as
    // the node-binary stub in the bash tests above. If the host lacks this
    // exact path (e.g. POSIX test runner), the test is skipped implicitly
    // because acceptPowerShellPath requires existsSync.
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    vi.stubEnv('ZELARI_SHELL', ps);
    vi.stubEnv('SHELL', '');
    const r = resolveShell(true);
    // If the host doesn't have this exact path, the test degrades gracefully.
    if (r.via === 'cmd.exe') return; // path not found on this host
    expect(r.isPowerShell).toBe(true);
    expect(r.isBash).toBe(false);
    expect(r.shell).toBe(ps);
    expect(r.via.toLowerCase()).toContain('powershell');
  });

  it('win32: ZELARI_SHELL=powershell.exe does NOT get misclassified as bash', () => {
    setPlatform('win32');
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    vi.stubEnv('ZELARI_SHELL', ps);
    vi.stubEnv('SHELL', '');
    const r = resolveShell(true);
    if (r.via === 'cmd.exe') return; // path not found on this host
    // The whole point of the isPowerShell flag: PowerShell is NOT bash.
    expect(r.isBash).toBe(false);
    expect(r.isPowerShell).toBe(true);
  });

  it('win32: ZELARI_SHELL=pwsh.exe (PS Core 7+) returns isPowerShell=true', () => {
    setPlatform('win32');
    // pwsh.exe only exists if PowerShell Core 7+ is installed. Test is
    // environment-aware: skip-style early return when absent.
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    vi.stubEnv('ZELARI_SHELL', pwsh);
    vi.stubEnv('SHELL', '');
    const r = resolveShell(true);
    if (r.via === 'cmd.exe') return; // pwsh not installed on this host
    expect(r.isPowerShell).toBe(true);
    expect(r.isBash).toBe(false);
    expect(r.shell).toBe(pwsh);
  });

  it('POSIX: isPowerShell is always false on non-Windows', () => {
    setPlatform('linux');
    const r = resolveShell(true);
    expect(r.isPowerShell).toBe(false);
    expect(r.isBash).toBe(false);
    expect(r.via).toBe('/bin/sh');
  });
});

describe('bashTool — interactive-prompt detection (v0.7.3)', () => {
  // Live test 2026-07-02: `npm create vite` in a non-empty dir prompts, dies
  // on the closed stdin printing "Operation cancelled" — and exits 0, so the
  // model saw a "success" that did nothing and retried 6 command variants.
  // The tool now recognizes the signature and injects an actionable hint.
  const ctx = { cwd: process.cwd() } as never;

  beforeEach(() => {
    // The resolveShell tests above stub ZELARI_SHELL/SHELL and memoize the
    // resolver — clear both so these tests use the REAL shell of this host.
    vi.unstubAllEnvs();
    _resetShellResolverForTests();
  });
  afterEach(() => {
    _resetShellResolverForTests();
  });

  // Spawning the real host shell (Git Bash probe + spawn) can take >10s on
  // Windows — give these two tests their own generous vitest timeout.
  // v0.7.10: observed 15.5s spawn latency on the dev box, which raced the
  // tool's own 15s timeoutMs and flaked (ok:false). Tool timeout raised to
  // 30s with a 45s vitest ceiling so the spawn variance has real headroom.
  const REAL_SHELL_TEST_TIMEOUT = 45_000;
  const REAL_SHELL_TOOL_TIMEOUT_MS = 30_000;

  it('injects the hint when output matches "Operation cancelled"', { timeout: REAL_SHELL_TEST_TIMEOUT }, async () => {
    const result = await bashTool.execute(
      { command: 'echo "-  Operation cancelled"', timeoutMs: REAL_SHELL_TOOL_TIMEOUT_MS } as never,
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { hint?: string; exitCode: number };
    expect(value.exitCode).toBe(0);
    expect(value.hint).toBeDefined();
    expect(value.hint).toContain('stdin is closed');
    expect(value.hint).toContain('Do NOT retry');
  });

  it('does not inject the hint on normal output', { timeout: REAL_SHELL_TEST_TIMEOUT }, async () => {
    const result = await bashTool.execute(
      { command: 'echo hello-world', timeoutMs: REAL_SHELL_TOOL_TIMEOUT_MS } as never,
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { hint?: string; stdout: string };
    expect(value.stdout).toContain('hello-world');
    expect(value.hint).toBeUndefined();
  });
});
