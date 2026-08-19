/**
 * runtime/memoryProviders.ts — deterministic in-memory providers for tests
 * and benchmarks (no fs/shell side effects).
 */

import type {
  FsProvider,
  ShellProvider,
  ShellResult,
  ShellExecOptions,
} from './providers.js';

/** In-memory file map keyed by normalized relative path. */
export class MemoryFsProvider implements FsProvider {
  readonly files = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(this.norm(k), v);
  }

  private norm(rel: string): string {
    return rel.replace(/^\.?\//, '').replace(/\\/g, '/');
  }

  async readFile(rel: string): Promise<string> {
    const content = this.files.get(this.norm(rel));
    if (content === undefined) {
      throw new Error(`ENOENT (memory): ${rel}`);
    }
    return content;
  }

  async writeFile(rel: string, data: string): Promise<void> {
    this.files.set(this.norm(rel), data);
  }

  async exists(rel: string): Promise<boolean> {
    return this.files.has(this.norm(rel));
  }

  async list(rel = '.'): Promise<string[]> {
    const prefix = rel === '.' || rel === '' ? '' : `${this.norm(rel)}/`;
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export type MemoryShellHandler = {
  /** Substring (or regex source) matched against the command. */
  match: string | RegExp;
  result:
    | Partial<ShellResult>
    | ((command: string) => Partial<ShellResult>);
};

/** Scripted shell: first matching handler wins; unmatched commands fail. */
export class MemoryShellProvider implements ShellProvider {
  constructor(private readonly handlers: MemoryShellHandler[] = []) {}

  async exec(command: string, _options?: ShellExecOptions): Promise<ShellResult> {
    void _options;
    for (const handler of this.handlers) {
      const hit =
        typeof handler.match === 'string' ? command.includes(handler.match) : handler.match.test(command);
      if (!hit) continue;
      const partial = typeof handler.result === 'function' ? handler.result(command) : handler.result;
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        ...partial,
      };
    }
    return {
      exitCode: 127,
      stdout: '',
      stderr: `MemoryShellProvider: no handler matched command: ${command}`,
      durationMs: 0,
      timedOut: false,
    };
  }
}
