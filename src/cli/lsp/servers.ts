/**
 * lsp/servers — map a source file to the language server that handles it.
 *
 * Servers are external binaries resolved at runtime (project-local
 * node_modules/.bin first, then PATH), exactly like the diagnostics
 * checkers. When none is installed the LSP tools degrade silently.
 */

import path from 'node:path';
import { resolveBin } from '../diagnostics/engine.js';

export interface LspServerSpec {
  /** Stable language id (also sent as `languageId` in didOpen). */
  language: string;
  /** Binary name to resolve. */
  bin: string;
  /** Args to launch the server in stdio mode. */
  args: string[];
  /** File extensions (with dot, lower-case) this server handles. */
  extensions: readonly string[];
}

/**
 * Built-in server specs. Order matters only for display; extension lookup is
 * exact. All speak LSP over stdio.
 */
export const LSP_SERVERS: readonly LspServerSpec[] = [
  {
    language: 'typescript',
    bin: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  {
    language: 'python',
    bin: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py'],
  },
  {
    language: 'go',
    bin: 'gopls',
    args: [],
    extensions: ['.go'],
  },
  {
    language: 'rust',
    bin: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
  },
];

/** The `languageId` LSP expects for a given extension (didOpen). */
export function languageIdForFile(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
  };
  return map[ext] ?? 'plaintext';
}

/** Find the server spec for a file's extension, or null. */
export function serverForFile(
  file: string,
  servers: readonly LspServerSpec[] = LSP_SERVERS,
): LspServerSpec | null {
  const ext = path.extname(file).toLowerCase();
  return servers.find((s) => s.extensions.includes(ext)) ?? null;
}

/**
 * Resolve the launch command for a file's server, or null when no server is
 * installed for that language. `bin` is resolved project-local first.
 */
export function resolveServerCommand(
  file: string,
  cwd: string,
  servers: readonly LspServerSpec[] = LSP_SERVERS,
): { language: string; command: string; args: string[]; resolved: boolean } | null {
  const spec = serverForFile(file, servers);
  if (!spec) return null;
  const command = resolveBin(spec.bin, cwd);
  // resolveBin returns the bare name when nothing local was found; we can't
  // know if it's on PATH without spawning, so report `resolved` = whether a
  // path (vs the bare bin name) came back.
  return {
    language: spec.language,
    command,
    args: spec.args,
    resolved: command !== spec.bin,
  };
}
