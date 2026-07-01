/**
 * cli-workspace-agents-md.test.ts — Tests for AGENTS.MD auto-maintenance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgentsMd,
  serializeAgentsMd,
  updateAgentsMd,
  AUTO_SECTIONS,
} from '../../src/cli/workspace/agentsMd.js';
import { createWorkspaceContext } from '../../src/cli/workspace/stubs.js';
import { runPostCouncilHook } from '../../src/cli/workspace/postCouncilHook.js';

let tmpDir: string;
let ctx: ReturnType<typeof createWorkspaceContext>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-agents-'));
  // Minimal package.json so tech-stack + build sections have content.
  writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
    name: 'test-project',
    version: '0.1.0',
    dependencies: { react: '^19.0.0' },
    devDependencies: { vitest: '^2.0.0' },
    scripts: { test: 'vitest run', build: 'tsc' },
  }, null, 2));
  ctx = createWorkspaceContext(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseAgentsMd / serializeAgentsMd', () => {
  it('parses a file with all sections', () => {
    const content = [
      '# Project',
      '',
      '## Overview',
      'Manual text.',
      '',
      '## Tech Stack',
      '<!-- zelari:auto:start section="tech-stack" -->',
      '- react ^19',
      '<!-- zelari:auto:end section="tech-stack" -->',
      '',
      '## Decisions',
      '<!-- zelari:auto:start section="decisions" -->',
      '- **001-foo**',
      '<!-- zelari:auto:end section="decisions" -->',
      '',
    ].join('\n');
    const parsed = parseAgentsMd(content);
    expect(parsed.sections.size).toBe(2);
    expect(parsed.sections.get('tech-stack')?.content).toContain('- react ^19');
    expect(parsed.sections.get('decisions')?.content).toContain('- **001-foo**');
    expect(parsed.manualBlocks.after).toContain('Manual text.');
    expect(parsed.manualBlocks.after).toContain('# Project');
  });

  it('returns empty sections for empty content', () => {
    const parsed = parseAgentsMd('# Just a title\n\nNo markers.');
    expect(parsed.sections.size).toBe(0);
  });

  it('serializes sections with markers', () => {
    const manual = '# Project\n\n## Overview\n\nManual.';
    const sections = new Map([
      ['tech-stack', '- react ^19'],
    ]);
    const out = serializeAgentsMd(manual, sections);
    expect(out).toContain('<!-- zelari:auto:start section="tech-stack" -->');
    expect(out).toContain('- react ^19');
    expect(out).toContain('<!-- zelari:auto:end section="tech-stack" -->');
  });
});

describe('updateAgentsMd', () => {
  it('creates AGENTS.MD from scratch on first run', async () => {
    const result = await updateAgentsMd(ctx, tmpDir);
    expect(result.changed).toBe(true);
    expect(existsSync(join(tmpDir, 'AGENTS.MD'))).toBe(true);
    const content = readFileSync(join(tmpDir, 'AGENTS.MD'), 'utf8');
    expect(content).toContain('# AGENTS.MD');
    expect(content).toContain('## Tech Stack');
    expect(content).toContain('## Build');
  });

  it('is idempotent — second run with no changes returns changed=false', async () => {
    await updateAgentsMd(ctx, tmpDir);
    const result = await updateAgentsMd(ctx, tmpDir);
    expect(result.changed).toBe(false);
    expect(result.sections).toEqual([]);
  });

  it('updates only changed sections', async () => {
    // First run: creates AGENTS.MD with all sections.
    await updateAgentsMd(ctx, tmpDir);
    // Add a new ADR
    ctx.storage.write(join(ctx.rootDir, 'decisions', '001-jwt.md'),
      { kind: 'adr', id: '001-jwt', status: 'accepted', date: '2026-07-01' },
      '# 001-jwt\n\nUse JWT.');
    // Second run: only 'decisions' section should change.
    const result = await updateAgentsMd(ctx, tmpDir);
    expect(result.changed).toBe(true);
    expect(result.sections).toContain('decisions');
    expect(result.sections).not.toContain('tech-stack');
  });

  it('preserves manual sections across updates', async () => {
    await updateAgentsMd(ctx, tmpDir);
    // User manually edits AGENTS.MD to add a manual section.
    let content = readFileSync(join(tmpDir, 'AGENTS.MD'), 'utf8');
    content = content.replace(
      '## Overview',
      '## Overview\n\nThis is the project for testing AGENTS.MD.',
    );
    writeFileSync(join(tmpDir, 'AGENTS.MD'), content, 'utf8');
    // Run update again.
    await updateAgentsMd(ctx, tmpDir);
    const after = readFileSync(join(tmpDir, 'AGENTS.MD'), 'utf8');
    expect(after).toContain('This is the project for testing AGENTS.MD');
  });

  it('treats files without markers as manual (fail-safe)', async () => {
    // Create AGENTS.MD with NO markers.
    writeFileSync(join(tmpDir, 'AGENTS.MD'), '# Manual Project\n\nNo markers here.\n', 'utf8');
    const result = await updateAgentsMd(ctx, tmpDir);
    expect(result.changed).toBe(false);
    expect(result.reason).toContain('manual');
    // File should be unchanged.
    const content = readFileSync(join(tmpDir, 'AGENTS.MD'), 'utf8');
    expect(content).not.toContain('zelari:auto');
  });
});

describe('runPostCouncilHook', () => {
  it('runs the hook and returns result', async () => {
    const result = await runPostCouncilHook(ctx);
    expect(result.ran).toBe(true);
    expect(result.changed).toBe(true);
  });

  it('respects ZELARI_AGENTS_MD=0', async () => {
    const old = process.env['ZELARI_AGENTS_MD'];
    process.env['ZELARI_AGENTS_MD'] = '0';
    try {
      const result = await runPostCouncilHook(ctx);
      expect(result.ran).toBe(false);
      expect(result.reason).toContain('disabled');
    } finally {
      if (old === undefined) delete process.env['ZELARI_AGENTS_MD'];
      else process.env['ZELARI_AGENTS_MD'] = old;
    }
  });
});

describe('AUTO_SECTIONS', () => {
  it('includes all 5 expected sections', () => {
    expect(AUTO_SECTIONS).toEqual([
      'tech-stack',
      'decisions',
      'conventions',
      'build',
      'open-questions',
    ]);
  });
});