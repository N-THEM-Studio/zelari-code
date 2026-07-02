/**
 * tests/unit/cli-workspace-toolRegistry.test.ts
 *
 * Regression test for the v3-W dogfood bug: workspace stubs received
 * `ToolContext` ({ cwd, audit, sessionId, signal }) instead of
 * `WorkspaceContext` ({ rootDir, storage }), causing all 9 stubs to
 * throw `Cannot read properties of undefined (reading 'storage')`.
 *
 * The adapter in `workspace/toolRegistry.ts` must merge a closed-over
 * `WorkspaceContext` with the runtime `ToolContext` so the stub sees
 * `ctx.storage`, `ctx.rootDir`, AND the runtime `audit`/cwd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorkspaceContext,
  createWorkspaceToolRegistry,
} from '../../src/cli/workspace/index.ts';

describe('workspace/toolRegistry — runtime ToolContext merging (v3-W)', () => {
  let projectRoot: string;
  let ctx: ReturnType<typeof createWorkspaceContext>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'zelari-tr-'));
    ctx = createWorkspaceContext(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('registry contains all 9 workspace stubs', () => {
    const registry = createWorkspaceToolRegistry(ctx);
    const tools = registry.list().sort();
    expect(tools).toEqual([
      'addIdea',
      'createDocument',
      'createMilestone',
      'createPhase',
      'createTask',
      'getDocumentBacklinks',
      'linkDocuments',
      'searchDocuments',
      'updateTask',
    ]);
  });

  it('createPhase writes through merged ctx.storage + ctx.rootDir (regression)', async () => {
    const registry = createWorkspaceToolRegistry(ctx);
    const createPhase = registry.get('createPhase');
    expect(createPhase).toBeDefined();
    const result = await registry.invoke(
      'createPhase',
      { name: 'Test phase', description: 'desc', order: 1 },
      { cwd: projectRoot, sessionId: 'test-session' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatch(/Phase "Test phase" created/);

    // Verify the files landed on disk via the closed-over workspace ctx.
    // v0.7.3: the machine-readable source of truth is plan.json (lossless
    // JSON round-trip); plan.md is the human-readable rendering only.
    const planJsonPath = join(projectRoot, '.zelari', 'plan.json');
    expect(existsSync(planJsonPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planJsonPath, 'utf-8'));
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].name).toBe('Test phase');
    const planMdPath = join(projectRoot, '.zelari', 'plan.md');
    expect(existsSync(planMdPath)).toBe(true);
    expect(readFileSync(planMdPath, 'utf-8')).toContain('test-phase');
  });

  it('addIdea persists ADR through closed-over workspace ctx', async () => {
    const registry = createWorkspaceToolRegistry(ctx);
    const result = await registry.invoke(
      'addIdea',
      {
        title: 'Test ADR',
        content: 'Body',
        consequences: ['one', 'two'],
      },
      { cwd: projectRoot, sessionId: 'test-session' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatch(/ADR 001-test-adr created/);

    const decisionsDir = join(projectRoot, '.zelari', 'decisions');
    expect(existsSync(decisionsDir)).toBe(true);
    const files = readdirSync(decisionsDir);
    expect(files.some((f) => f.endsWith('-test-adr.md'))).toBe(true);
  });

  it('createMilestone writes to .zelari/milestones/ (regression)', async () => {
    const registry = createWorkspaceToolRegistry(ctx);
    const result = await registry.invoke(
      'createMilestone',
      { title: 'v3.1', dueDate: '2026-08-01' },
      { cwd: projectRoot, sessionId: 's' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const milestonesDir = join(projectRoot, '.zelari', 'milestones');
    expect(existsSync(milestonesDir)).toBe(true);
  });

  it('partial InvokeOptions (no sessionId) does not crash the stub', async () => {
    // Adversarial: pass only cwd. The adapter should still wire
    // storage + rootDir from the closed-over ctx.
    const registry = createWorkspaceToolRegistry(ctx);
    const result = await registry.invoke(
      'createPhase',
      { name: 'Robust phase', order: 2 },
      { cwd: projectRoot },
    );
    expect(result.ok).toBe(true);
  });
});