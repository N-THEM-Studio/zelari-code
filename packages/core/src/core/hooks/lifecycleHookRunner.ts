/**
 * LifecycleHookRunner — executes PreToolUse / PostToolUse / SessionStart /
 * SessionEnd hooks as external commands (or HTTP POSTs), FAIL-OPEN.
 *
 * Safety model (v1.32.0):
 * - A hook that crashes, times out, exits non-zero, or returns invalid JSON
 *   is logged and treated as ALLOW. Hooks must never brick the agent.
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
}

const DEFAULT_TIMEOUT_MS = 5000;

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Execute one hook for an event. NEVER throws: any failure becomes an
 * explicit allow (fail-open) with a logged warning.
 */
export class LifecycleHookRunner {
  private hooks: HookDefinition[] = [];
  private readonly logger: (msg: string) => void;
  private readonly defaultTimeoutMs: number;

  constructor(options: LifecycleHookRunnerOptions = {}) {
    this.logger = options.logger ?? ((msg) => console.error(`[hooks] ${msg}`));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
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
   * explicitly denies. All other outcomes (no match, crash, timeout, invalid
   * JSON, allow decision) return `{ ok: true }`.
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

  /** Run matching SessionStart hooks. Fail-open; deny never throws. */
  async runSessionStart(ctx: { sessionId?: string; cwd?: string }): Promise<SessionHookResult> {
    return this.runSessionHooks('SessionStart', ctx);
  }

  /** Run matching SessionEnd hooks. Fail-open. */
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

  /** Execute a single hook, swallowing every failure into an allow. */
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
        this.logger(`hook "${hook.name}" returned invalid JSON (fail-open): ${raw.slice(0, 200)}`);
        return { decision: 'allow' };
      }
      if (decision.decision === 'deny' && typeof decision.reason !== 'string') {
        this.logger(`hook "${hook.name}" denied without reason (fail-open)`);
        return { decision: 'allow' };
      }
      return decision;
    } catch (err) {
      this.logger(
        `hook "${hook.name}" failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { decision: 'allow' };
    }
  }

  /** Spawn `command`, write JSON payload to stdin, read stdout until close. */
  private execCommand(
    command: string,
    payload: HookPayload,
    timeoutMs: number,
    cwd?: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Shell-spawn so `node script.mjs` / `deno run` both work cross-platform.
      const child = spawn(command, {
        shell: true,
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
