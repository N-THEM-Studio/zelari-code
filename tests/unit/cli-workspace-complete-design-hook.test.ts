/**
 * cli-workspace-complete-design-hook.test.ts — Tests for the
 * complete-design post-processor auto-invocation in runPostCouncilHook.
 *
 * Background: the 6-member council reliably produces phases + ADRs +
 * design docs, but composer-2.5 systematically refuses to emit
 * createTask/createMilestone as real tool calls. A deterministic
 * post-processor (complete-design.mjs) reads plan.json and fills in
 * the missing artifacts from a template.
 *
 * v0.7.7 Opzione B: this script runs automatically at the end of the
 * council (after AGENTS.MD maintenance), gated on plan.json existing
 * with phases > 0. Disabled by ZELARI_COMPLETE_DESIGN=0 env var.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCompleteDesignPostProcessor,
  runPostCouncilHook,
} from '../../src/cli/workspace/postCouncilHook.js';
import { createWorkspaceContext } from '../../src/cli/workspace/stubs.js';

let tmpDir: string;
let projectRoot: string;
let ctx: ReturnType<typeof createWorkspaceContext>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-complete-design-'));
  projectRoot = tmpDir;
  ctx = createWorkspaceContext(projectRoot);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── runCompleteDesignPostProcessor ───────────────────────────────────────────

describe('runCompleteDesignPostProcessor', () => {
  it('returns ran=false when .zelari/plan.json is missing (not design-phase)', async () => {
    // No .zelari/plan.json => council did not produce design-phase artifacts.
    const result = await runCompleteDesignPostProcessor(ctx);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain('plan.json');
  });

  it('returns ran=false when plan.json exists but has zero phases', async () => {
    writeFileSync(join(ctx.rootDir, 'plan.json'), JSON.stringify({
      phases: [],
      tasks: [],
      milestones: [],
    }, null, 2), 'utf8');
    const result = await runCompleteDesignPostProcessor(ctx);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain('no phases');
  });

  it('returns ran=false when complete-design.mjs is missing in project root', async () => {
    // plan.json with phases exists, but no complete-design.mjs in root.
    writeFileSync(join(ctx.rootDir, 'plan.json'), JSON.stringify({
      phases: [{ id: 'phase-1', name: 'p1', order: 1 }],
      tasks: [],
      milestones: [],
    }, null, 2), 'utf8');
    const result = await runCompleteDesignPostProcessor(ctx);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain('complete-design.mjs');
  });

  it('runs the script and returns ran=true when plan.json + complete-design.mjs exist', async () => {
    writeFileSync(join(ctx.rootDir, 'plan.json'), JSON.stringify({
      phases: [{ id: 'phase-1', name: 'p1', order: 1 }],
      tasks: [],
      milestones: [],
    }, null, 2), 'utf8');
    // Minimal complete-design.mjs that just exits 0.
    writeFileSync(join(projectRoot, 'complete-design.mjs'), [
      '// stub for tests',
      'process.exit(0);',
    ].join('\n'), 'utf8');
    const result = await runCompleteDesignPostProcessor(ctx);
    expect(result.ran).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('returns exitCode != 0 (no throw) when the script fails', async () => {
    writeFileSync(join(ctx.rootDir, 'plan.json'), JSON.stringify({
      phases: [{ id: 'phase-1', name: 'p1', order: 1 }],
      tasks: [],
      milestones: [],
    }, null, 2), 'utf8');
    writeFileSync(join(projectRoot, 'complete-design.mjs'), [
      'console.error("[stub] intentional fail");',
      'process.exit(7);',
    ].join('\n'), 'utf8');
    const result = await runCompleteDesignPostProcessor(ctx);
    expect(result.ran).toBe(true);
    expect(result.exitCode).toBe(7);
  });

  it('respects ZELARI_COMPLETE_DESIGN=0 env var', async () => {
    writeFileSync(join(ctx.rootDir, 'plan.json'), JSON.stringify({
      phases: [{ id: 'phase-1', name: 'p1', order: 1 }],
      tasks: [],
      milestones: [],
    }, null, 2), 'utf8');
    writeFileSync(join(projectRoot, 'complete-design.mjs'), [
      'process.exit(0);',
    ].join('\n'), 'utf8');
    const old = process.env['ZELARI_COMPLETE_DESIGN'];
    process.env['ZELARI_COMPLETE_DESIGN'] = '0';
    try {
      const result = await runCompleteDesignPostProcessor(ctx);
      expect(result.ran).toBe(false);
      expect(result.reason).toContain('disabled');
    } finally {
      if (old === undefined) delete process.env['ZELARI_COMPLETE_DESIGN'];
      else process.env['ZELARI_COMPLETE_DESIGN'] = old;
    }
  });
});

// ── runPostCouncilHook integration ───────────────────────────────────────────

describe('runPostCouncilHook (Opzione B integration)', () => {
  it('invokes AGENTS.MD then complete-design (order: agents-md first)', async () => {
    // Both complete-design.mjs and the AGENTS.MD inputs are present.
    writeFileSync(join(ctx.rootDir, 'plan.json'), JSON.stringify({
      phases: [{ id: 'phase-1', name: 'p1', order: 1 }],
      tasks: [],
      milestones: [],
    }, null, 2), 'utf8');
    // complete-design.mjs records its invocation time.
    const stampPath = join(projectRoot, '.invocation-stamp.json');
    writeFileSync(join(projectRoot, 'complete-design.mjs'), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync("${stampPath}", JSON.stringify({ ran: true }));`,
      'process.exit(0);',
    ].join('\n'), 'utf8');
    // Minimal package.json so AGENTS.MD has content.
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'test',
      version: '0.1.0',
      dependencies: { react: '^19' },
      devDependencies: { vitest: '^2' },
      scripts: { test: 'vitest run', build: 'tsc' },
    }), 'utf8');
    const result = await runPostCouncilHook(ctx);
    expect(result.ran).toBe(true);
    // AGENTS.MD must exist.
    expect(existsSync(join(projectRoot, 'AGENTS.MD'))).toBe(true);
    // complete-design invocation stamp must exist (post-council ran).
    expect(existsSync(stampPath)).toBe(true);
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    expect(stamp.ran).toBe(true);
  });
});