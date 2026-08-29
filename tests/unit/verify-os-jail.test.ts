/**
 * verify-os-jail.test.ts — the t28 (Pilastro A) grep-gate
 * (scripts/verify-os-jail.mjs) stays green on this repo and catches its two
 * flagship violations: a raw child_process spawn back on the exec_process
 * path, or a raw spawn introduced on the CLI bash path (toolRegistry).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVerifyOsJail, REPO_ROOT } from '../../scripts/verify-os-jail.mjs';

describe('verify-os-jail (t28 choke-point gate)', () => {
  it('passes on the real repo', () => {
    const result = runVerifyOsJail(REPO_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags a raw spawn back on the exec_process path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voj-exec-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'cli', 'tools'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'src', 'cli', 'tools', 'execProcess.ts'),
        "import { spawn } from 'node:child_process';\nexport const t = () => spawn('sh', ['-c', 'rm']);\n",
      );
      const result = runVerifyOsJail(root);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.check === 'exec-choke-point' && /raw spawn/.test(e.msg))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a raw spawn introduced on the CLI bash path (toolRegistry)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voj-bash-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'cli'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'src', 'cli', 'toolRegistry.ts'),
        "import { spawn } from 'node:child_process';\nspawn('bash', ['-c', cmd]);\n",
      );
      const result = runVerifyOsJail(root);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.check === 'bash-seam' && /raw spawn/.test(e.msg))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a missing osJail choke-point / falsified win32 probe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voj-owner-'));
    try {
      const result = runVerifyOsJail(root);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.check === 'choke-point-owner')).toBe(true);
      fs.mkdirSync(path.join(root, 'src', 'cli', 'safety', 'jails'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'src', 'cli', 'safety', 'jails', 'win32.ts'),
        'export const probe = () => ({ available: true });\n', // fake containment
      );
      const after = runVerifyOsJail(root);
      expect(after.errors.some((e) => e.check === 'jails' && /available:false/.test(e.msg))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
