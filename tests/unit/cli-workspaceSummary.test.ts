/**
 * cli-workspaceSummary.test.ts — v0.7.2 buildWorkspaceSummary coverage.
 *
 * The council receives this string as `workspaceContext`. Before v0.7.2 it was
 * always empty (the council had no idea which project it was operating on).
 * These tests pin the contract: cwd, project name, tech stack, scripts, and a
 * shallow file listing are present.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkspaceSummary } from '../../src/cli/workspace/workspaceSummary.js';

describe('buildWorkspaceSummary (v0.7.2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-summary-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes the working directory and project name', () => {
    const summary = buildWorkspaceSummary(dir);
    expect(summary).toContain(`Working directory: ${dir}`);
    expect(summary).toMatch(/# Project: /);
  });

  it('includes the tech stack from package.json when present', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo-shop',
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
        devDependencies: { typescript: '^5.7.0' },
      }),
    );
    const summary = buildWorkspaceSummary(dir);
    expect(summary).toContain('react');
    expect(summary).toContain('typescript');
    expect(summary).toMatch(/## Tech stack/);
  });

  it('omits the tech stack section when no package.json', () => {
    const summary = buildWorkspaceSummary(dir);
    expect(summary).not.toMatch(/## Tech stack/);
  });

  it('includes npm scripts when present', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite', build: 'tsc && vite build' } }),
    );
    const summary = buildWorkspaceSummary(dir);
    expect(summary).toMatch(/## npm scripts/);
    expect(summary).toContain('`dev`: vite');
    expect(summary).toContain('`build`: tsc && vite build');
  });

  it('lists top-level files and directories (depth 2 peek into subdirs)', () => {
    writeFileSync(join(dir, 'README.md'), '# hi');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'App.tsx'), 'export const App = () => null');
    writeFileSync(join(dir, 'src', 'main.tsx'), '');
    const summary = buildWorkspaceSummary(dir);
    expect(summary).toMatch(/## Top-level/);
    expect(summary).toContain('README.md');
    expect(summary).toContain('src/');
    // The src/ peek lists some of its files.
    expect(summary).toMatch(/src\/.*App\.tsx/);
  });

  it('hides dotfiles, node_modules, and dist from the listing', () => {
    writeFileSync(join(dir, '.hidden'), 'x');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'pkg.json'), '{}');
    const summary = buildWorkspaceSummary(dir);
    expect(summary).not.toContain('.hidden');
    expect(summary).not.toContain('node_modules');
  });
});
