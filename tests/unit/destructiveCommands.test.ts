import { describe, expect, it } from 'vitest';
import {
  commandTextFrom,
  destructiveCommandHit,
} from '../../src/cli/safety/destructiveCommands.js';
import { resolveJailMode } from '../../src/cli/safety/osJail.js';

describe('destructiveCommands (v2.32 S5)', () => {
  describe('shell command strings (input.command)', () => {
    const hits: Array<[string, string]> = [
      ['rm -rf /tmp/x', "'rm' recursive+force delete"],
      ['rm -fr build', "'rm' recursive+force delete"],
      ['rm -rvf dist', "'rm' recursive+force delete"],
      ['del /s /q build', "'del /s' subtree delete"],
      ['rd /s /q node_modules', "'rd /s' subtree delete"],
      ['Remove-Item -Recurse -Force .next', "'Remove-Item -Recurse' recursive delete"],
      ['format D:', "'format <volume>:'"],
      ['git push --force origin main', "'git push --force'"],
      ['mkfs.ext4 /dev/sda1', "'mkfs' filesystem format"],
      ['dd if=img.iso of=/dev/sdb', "'dd' raw device write"],
      ['chmod -R 777 / ', "'chmod -R 777 /' root permission wipe"],
    ];
    for (const [cmd, label] of hits) {
      it(`asks for: ${cmd}`, () => {
        expect(destructiveCommandHit({ command: cmd })).toBe(label);
      });
    }

    const misses: string[] = [
      'rm notes.txt', // no recursive+force combo
      'rm -r build', // recursive but not forced — allowed shape
      'del notes.txt',
      'git push origin main',
      'git status',
      'node scripts/build.mjs',
      'npm run typecheck',
    ];
    for (const cmd of misses) {
      it(`does not ask for: ${cmd}`, () => {
        expect(destructiveCommandHit({ command: cmd })).toBeNull();
      });
    }
  });

  describe('argv shape (exec_process input.program+args)', () => {
    it('reassembles the argv and asks for rm -rf', () => {
      expect(
        destructiveCommandHit({ program: 'rm', args: ['-rf', '/tmp/x'] }),
      ).toBe("'rm' recursive+force delete");
    });
    it('asks for git push --force via argv', () => {
      expect(
        destructiveCommandHit({ program: 'git', args: ['push', '--force'] }),
      ).toBe("'git push --force'");
    });
    it('null for benign argv', () => {
      expect(destructiveCommandHit({ program: 'node', args: ['--version'] })).toBeNull();
    });
  });

  describe('commandTextFrom', () => {
    it('joins command and program parts when both present', () => {
      expect(commandTextFrom({ command: 'echo hi', program: 'rm', args: ['-rf', 'x'] })).toContain(
        'rm -rf x',
      );
    });
    it('empty for inputs without command shape', () => {
      expect(commandTextFrom({ path: 'a.ts' })).toBe('');
      expect(destructiveCommandHit({ path: 'a.ts' })).toBeNull();
    });
  });
});

describe('resolveJailMode preset alignment (v2.32 S4)', () => {
  it('ZELARI_PERMISSION_PRESET=strict carries strict intent (advisory when no backend, never silent)', () => {
    // On win32 (this CI matrix) the backend is honestly unavailable, so the
    // strict-intent default resolves to a VISIBLE advisory — the exact
    // behavior S4 pins. Explicit ZELARI_OS_JAIL still wins, as before.
    const mode = resolveJailMode(undefined, { ZELARI_PERMISSION_PRESET: 'strict' });
    expect(mode === 'advisory' || mode === 'required').toBe(true);
    expect(mode).not.toBe('off');
  });
  it('explicit ZELARI_OS_JAIL=off wins over the strict preset', () => {
    expect(resolveJailMode('off', { ZELARI_PERMISSION_PRESET: 'strict' })).toBe('off');
  });
  it('explicit ZELARI_OS_JAIL=required wins (the enforceable deny on missing backend)', () => {
    expect(resolveJailMode('required', { ZELARI_PERMISSION_PRESET: 'standard' })).toBe('required');
  });
  it('standard preset stays advisory', () => {
    expect(resolveJailMode(undefined, { ZELARI_PERMISSION_PRESET: 'standard' })).toBe('advisory');
  });
});
