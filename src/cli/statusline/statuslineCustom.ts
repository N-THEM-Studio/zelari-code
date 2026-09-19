/**
 * statuslineCustom — the `custom` status-line item: run a user script and show
 * its first line (t114).
 *
 * PROTOCOL (stable, documented for users):
 *   - the script is a shell command line (the same shell the tool surface
 *     resolves — Git Bash on Windows when present, /bin/sh elsewhere), so
 *     `node ~/status.js` or `./bin/status.sh` both work;
 *   - one JSON object arrives on STDIN:
 *     {cwd, model, sessionId, turn, pendingTodos}
 *   - the FIRST line of STDOUT becomes the item text, ANSI/OSC escapes
 *     stripped and truncated to 120 chars;
 *   - the item is HIDDEN (never a crash, never a partial chip) when the
 *     script exits non-zero, produces no usable first line, or exceeds the
 *     timeout — in which case the child is killed.
 *
 * Two entry points share the same protocol helpers:
 *   - `runStatusLineCustomItem` (async): what a live status line refreshes
 *     with, so a slow script can never block a render;
 *   - `previewStatusLineCustomItem` (sync, bounded): what `/statusline custom
 *     <cmd>` uses to confirm a freshly configured command immediately.
 */
import { spawn, spawnSync } from 'node:child_process';
import { resolveShell } from '@zelari/core/harness/tools/builtin/shellResolver';
import {
  DEFAULT_STATUSLINE_TIMEOUT_MS,
  MAX_STATUSLINE_TIMEOUT_MS,
  STATUSLINE_MAX_TEXT_CHARS,
} from './statuslineConfig.js';

/** What the script receives on stdin. */
export interface StatusLineCustomPayload {
  cwd: string;
  model: string;
  sessionId: string;
  turn: number;
  pendingTodos: number;
}

export interface StatusLineCustomRunOptions {
  command: string;
  /** Payload handed to the script (defaults to an empty-everything object). */
  payload?: Partial<StatusLineCustomPayload>;
  /** Working directory of the script (defaults to process.cwd()). */
  cwd?: string;
  /** Kill the script after this many ms (default 1500, capped at 30s). */
  timeoutMs?: number;
  /** Base env (defaults to process.env); the jail rules do NOT apply here. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: replace the shell invocation (default: resolveShell()). */
  invocation?: ShellInvocation;
}

export interface ShellInvocation {
  program: string;
  args: string[];
}

/**
 * Shell wrapper for `command`: bash ⇒ `-c`, PowerShell ⇒ `-Command`, plain
 * cmd/sh otherwise. Explicit argv (never `shell: true` + args, which Node
 * deprecates and which cannot express a multi-word command safely).
 */
export function shellInvocation(command: string): ShellInvocation {
  const resolved = resolveShell();
  if (resolved.isBash && resolved.shell !== true) return { program: resolved.shell, args: ['-c', command] };
  if (resolved.isPowerShell && resolved.shell !== true) {
    return { program: resolved.shell, args: ['-NoProfile', '-Command', command] };
  }
  if (process.platform === 'win32') {
    return { program: process.env.COMSPEC?.trim() || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { program: '/bin/sh', args: ['-c', command] };
}

/** Escape sequences that must never reach the status line. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** First stdout line, ANSI-stripped and truncated; null when unusable. */
export function normalizeStatusLineText(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const clean = firstLine.replace(ANSI_RE, '').replace(/\s+$/, '').trim();
  if (clean.length === 0) return null;
  return clean.length > STATUSLINE_MAX_TEXT_CHARS ? clean.slice(0, STATUSLINE_MAX_TEXT_CHARS) : clean;
}

/** Payload defaults (every field is always present — the contract is JSON). */
export function customItemPayload(partial: Partial<StatusLineCustomPayload> = {}): StatusLineCustomPayload {
  return {
    cwd: partial.cwd ?? process.cwd(),
    model: partial.model ?? '',
    sessionId: partial.sessionId ?? '',
    turn: partial.turn ?? 0,
    pendingTodos: partial.pendingTodos ?? 0,
  };
}

function boundedTimeout(timeoutMs: number | undefined): number {
  const t = timeoutMs ?? DEFAULT_STATUSLINE_TIMEOUT_MS;
  if (!Number.isFinite(t) || t <= 0) return DEFAULT_STATUSLINE_TIMEOUT_MS;
  return Math.min(Math.floor(t), MAX_STATUSLINE_TIMEOUT_MS);
}

/** Cap on captured stdout — a chatty script must not grow our memory. */
const MAX_CAPTURE_CHARS = 8192;

/**
 * Run the custom script and resolve with its first usable line, or null on
 * ANY failure (bad command, non-zero exit, timeout, empty output). Never
 * rejects: the status line must not be able to crash the TUI.
 */
export function runStatusLineCustomItem(opts: StatusLineCustomRunOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const invocation = opts.invocation ?? shellInvocation(opts.command);
    const timeoutMs = boundedTimeout(opts.timeoutMs);
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let timer: NodeJS.Timeout;
    try {
      child = spawn(invocation.program, invocation.args, {
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? process.env,
        shell: false, // the invocation already carries the shell
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    // A script that never reads stdin makes the write fail with EPIPE — the
    // status line must ignore that, not surface it.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(customItemPayload({ cwd: opts.cwd, ...opts.payload })));
    let out = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (out.length < MAX_CAPTURE_CHARS) out += chunk.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 || code === null ? normalizeStatusLineText(out) : null));
  });
}

export interface StatusLineCustomPreview extends StatusLineCustomRunOptions {}

/**
 * SYNC, bounded preview for `/statusline custom <cmd>` — the one place where
 * blocking is acceptable (an explicit user command, capped by the same
 * timeout). Same protocol, same normalization, same fail-soft contract.
 */
export function previewStatusLineCustomItem(opts: StatusLineCustomPreview): string | null {
  const invocation = opts.invocation ?? shellInvocation(opts.command);
  try {
    const res = spawnSync(invocation.program, invocation.args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      input: JSON.stringify(customItemPayload({ cwd: opts.cwd, ...opts.payload })),
      timeout: boundedTimeout(opts.timeoutMs),
      killSignal: 'SIGKILL',
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: MAX_CAPTURE_CHARS,
    });
    if (res.error || (typeof res.status === 'number' && res.status !== 0)) return null;
    return normalizeStatusLineText(res.stdout ?? '');
  } catch {
    return null;
  }
}
