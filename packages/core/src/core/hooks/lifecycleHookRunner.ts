/**
 * LifecycleHookRunner — executes PreToolUse / PostToolUse / SessionStart /
 * SessionEnd hooks as external commands (or HTTP POSTs).
 *
 * Safety model (v1.32.0):
 * - A hook that crashes, times out, exits non-zero, or returns invalid JSON
 *   is logged and treated as ALLOW (default `failureMode: 'fail-open'`).
 *   v2.16 (HARNESS-10 t22): `failureMode: 'fail-closed'` — used by the CLI
 *   for strict headless/mission/CI surfaces — treats every such unreliable
 *   outcome as an explicit DENY with reason `hook-failed` instead (same
 *   deny shape as a hook's own decision). The mode applies to PreToolUse
 *   AND Session hooks; the CLI layer decides it (see
 *   src/cli/safety/lifecycleHooks.ts `resolveHookFailureMode`).
 * - v2.17 (t27): hook commands spawn as an EXPLICIT argv with `shell: false`
 *   on every OS (see splitHookCommandLine) — shell metacharacters in a hook
 *   `command` are literal arguments, never re-interpreted by a shell.
 * - The ONLY way to block a tool is an explicit JSON decision
 *   `{ "decision": "deny", "reason": "..." }` on stdout / response body.
 * - Tool matching is Claude-code style: `Bash` and `bash` both match the
 *   `bash` tool (see types.ts `normalizeToolName`).
 *
 * Hook files are loaded from one or more directories; each `*.json` file is
 * one {@link HookDefinition}. Global hooks (`~/.zelari-code/hooks`) are
 * always active; project hooks (`.zelari/hooks`) are only loaded when the
 * folder is trusted — the CLI decides that via FolderTrustStore and passes
 * only the allowed dirs here.
 *
 * @since v1.32.0
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  hookMatches,
  type HookDecision,
  type HookDefinition,
  type HookEvent,
  type HookPayload,
  type PreToolUseResult,
  type SessionHookResult,
} from './types.js';

export interface LifecycleHookRunnerOptions {
  /** Directories to scan for `*.json` hook files. */
  dirs?: string[];
  /** Logger sink (default: console.error). */
  logger?: (msg: string) => void;
  /** Default per-hook timeout in ms (default 5000). */
  defaultTimeoutMs?: number;
  /**
   * v2.16 (t22): what an unreliable hook (crash/timeout/invalid JSON/deny
   * without reason) means. 'fail-open' (default) logs and allows;
   * 'fail-closed' denies with reason 'hook-failed'.
   */
  failureMode?: HookFailureMode;
}

/** How an unreliable hook outcome resolves (v2.16 t22). */
export type HookFailureMode = 'fail-open' | 'fail-closed';

const DEFAULT_TIMEOUT_MS = 5000;

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * v2.17 (t27): conservative command line → argv split for hook commands.
 *
 * Splits on whitespace; honors single/double quotes and `\"` `\'` `\\`
 * escapes. A backslash escapes ONLY quote/backslash characters (never an
 * arbitrary next char) so Windows paths like `C:\tools\hook.mjs` survive
 * unquoted. There are NO shell semantics: metacharacters (`;`, `&&`, `|`,
 * `$VAR`, `>`) are never special — they become literal argv tokens. Paired
 * with `shell: false` in {@link LifecycleHookRunner.execCommand} the OS
 * executes exactly `[program, ...args]`: `echo a; rm -rf /` is the program
 * `echo` with the literal argument `a;` — the `rm` NEVER runs. Unclosed
 * quotes are tolerated (the partial token is kept, the hook then fails and
 * the failure mode decides the outcome). Env-prefix syntax (`FOO=1 node x`)
 * is NOT shell-magic here: `FOO=1` would be the program name and fail —
 * move environment into the hook script. Windows `.cmd`/`.bat` shims
 * (`npm`, `npx`) need the full path, same limitation as exec_process.
 */
export function splitHookCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        cur += line[i + 1];
        i += 1;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === "'" || line[i + 1] === '\\')) {
      cur += line[i + 1];
      hasToken = true;
      i += 1;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        out.push(cur);
        cur = '';
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken || cur.length > 0) out.push(cur);
  return out;
}

/**
 * Execute hooks for lifecycle events. NEVER throws: an unreliable hook
 * (crash / timeout / invalid JSON / deny without reason) becomes an explicit
 * allow (fail-open, default) or an explicit deny 'hook-failed' (fail-closed,
 * t22), with a logged warning either way.
 */
export class LifecycleHookRunner {
  private hooks: HookDefinition[] = [];
  private readonly logger: (msg: string) => void;
  private readonly defaultTimeoutMs: number;
  /** v2.16 (t22): resolved failure mode. Default 'fail-open'. */
  readonly failureMode: HookFailureMode;

  constructor(options: LifecycleHookRunnerOptions = {}) {
    this.logger = options.logger ?? ((msg) => console.error(`[hooks] ${msg}`));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.failureMode = options.failureMode ?? 'fail-open';
    for (const dir of options.dirs ?? []) {
      this.loadDir(dir);
    }
  }

  /** Add a single hook definition (used by tests / programmatic config). */
  addHook(hook: HookDefinition): void {
    this.hooks.push(hook);
  }

  /** Scan a directory for `*.json` hook files and load them. Returns count. */
  loadDir(dir: string): number {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return 0; // dir missing → no hooks
    }
    let loaded = 0;
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const parsed = parseJson<HookDefinition>(readFileSync(full, 'utf8'));
        if (!parsed || !parsed.name || !parsed.match) {
          this.logger(`skipping invalid hook file ${full}`);
          continue;
        }
        // Prefer file name as the hook name when absent; keep explicit name.
        parsed.name = parsed.name || path.basename(f, '.json');
        this.hooks.push(parsed);
        loaded += 1;
      } catch (err) {
        this.logger(`failed to load hook ${full}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return loaded;
  }

  listHooks(): HookDefinition[] {
    return [...this.hooks];
  }

  /**
   * Run matching PreToolUse hooks. Returns `{ ok: false }` ONLY when a hook
   * explicitly denies — or, in fail-closed mode (t22), when the hook runner
   * could not produce a verdict at all. Fail-open: no match, crash, timeout,
   * invalid JSON and allow decisions all return `{ ok: true }`.
   */
  async runPreToolUse(
    toolName: string,
    toolInput: unknown,
    ctx: { sessionId?: string; cwd?: string },
  ): Promise<PreToolUseResult> {
    for (const hook of this.hooks) {
      if (!hookMatches(hook, 'PreToolUse', toolName)) continue;
      const payload: HookPayload = {
        event: 'PreToolUse',
        toolName,
        toolInput,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      };
      const decision = await this.runHookSafely(hook, payload);
      if (decision.decision === 'deny') {
        return {
          ok: false,
          hookName: hook.name,
          reason: decision.reason || `blocked by hook "${hook.name}"`,
        };
      }
    }
    return { ok: true };
  }

  /** Run matching PostToolUse hooks. Fail-open, results are logged only. */
  async runPostToolUse(
    toolName: string,
    toolInput: unknown,
    toolOutput: unknown,
    ctx: { sessionId?: string; cwd?: string; ok?: boolean; error?: string },
  ): Promise<void> {
    for (const hook of this.hooks) {
      if (!hookMatches(hook, 'PostToolUse', toolName)) continue;
      const payload: HookPayload = {
        event: 'PostToolUse',
        toolName,
        toolInput,
        toolOutput,
        ok: ctx.ok ?? true,
        error: ctx.error,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      };
      await this.runHookSafely(hook, payload);
    }
  }

  /** Run matching SessionStart hooks. Failure semantics per failureMode (t22). */
  async runSessionStart(ctx: { sessionId?: string; cwd?: string }): Promise<SessionHookResult> {
    return this.runSessionHooks('SessionStart', ctx);
  }

  /** Run matching SessionEnd hooks. Failure semantics per failureMode (t22). */
  async runSessionEnd(ctx: { sessionId?: string; cwd?: string }): Promise<SessionHookResult> {
    return this.runSessionHooks('SessionEnd', ctx);
  }

  private async runSessionHooks(
    event: HookEvent,
    ctx: { sessionId?: string; cwd?: string },
  ): Promise<SessionHookResult> {
    for (const hook of this.hooks) {
      if (!hookMatches(hook, event, undefined)) continue;
      const payload: HookPayload = {
        event,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      };
      const decision = await this.runHookSafely(hook, payload);
      if (decision.decision === 'deny') {
        return {
          ok: false,
          hookName: hook.name,
          reason: decision.reason || `blocked by hook "${hook.name}"`,
        };
      }
    }
    return { ok: true };
  }

  /** Execute a single hook; the failure mode decides allow vs deny 'hook-failed'. */
  private async runHookSafely(
    hook: HookDefinition,
    payload: HookPayload,
  ): Promise<HookDecision> {
    try {
      const timeoutMs = hook.timeoutMs ?? this.defaultTimeoutMs;
      const raw = hook.url
        ? await this.postHttp(hook.url, payload, timeoutMs)
        : await this.execCommand(hook.command ?? '', payload, timeoutMs, hook.cwd);
      const decision = parseJson<HookDecision>(raw);
      if (!decision) {
        this.logger(`hook "${hook.name}" returned invalid JSON (${this.failureMode}): ${raw.slice(0, 200)}`);
        return this.failureDecision();
      }
      if (decision.decision === 'deny' && typeof decision.reason !== 'string') {
        this.logger(`hook "${hook.name}" denied without reason (${this.failureMode})`);
        return this.failureDecision();
      }
      return decision;
    } catch (err) {
      this.logger(
        `hook "${hook.name}" failed (${this.failureMode}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.failureDecision();
    }
  }

  /**
   * v2.16 (t22): resolve a hook that produced no usable verdict. Fail-open
   * (default) allows; fail-closed maps the failure to the same shape as an
   * explicit deny so PreToolUse/Session hook consumers block the call.
   */
  private failureDecision(): HookDecision {
    return this.failureMode === 'fail-closed'
      ? { decision: 'deny', reason: 'hook-failed' }
      : { decision: 'allow' };
  }

  /** Spawn `command`, write JSON payload to stdin, read stdout until close. */
  private execCommand(
    command: string,
    payload: HookPayload,
    timeoutMs: number,
    cwd?: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // v2.17 (t27): explicit argv + `shell: false` on EVERY OS (previously
      // `spawn(command, { shell: true })`). The command line is parsed by
      // splitHookCommandLine (quotes yes, shell metacharacters no) so a hook
      // command can never be re-interpreted / chained by a shell: the OS
      // runs exactly [program, ...args]. Plain .exe binaries resolve on PATH
      // (`node script.mjs` / `deno run` keep working cross-platform).
      const argv = splitHookCommandLine(command);
      if (argv.length === 0) {
        reject(new Error('empty hook command'));
        return;
      }
      const child = spawn(argv[0], argv.slice(1), {
        shell: false,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`exited ${code}: ${stderr.trim().slice(0, 200)}`));
          return;
        }
        resolve(stdout);
      });
      child.stdin?.on('error', () => {
        /* ignore EPIPE */
      });
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });
  }

  /** POST JSON payload; resolve with the response body text. */
  private async postHttp(
    url: string,
    payload: HookPayload,
    timeoutMs: number,
  ): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
}
