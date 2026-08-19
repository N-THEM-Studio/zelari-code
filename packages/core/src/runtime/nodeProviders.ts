/**
 * runtime/nodeProviders.ts — node-backed Fs/Shell providers over a jailed workspace.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FsProvider, ShellProvider, ShellResult, ShellExecOptions, WorkspaceProvider } from './providers.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;
const LIST_MAX_ENTRIES = 5_000;
const LIST_MAX_DEPTH = 12;

/**
 * Kill a spawned command including its children. On Windows `child.kill()`
 * only signals cmd.exe — the actual command keeps running. `taskkill /T /F`
 * tears down the whole tree.
 */
function killTree(child: import('node:child_process').ChildProcess): void {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
    return;
  }
  child.kill('SIGKILL');
}

export class NodeFsProvider implements FsProvider {
  constructor(private readonly workspace: WorkspaceProvider) {}

  async readFile(rel: string): Promise<string> {
    return fs.readFile(this.workspace.resolve(rel), 'utf-8');
  }

  async writeFile(rel: string, data: string): Promise<void> {
    const absolute = this.workspace.resolve(rel);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data, 'utf-8');
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(this.workspace.resolve(rel));
      return true;
    } catch {
      return false;
    }
  }

  async list(rel = '.'): Promise<string[]> {
    const start = this.workspace.resolve(rel);
    const root = path.resolve(this.workspace.root);
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > LIST_MAX_DEPTH || out.length >= LIST_MAX_ENTRIES) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= LIST_MAX_ENTRIES) return;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          await walk(abs, depth + 1);
        } else {
          out.push(path.relative(root, abs).split(path.sep).join('/'));
        }
      }
    };
    await walk(start, 0);
    return out.sort();
  }
}

export class NodeShellProvider implements ShellProvider {
  constructor(
    private readonly workspace: WorkspaceProvider,
    private readonly defaults: { timeoutMs?: number } = {},
  ) {}

  async exec(command: string, options: ShellExecOptions = {}): Promise<ShellResult> {
    const started = Date.now();
    const cwd = this.workspace.resolve(options.cwd ?? '.');
    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const isWindows = process.platform === 'win32';
    const file = isWindows ? 'cmd.exe' : '/bin/sh';
    const args = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

    return await new Promise<ShellResult>((resolve) => {
      const child = spawn(file, args, { cwd, shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const append = (current: string, chunk: string): string => {
        const next = current + chunk;
        return next.length > maxChars ? next.slice(next.length - maxChars) : next;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        stdout = append(stdout, d.toString('utf-8'));
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr = append(stderr, d.toString('utf-8'));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          stdout,
          stderr: `${stderr}${err.message}`,
          durationMs: Date.now() - started,
          timedOut,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut });
      });
    });
  }
}
