/**
 * resolveClaudeExecutable — locate the official Claude Code binary and a
 * spawnable argv. The binary is never modified and never launched via a
 * shell. Subscription login stays inside that binary (`claude auth login`);
 * this module does not read or store claude.ai tokens.
 *
 * On Windows, npm's `claude.cmd` cannot be spawned without `shell: true`
 * (EINVAL since the 2024 batch-file hardening). The standard layout is
 * unwrapped to `node <shimDir>/node_modules/@anthropic-ai/claude-code/cli.js`,
 * the same approach T3 Code uses so the SDK can spawn the unmodified CLI.
 */
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { resolveExecutable, type ExecLookupOptions } from '../../safety/jails/execPath.js';

const SHIM_EXT = /\.(cmd|bat)$/i;
const CLI_REL = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'] as const;

export interface ResolveClaudeExecutableOptions extends ExecLookupOptions {
  /** Node binary used to run an unwrapped cli.js. Default: process.execPath. */
  execPath?: string;
  /** Test seam. Defaults to reading the shim as utf8. */
  readFile?: (path: string) => string;
  /** Test seam for sibling cli.js / node.exe. Defaults to fs.access. */
  exists?: (path: string) => boolean;
}

export type ClaudeExecutable =
  | {
      ok: true;
      /** Program passed to spawn. Never a .cmd/.bat. */
      program: string;
      /** Argv inserted before Claude's own flags (unwrapped cli.js, if any). */
      argvPrefix: readonly string[];
      resolvedPath: string;
    }
  | {
      ok: false;
      reason: string;
      resolvedPath?: string;
    };

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

function joinPlatform(dir: string, parts: readonly string[], platform: string): string {
  const sep = platform === 'win32' ? '\\' : '/';
  return [dir.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

function defaultExists(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function expandShimTokens(text: string, shimDir: string, platform: string): string {
  const sep = platform === 'win32' ? '\\' : '/';
  const base = shimDir.replace(/[\\/]+$/, '');
  const rooted = `${base}${sep}`;
  // %~dp0 already ends with a separator. npm shims write "%dp0%\..." after
  // SET dp0=%~dp0, so the token is followed by another one. Consume it.
  return text
    .replace(/%~dp0[\\/]?/gi, rooted)
    .replace(/%dp0%[\\/]?/gi, rooted);
}

/** Pull a cli.js path out of an npm shim. Quoted paths may contain spaces. */
export function cliJsFromShim(text: string, shimDir: string, platform: string): string | null {
  const expanded = expandShimTokens(text, shimDir, platform);
  const needle = /claude-code[\\/]cli\.js/i;
  const hit = needle.exec(expanded);
  if (!hit) return null;
  const end = hit.index + hit[0].length;
  let start = hit.index;
  while (start > 0) {
    const ch = expanded[start - 1];
    if (ch === '"' || ch === "'" || ch === '\n' || ch === '\r' || ch === '|') break;
    start--;
  }
  let raw = expanded.slice(start, end).trim().replace(/^['"]+/, '');
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]|\.)/.test(raw)) {
    const token = raw.split(/\s+/).find((part) => /cli\.js$/i.test(part));
    raw = token ?? raw;
  }
  return raw.length > 0 ? raw : null;
}

function unwrapShim(
  shimPath: string,
  platform: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
  execPath: string,
): ClaudeExecutable {
  const dir = dirOf(shimPath);
  const sibling = joinPlatform(dir, CLI_REL, platform);
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const nodeBeside = joinPlatform(dir, [nodeName], platform);
  if (exists(sibling)) {
    return {
      ok: true,
      program: exists(nodeBeside) ? nodeBeside : execPath,
      argvPrefix: [sibling],
      resolvedPath: shimPath,
    };
  }
  let text = '';
  try {
    text = readFile(shimPath);
  } catch {
    text = '';
  }
  const fromText = text ? cliJsFromShim(text, dir, platform) : null;
  if (fromText && exists(fromText)) {
    return {
      ok: true,
      program: exists(nodeBeside) ? nodeBeside : execPath,
      argvPrefix: [fromText],
      resolvedPath: shimPath,
    };
  }
  return {
    ok: false,
    resolvedPath: shimPath,
    reason:
      `[local-cli] ${shimPath} is a Windows .cmd/.bat shim and the official ` +
      `Claude Code cli.js next to it was not found. Set ZELARI_LOCAL_CLI to ` +
      `claude.exe or to @anthropic-ai/claude-code/cli.js. The shim is not ` +
      `spawned (no shell).`,
  };
}

/**
 * Resolve `name` (`claude`, or an explicit path) to a spawnable program.
 * Returns `ok: false` instead of a .cmd/.bat — those cannot be spawned
 * without a shell, and a shell is not used here.
 */
export function resolveClaudeExecutable(
  name: string,
  opts: ResolveClaudeExecutableOptions = {},
): ClaudeExecutable {
  const platform = opts.platform ?? process.platform;
  const execPath = opts.execPath ?? process.execPath;
  const exists = opts.exists ?? defaultExists;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const resolved = resolveExecutable(name, opts);
  if (!resolved) {
    return {
      ok: false,
      reason:
        `[local-cli] Claude Code binary "${name}" was not found. Install the ` +
        `official CLI and run \`claude auth login\`. Zelari does not store ` +
        `subscription tokens.`,
    };
  }
  if (SHIM_EXT.test(resolved)) {
    return unwrapShim(resolved, platform, exists, readFile, execPath);
  }
  if (/\.js$/i.test(resolved)) {
    return { ok: true, program: execPath, argvPrefix: [resolved], resolvedPath: resolved };
  }
  return { ok: true, program: resolved, argvPrefix: [], resolvedPath: resolved };
}
