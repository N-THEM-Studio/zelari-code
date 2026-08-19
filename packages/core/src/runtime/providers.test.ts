import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  LocalWorkspace,
  WorkspacePathEscapeError,
  NOOP_SUBAGENT_PROVIDER,
} from './providers.js';
import { MemoryFsProvider, MemoryShellProvider } from './memoryProviders.js';
import { NodeFsProvider, NodeShellProvider } from './nodeProviders.js';

describe('LocalWorkspace (path jail)', () => {
  it('resolves inside the root and rejects escapes', () => {
    const ws = new LocalWorkspace(path.resolve('/repo'));
    expect(ws.resolve('src/a.ts')).toBe(path.resolve('/repo/src/a.ts'));
    expect(ws.resolve('.')).toBe(path.resolve('/repo'));
    expect(() => ws.resolve('../outside.txt')).toThrow(WorkspacePathEscapeError);
    expect(() => ws.resolve('..\\outside.txt')).toThrow(WorkspacePathEscapeError);
  });

  it('treats backslash as a separator on every OS (no POSIX smuggle)', () => {
    const ws = new LocalWorkspace(path.resolve('/repo'));
    expect(ws.resolve('src\\a.ts')).toBe(path.resolve('/repo/src/a.ts'));
    expect(() => ws.resolve('..\\..\\etc\\passwd')).toThrow(WorkspacePathEscapeError);
    expect(() => ws.resolve('..\\outside.txt')).toThrow(WorkspacePathEscapeError);
    expect(() => ws.resolve('sub\\..\\..\\escape.txt')).toThrow(WorkspacePathEscapeError);
  });
});

describe('MemoryFsProvider / MemoryShellProvider', () => {
  it('round-trips files and lists them', async () => {
    const fs = new MemoryFsProvider({ 'a.txt': 'A', 'sub/b.txt': 'B' });
    await fs.writeFile('c.txt', 'C');
    expect(await fs.readFile('a.txt')).toBe('A');
    expect(await fs.exists('nope.txt')).toBe(false);
    expect(await fs.list()).toEqual(['a.txt', 'c.txt', 'sub/b.txt']);
    expect(await fs.list('sub')).toEqual(['sub/b.txt']);
  });

  it('first matching handler wins; unmatched commands exit 127', async () => {
    const shell = new MemoryShellProvider([
      { match: 'npm test', result: { exitCode: 0, stdout: '3 passed' } },
      { match: 'npm run build', result: { exitCode: 1, stderr: 'build failed' } },
    ]);
    expect((await shell.exec('npm test')).stdout).toBe('3 passed');
    expect((await shell.exec('npm run build')).exitCode).toBe(1);
    expect((await shell.exec('unknown')).exitCode).toBe(127);
  });
});

describe('Node providers (real fs/shell, jailed)', () => {
  it('fs provider writes and reads inside a temp workspace', async () => {
    const ws = new LocalWorkspace(process.cwd());
    const fs = new NodeFsProvider(ws);
    const rel = `.zelari/tmp/node-provider-test-${Date.now()}.txt`;
    await fs.writeFile(rel, 'payload');
    expect(await fs.readFile(rel)).toBe('payload');
    expect(await fs.exists(rel)).toBe(true);
  });

  it('shell provider runs a command and captures exit code + output', async () => {
    const ws = new LocalWorkspace(process.cwd());
    const shell = new NodeShellProvider(ws);
    const result = await shell.exec(
      process.platform === 'win32' ? 'echo hello-zielari' : 'echo hello-zielari',
      { timeoutMs: 15_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello-zielari');
    expect(result.timedOut).toBe(false);
  });

  it('shell provider enforces the timeout', async () => {
    const ws = new LocalWorkspace(process.cwd());
    const shell = new NodeShellProvider(ws);
    const result = await shell.exec(
      process.platform === 'win32' ? 'ping -n 10 127.0.0.1 >nul' : 'sleep 5',
      { timeoutMs: 500 },
    );
    expect(result.timedOut).toBe(true);
  });

  it('timeout kills the whole POSIX process group, not just the shell', async () => {
    if (process.platform === 'win32') return; // covered by taskkill path
    const ws = new LocalWorkspace(process.cwd());
    const shell = new NodeShellProvider(ws);
    const result = await shell.exec('sleep 30', { timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
    // Give the SIGKILL a moment to land, then prove no `sleep 30` survives.
    await new Promise((r) => setTimeout(r, 300));
    const ps = await shell.exec("ps -eo pid=,args= | grep '[s]leep 30' | wc -l", { timeoutMs: 5_000 });
    expect(ps.stdout.trim()).toBe('0');
  });
});

describe('NoopSubagentProvider', () => {
  it('is honestly unavailable', async () => {
    expect(NOOP_SUBAGENT_PROVIDER.available).toBe(false);
    const result = await NOOP_SUBAGENT_PROVIDER.runTask({ goal: 'x' });
    expect(result.ok).toBe(false);
  });
});
