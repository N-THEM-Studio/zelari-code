/**
 * cli-workspace-stubs.test.ts — Tests for the 9 council workspace stubs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceContext, createWorkspaceStubs } from '../../src/cli/workspace/stubs.js';

let tmpDir: string;
let ctx: ReturnType<typeof createWorkspaceContext>;
let stubs: ReturnType<typeof createWorkspaceStubs>;

beforeEach(() => {
  // Use tmpDir as the "project root" so .zelari/ goes there.
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-stubs-'));
  ctx = createWorkspaceContext(tmpDir);
  stubs = createWorkspaceStubs(ctx);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const findStub = (name: string) => {
  const s = stubs.find((t) => t.name === name);
  if (!s) throw new Error(`Stub ${name} not found`);
  return s;
};

describe('createPhase stub', () => {
  it('creates a phase in plan.md', async () => {
    const stub = findStub('createPhase');
    const result = await stub.execute({ name: 'Discovery', description: 'Research phase', order: 1 }, ctx);
    expect(result).toContain('Phase "Discovery" created');
    expect(existsSync(join(ctx.rootDir, 'plan.md'))).toBe(true);
    const content = readFileSync(join(ctx.rootDir, 'plan.md'), 'utf8');
    expect(content).toContain('discovery');
  });

  it('rejects duplicate phase', async () => {
    const stub = findStub('createPhase');
    await stub.execute({ name: 'Discovery', order: 1 }, ctx);
    const result = await stub.execute({ name: 'Discovery', order: 2 }, ctx);
    expect(result).toContain('already exists');
  });
});

describe('createTask stub', () => {
  it('creates a task within a phase', async () => {
    const createPhase = findStub('createPhase');
    const createTask = findStub('createTask');
    await createPhase.execute({ name: 'Discovery', order: 1 }, ctx);
    const result = await createTask.execute({
      phaseId: 'discovery',
      title: 'Read codebase',
      description: 'Understand the existing code',
      fileRefs: ['src/index.ts'],
      acceptance: ['All files mapped'],
      qaScenario: 'Run ls -R and confirm output',
    }, ctx);
    expect(result).toContain('Task "Read codebase" created');
    expect(existsSync(join(ctx.rootDir, 'plan-tasks'))).toBe(true);
  });

  it('rejects task for non-existent phase', async () => {
    const createTask = findStub('createTask');
    const result = await createTask.execute({ phaseId: 'nope', title: 'X' }, ctx);
    expect(result).toContain('not found');
  });
});

describe('updateTask stub', () => {
  it('transitions task status', async () => {
    const createPhase = findStub('createPhase');
    const createTask = findStub('createTask');
    const updateTask = findStub('updateTask');
    await createPhase.execute({ name: 'P1', order: 1 }, ctx);
    const taskResult = await createTask.execute({ phaseId: 'p1', title: 'T1' }, ctx);
    const taskId = taskResult.match(/id: ([\w-]+)/)?.[1];
    expect(taskId).toBeTruthy();
    const updateResult = await updateTask.execute({ taskId, status: 'in_progress' }, ctx);
    expect(updateResult).toContain('updated to status="in_progress"');
  });

  it('rejects invalid status', async () => {
    const updateTask = findStub('updateTask');
    const result = await updateTask.execute({ taskId: 'x', status: 'invalid' }, ctx);
    expect(result).toContain('Invalid status');
  });
});

describe('addIdea stub', () => {
  it('creates a numbered ADR', async () => {
    const stub = findStub('addIdea');
    await stub.execute({
      title: 'Use JWT rotation',
      context: 'We need to decide on auth token strategy',
      decision: 'Use short-lived JWTs with refresh token rotation',
      consequences: ['Better security', 'More complex refresh logic'],
      tags: ['auth', 'security'],
    }, ctx);
    expect(existsSync(join(ctx.rootDir, 'decisions', '001-use-jwt-rotation.md'))).toBe(true);
    const content = readFileSync(join(ctx.rootDir, 'decisions', '001-use-jwt-rotation.md'), 'utf8');
    expect(content).toContain('Use JWT rotation');
    expect(content).toContain('refresh token rotation');
  });

  it('numbers ADRs sequentially', async () => {
    const stub = findStub('addIdea');
    await stub.execute({ title: 'First' }, ctx);
    await stub.execute({ title: 'Second' }, ctx);
    await stub.execute({ title: 'Third' }, ctx);
    expect(existsSync(join(ctx.rootDir, 'decisions', '001-first.md'))).toBe(true);
    expect(existsSync(join(ctx.rootDir, 'decisions', '002-second.md'))).toBe(true);
    expect(existsSync(join(ctx.rootDir, 'decisions', '003-third.md'))).toBe(true);
  });
});

describe('createMilestone stub', () => {
  it('creates a milestone', async () => {
    const stub = findStub('createMilestone');
    const result = await stub.execute({
      title: 'MVP',
      description: 'First shippable version',
      targetVersion: 'v0.1.0',
    }, ctx);
    expect(result).toContain('Milestone "MVP" created');
    expect(existsSync(join(ctx.rootDir, 'milestones', 'm-mvp.md'))).toBe(true);
  });
});

describe('createDocument stub', () => {
  it('creates a doc', async () => {
    const stub = findStub('createDocument');
    const result = await stub.execute({
      title: 'API Spec',
      content: '# API\n\nEndpoints...',
      tags: ['api'],
    }, ctx);
    expect(result).toContain('Document "API Spec" created');
    expect(existsSync(join(ctx.rootDir, 'docs', 'api-spec.md'))).toBe(true);
  });
});

describe('searchDocuments stub', () => {
  it('finds matches across workspace files', async () => {
    const addIdea = findStub('addIdea');
    await addIdea.execute({
      title: 'JWT Strategy',
      context: 'Using JWT tokens for auth',
    }, ctx);
    const search = findStub('searchDocuments');
    const result = await search.execute({ query: 'jwt' }, ctx);
    expect(result.toLowerCase()).toContain('jwt');
    expect(result).toContain('.md');
  });

  it('returns helpful message on no matches', async () => {
    const search = findStub('searchDocuments');
    const result = await search.execute({ query: 'nonexistent-zzz' }, ctx);
    expect(result).toContain('No matches');
  });

  it('requires a query', async () => {
    const search = findStub('searchDocuments');
    const result = await search.execute({}, ctx);
    expect(result).toContain('requires a query');
  });
});

describe('linkDocuments + getDocumentBacklinks', () => {
  it('links two ADRs and resolves backlinks', async () => {
    const addIdea = findStub('addIdea');
    const link = findStub('linkDocuments');
    const backlinks = findStub('getDocumentBacklinks');

    await addIdea.execute({ title: 'First Decision' }, ctx);
    await addIdea.execute({ title: 'Second Decision' }, ctx);

    const linkResult = await link.execute({ fromId: '001-first-decision', toId: '002-second-decision' }, ctx);
    expect(linkResult).toContain('Linked');

    const backResult = await backlinks.execute({ targetId: '002-second-decision' }, ctx);
    expect(backResult).toContain('001-first-decision');
  });

  it('returns empty when no backlinks exist', async () => {
    const addIdea = findStub('addIdea');
    const backlinks = findStub('getDocumentBacklinks');
    await addIdea.execute({ title: 'Lonely' }, ctx);
    const result = await backlinks.execute({ targetId: '001-lonely' }, ctx);
    expect(result).toContain('No backlinks');
  });
});

describe('context factory', () => {
  it('creates a context with .zelari/ root', () => {
    const ctx2 = createWorkspaceContext(tmpDir);
    expect(ctx2.rootDir).toContain('.zelari');
    expect(ctx2.projectRoot).toBe(tmpDir);
  });
});

// ── v0.7.3 live-test regressions ─────────────────────────────────────

describe('plan round-trip with free text (v0.7.3 — plan.json source of truth)', () => {
  it('createTask finds a phase whose name/description contain colons, commas, apostrophes', async () => {
    // Live-test failure: 'Phase "…" not found. Create it first' immediately
    // after createPhase reported success — the YAML flow-map round-trip of
    // plan.md corrupted on punctuation-heavy free text.
    const createPhase = findStub('createPhase');
    const createTask = findStub('createTask');
    const result = await createPhase.execute({
      name: 'Phase 1: E-commerce MVP - Product List + Cart + Basic UI',
      description: "Replace the default page. Update index.html, don't touch node_modules: {it's big}, [really].",
      order: 1,
    }, ctx);
    expect(result).toContain('created');
    const id = result.match(/id: ([\w-]+)/)?.[1];
    expect(id).toBeTruthy();
    const taskResult = await createTask.execute({ phaseId: id, title: 'Setup entry points' }, ctx);
    expect(taskResult).toContain('Task "Setup entry points" created');
  });

  it('persists the plan as plan.json and keeps plan.md as human-readable rendering', async () => {
    const createPhase = findStub('createPhase');
    await createPhase.execute({ name: 'Discovery', order: 1 }, ctx);
    expect(existsSync(join(ctx.rootDir, 'plan.json'))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(ctx.rootDir, 'plan.json'), 'utf8'));
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0].id).toBe('discovery');
    // plan.md still exists for humans but carries no machine-parsed arrays.
    const md = readFileSync(join(ctx.rootDir, 'plan.md'), 'utf8');
    expect(md).toContain('discovery');
    expect(md).not.toContain('phases: [{');
  });
});

describe('searchDocuments OR queries (v0.7.3)', () => {
  it('matches any OR-phrase instead of the literal full string', async () => {
    // Live-test failure: every `x OR y OR z` query returned "No matches",
    // even for documents created seconds earlier.
    const addIdea = findStub('addIdea');
    await addIdea.execute({ title: 'JWT Strategy', context: 'Using JWT tokens for auth' }, ctx);
    const search = findStub('searchDocuments');
    const result = await search.execute({ query: 'nonexistent-zzz OR jwt OR whatever' }, ctx);
    expect(result.toLowerCase()).toContain('jwt');
    expect(result).not.toContain('No matches');
  });

  it('falls back to any-word matching for multi-word queries', async () => {
    const addIdea = findStub('addIdea');
    await addIdea.execute({ title: 'Cart Drawer', context: 'Slide-in cart with quantity controls' }, ctx);
    const search = findStub('searchDocuments');
    const result = await search.execute({ query: 'ecommerce cart implementation' }, ctx);
    expect(result.toLowerCase()).toContain('cart');
  });

  it('searches plan-tasks and milestones directories too', async () => {
    const createPhase = findStub('createPhase');
    const createTask = findStub('createTask');
    await createPhase.execute({ name: 'P1', order: 1 }, ctx);
    await createTask.execute({ phaseId: 'p1', title: 'Wire the ProductGrid component' }, ctx);
    const search = findStub('searchDocuments');
    const result = await search.execute({ query: 'productgrid' }, ctx);
    expect(result.toLowerCase()).toContain('productgrid');
  });
});

describe('updateTask status aliases (v0.7.3)', () => {
  it('maps "todo" → pending and "completed" → done', async () => {
    const createPhase = findStub('createPhase');
    const createTask = findStub('createTask');
    const updateTask = findStub('updateTask');
    await createPhase.execute({ name: 'P1', order: 1 }, ctx);
    const taskResult = await createTask.execute({ phaseId: 'p1', title: 'T1' }, ctx);
    const taskId = taskResult.match(/id: ([\w-]+)/)?.[1];
    const todo = await updateTask.execute({ taskId, status: 'todo' }, ctx);
    expect(todo).toContain('status="pending"');
    const completed = await updateTask.execute({ taskId, status: 'completed' }, ctx);
    expect(completed).toContain('status="done"');
  });
});