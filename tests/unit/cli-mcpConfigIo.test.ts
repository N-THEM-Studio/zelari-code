/**
 * cli-mcpConfigIo.test.ts — mcp.json read/write contract shared by Desktop & CLI.
 *
 * The Claude-compatible record is `{command, args, env, enabled, …}`. What this
 * suite pins down:
 *   - env survives a round-trip (user and project scope) and is never invented;
 *   - a record WITHOUT env stays valid (back-compat) and an upsert that carries
 *     no env — the Desktop toggle path, `--set-mcp` without `--env` — keeps the
 *     env already on disk instead of wiping it;
 *   - an explicit env always wins, including `{}` which clears it;
 *   - the guards that produce CLI/Desktop errors stay: name charset, command-or-url,
 *     projectRoot required for the project scope, unknown name on remove.
 *
 * ZELARI_HOME is sandboxed to a temp dir so nothing touches the real
 * ~/.zelari-code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getProjectMcpPath,
  listMcpServers,
  parseMcpEnvFlag,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from '../../src/cli/mcp/mcpConfigIo.js';

let home = '';
let project = '';
const previousHome = process.env.ZELARI_HOME;

/** Pre-seed the user file exactly as a hand-edited mcp.json would look. */
function writeUserJson(text: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'mcp.json'), text, 'utf8');
}

function projectJson(): { mcpServers?: Record<string, { env?: Record<string, string>; command?: string }> } {
  return JSON.parse(readFileSync(getProjectMcpPath(project), 'utf8')) as {
    mcpServers?: Record<string, { env?: Record<string, string>; command?: string }>;
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'zelari-mcp-home-'));
  project = mkdtempSync(join(tmpdir(), 'zelari-mcp-project-'));
  process.env.ZELARI_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ZELARI_HOME;
  else process.env.ZELARI_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('mcpConfigIo — env round-trip', () => {
  it('persists env and lists it back on both scopes', () => {
    expect(
      upsertMcpServer({
        scope: 'user',
        name: 'gh',
        config: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' },
        },
      }).ok,
    ).toBe(true);
    expect(
      upsertMcpServer({
        scope: 'project',
        name: 'local-db',
        projectRoot: project,
        config: { command: 'node', args: ['db.js'], env: { DB_URL: 'file:db' } },
      }).ok,
    ).toBe(true);

    const snap = listMcpServers(project);
    const user = snap.servers.find((s) => s.name === 'gh');
    const local = snap.servers.find((s) => s.name === 'local-db');
    expect(user?.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' });
    expect(user?.scope).toBe('user');
    expect(local?.env).toEqual({ DB_URL: 'file:db' });
    expect(local?.scope).toBe('project');
    // Read-back from disk, not from the in-memory call.
    expect(projectJson().mcpServers?.['local-db']?.env).toEqual({
      DB_URL: 'file:db',
    });
  });

  it('keeps an entry valid when no env is provided (back-compat)', () => {
    upsertMcpServer({
      scope: 'project',
      name: 'plain',
      projectRoot: project,
      config: { command: 'node', args: ['plain.js'] },
    });
    const entry = listMcpServers(project).servers.find((s) => s.name === 'plain');
    expect(entry?.command).toBe('node');
    expect(entry?.args).toEqual(['plain.js']);
    expect(entry?.env).toBeUndefined();
    expect(entry?.enabled).toBe(true);
  });

  it('does not wipe a stored env when the update carries none (Desktop toggle)', () => {
    upsertMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
      config: { command: 'npx', env: { TOKEN: 'abc' } },
    });

    // Same payload the Desktop ships when flipping the switch / `--set-mcp`
    // without `--env`: no env field at all.
    upsertMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
      config: { command: 'npx', args: ['-y', 'pkg'], enabled: false },
    });

    const entry = listMcpServers(project).servers.find((s) => s.name === 'gh');
    expect(entry?.env).toEqual({ TOKEN: 'abc' });
    expect(entry?.enabled).toBe(false);

    // setMcpServerEnabled spreads the record, so env must survive it too.
    setMcpServerEnabled({
      scope: 'project',
      name: 'gh',
      enabled: true,
      projectRoot: project,
    });
    const flipped = listMcpServers(project).servers.find((s) => s.name === 'gh');
    expect(flipped?.env).toEqual({ TOKEN: 'abc' });

    // An explicit env wins — `{}` clears it on purpose.
    upsertMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
      config: { command: 'npx', env: {} },
    });
    expect(
      listMcpServers(project).servers.find((s) => s.name === 'gh')?.env,
    ).toEqual({});
  });

  it('reads a hand-written record and drops the broken ones', () => {
    writeUserJson(
      JSON.stringify({
        mcpServers: {
          good: { command: 'node', args: ['x.js'], env: { A: '1' }, enabled: false },
          noCommandNoUrl: { args: ['x.js'] },
          http: { url: 'https://example.test/mcp' },
        },
      }),
    );
    const names = listMcpServers().servers.map((s) => s.name);
    expect(names).toEqual(['good', 'http']);
    const good = listMcpServers().servers.find((s) => s.name === 'good');
    expect(good?.env).toEqual({ A: '1' });
    expect(good?.enabled).toBe(false);
  });
});

describe('mcpConfigIo — guards', () => {
  it('rejects an invalid name and a config without command or url', () => {
    expect(
      upsertMcpServer({
        scope: 'user',
        name: 'bad name',
        config: { command: 'node' },
      }),
    ).toEqual({ ok: false, error: 'Invalid server name (use letters, digits, _ -)' });
    expect(
      upsertMcpServer({ scope: 'user', name: 'ok-name', config: {} }),
    ).toEqual({
      ok: false,
      error: 'either command (stdio) or url (http) is required',
    });
  });

  it('requires a project root for the project scope', () => {
    expect(
      upsertMcpServer({
        scope: 'project',
        name: 'gh',
        config: { command: 'node' },
      }),
    ).toEqual({
      ok: false,
      error: 'projectRoot required for project scope (Open Folder first)',
    });
  });

  it('removes an existing entry and reports an unknown name', () => {
    upsertMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
      config: { command: 'node' },
    });
    expect(
      removeMcpServer({ scope: 'project', name: 'gh', projectRoot: project }).ok,
    ).toBe(true);
    expect(listMcpServers(project).servers).toHaveLength(0);
    const missing = removeMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
    });
    expect(missing.ok).toBe(false);
  });
});

describe('mcpConfigIo — `--env` parsing for --set-mcp', () => {
  it('parses a JSON object (the Desktop bridge payload)', () => {
    expect(parseMcpEnvFlag(['{"TOKEN":"abc","MODE":"dev"}'])).toEqual({
      TOKEN: 'abc',
      MODE: 'dev',
    });
    // `{}` is a real intent ("clear the env"), not "no env channel".
    expect(parseMcpEnvFlag(['{}'])).toEqual({});
  });

  it('parses repeated KEY=VALUE pairs, the later one winning', () => {
    expect(parseMcpEnvFlag(['TOKEN=abc', 'MODE=dev=1'])).toEqual({
      TOKEN: 'abc',
      MODE: 'dev=1',
    });
    expect(parseMcpEnvFlag(['TOKEN=abc', 'TOKEN=xyz'])).toEqual({
      TOKEN: 'xyz',
    });
  });

  it('is undefined when absent, so an upsert keeps the stored env', () => {
    expect(parseMcpEnvFlag([])).toBeUndefined();

    // Exactly what the `--set-mcp` block hands upsertMcpServer with no --env:
    upsertMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
      config: { command: 'npx', env: { TOKEN: 'abc' } },
    });
    upsertMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
      config: { command: 'npx', enabled: false, env: parseMcpEnvFlag([]) },
    });
    expect(
      listMcpServers(project).servers.find((s) => s.name === 'gh')?.env,
    ).toEqual({ TOKEN: 'abc' });

    // …while an explicit `--env '{}'` does erase it.
    upsertMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
      config: { command: 'npx', env: parseMcpEnvFlag(['{}']) },
    });
    expect(
      listMcpServers(project).servers.find((s) => s.name === 'gh')?.env,
    ).toEqual({});
  });

  it('persists the parsed env on disk', () => {
    const env = parseMcpEnvFlag(['{"GITHUB_TOKEN":"tok"}', 'MODE=dev']);
    upsertMcpServer({
      scope: 'project',
      name: 'gh',
      projectRoot: project,
      config: { command: 'npx', env },
    });
    expect(projectJson().mcpServers?.['gh']?.env).toEqual({
      GITHUB_TOKEN: 'tok',
      MODE: 'dev',
    });
  });

  it('throws a clean message on malformed input (CLI exits 1)', () => {
    expect(() => parseMcpEnvFlag(['{not json}'])).toThrow(/not valid JSON/);
    expect(() => parseMcpEnvFlag(['["A"]'])).toThrow(/must be an object/);
    expect(() => parseMcpEnvFlag(['{"A":1}'])).toThrow(/must map to a string/);
    expect(() => parseMcpEnvFlag(['{"A B":"1"}'])).toThrow(/Invalid env key/);
    expect(() => parseMcpEnvFlag(['TOKEN'])).toThrow(/use KEY=VALUE/);
    expect(() => parseMcpEnvFlag(['=abc'])).toThrow(/use KEY=VALUE/);
    expect(() => parseMcpEnvFlag(['1BAD=abc'])).toThrow(/Invalid env key/);
  });
});
