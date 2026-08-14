/**
 * verify-principles.test.ts — the mechanical first-principles gate
 * (scripts/verify-principles.mjs, ADR-0010) stays green on this repo and
 * catches its two flagship violations: heavy deps (P5) and tool files
 * without Zod schemas (P2 derivation).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVerifyPrinciples, REPO_ROOT } from '../../scripts/verify-principles.mjs';

describe('verify-principles', () => {
  it('passes on the real repo', () => {
    const result = runVerifyPrinciples(REPO_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags a banned heavy dependency (P5)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-deps-'));
    try {
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', license: 'Apache-2.0', dependencies: { lodash: '^4.17.0' } }),
      );
      const result = runVerifyPrinciples(root);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.check === 'deps' && /lodash/.test(e.msg))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a builtin tool file without a zod schema (P2 derivation)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-tools-'));
    try {
      const dir = path.join(root, 'packages', 'core', 'src', 'core', 'tools', 'builtin');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'good.ts'),
        "import { z } from 'zod';\nexport const okTool: ToolDefinition<A, R> = {};\n",
      );
      fs.writeFileSync(
        path.join(dir, 'bad.ts'),
        'export const badTool: ToolDefinition<A, R> = {};\n',
      );
      const result = runVerifyPrinciples(root);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.check === 'zod-tools' && /bad\.ts/.test(e.msg))).toBe(true);
      expect(result.errors.some((e) => e.check === 'zod-tools' && /good\.ts/.test(e.msg))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
