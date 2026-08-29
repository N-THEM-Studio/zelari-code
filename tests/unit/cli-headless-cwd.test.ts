/**
 * cli-headless-cwd.test.ts — tripwire for the 2.16.0 Desktop sidecar leak:
 * session.create's workspaceRoot must become HeadlessOptions.cwd, and
 * resolveHeadlessCwd must NOT fall back to process.cwd() when a workspace
 * is supplied. A failing test here means the agent is searching the
 * installer directory instead of the Open Folder project.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { resolveHeadlessCwd } from '../../src/cli/headless.js';
import { bindHarnessTurnOptions } from '../../src/cli/serve/harnessServer.js';
import { resolveSessionsDir } from '@zelari/core/session';

describe('resolveHeadlessCwd', () => {
  it('falls back to process.cwd() when cwd is omitted or blank', () => {
    const here = path.resolve(process.cwd());
    expect(resolveHeadlessCwd({})).toBe(here);
    expect(resolveHeadlessCwd({ cwd: '' })).toBe(here);
    expect(resolveHeadlessCwd({ cwd: '   ' })).toBe(here);
  });

  it('resolves an explicit workspace even when it differs from process.cwd()', () => {
    const other = path.join(os.tmpdir(), 'zelari-cwd-other');
    const resolved = resolveHeadlessCwd({ cwd: other });
    expect(resolved).toBe(path.resolve(other));
    expect(resolved).not.toBe(path.resolve(process.cwd()));
  });
});

describe('bindHarnessTurnOptions', () => {
  it('pins session workspaceRoot as opts.cwd (never process.cwd())', () => {
    const root = path.join(os.tmpdir(), 'zelari-proj');
    const opts = bindHarnessTurnOptions({ task: 'list files', mode: 'kraken' }, root);
    expect(opts.cwd).toBe(root);
    expect(opts.task).toBe('list files');
    expect(opts.mode).toBe('kraken');
    expect(opts.output).toBe('json');
    expect(opts.cwd).not.toBe(process.cwd());
  });

  it('overwrites a hostile input.cwd with the session workspaceRoot', () => {
    const root = path.join(os.tmpdir(), 'zelari-session-root');
    const opts = bindHarnessTurnOptions(
      { task: 'x', mode: 'kraken', cwd: 'C:\\Windows' },
      root,
    );
    expect(opts.cwd).toBe(root);
  });

  it('throws when task is missing', () => {
    expect(() => bindHarnessTurnOptions({ mode: 'kraken' }, path.join(os.tmpdir(), 'x'))).toThrow(
      /task/,
    );
  });

  it('aliases Desktop mode "agent" to kraken so tentacle playbooks load', () => {
    const root = path.join(os.tmpdir(), 'zelari-agent-mode');
    const opts = bindHarnessTurnOptions({ task: 'explore the repo', mode: 'agent' }, root);
    expect(opts.mode).toBe('kraken');
  });
});

describe('session dir follows workspaceRoot (not process.cwd())', () => {
  it('places the spine under the session workspace', () => {
    const root = path.join(os.tmpdir(), 'zelari-session-ws');
    const dir = resolveSessionsDir({ workspaceRoot: root });
    expect(dir).toBe(path.join(root, '.zelari', 'sessions'));
    expect(dir).not.toContain(path.join(process.cwd(), '.zelari', 'sessions'));
  });
});
