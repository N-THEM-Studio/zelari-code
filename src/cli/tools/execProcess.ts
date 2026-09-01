/**
 * exec_process — structured process execution (P0.C2, task t17).
 *
 * The raw-shell `bash` tool takes a STRING and hands it to a shell for
 * interpolation; policy can only guess what the string will run. This tool
 * takes a PROGRAM + argv ARRAY and spawns it directly (`shell: false`) —
 * there is no shell parsing stage at all, so the argv the policy engine
 * evaluated is EXACTLY the argv the OS executes.
 *
 * Guardrails (same discipline as `bash`, minus the shell resolver):
 *  - cwd is sandboxed to the workspace root via resolveSandboxedPath();
 *  - timeout kills the child and returns an error (default 30 s, cap 10 min);
 *  - stdin is CLOSED ('ignore') + CI=1 so prompts fail fast, not hang;
 *  - stdout/stderr are captured and capped at 1 MB per stream;
 *  - every invocation lands in the audit trail with program+argv+exitCode
 *    (the registry wraps this tool — see toolRegistry.ts);
 *  - the shell blocklist still runs on the joined program+argv as
 *    defense-in-depth against destructive payloads.
 *
 * v2.17 (t28, Pilastro A): the spawn goes through the osJail choke-point
 * {@link spawnJailed} — NO direct child_process spawn remains on this path
 * (grep-gated by scripts/verify-os-jail.mjs). Under the active jail the
 * child gets an allowlisted env only; a missing backend with
 * ZELARI_OS_JAIL=required DENIES the tool (typed `[jail]` error) and with
 * `advisory` runs unjailed with a visible warning on the result. The
 * network posture comes from the SAME resourceClaims decision as the
 * permission layer (hosts whose claim resolved to `allow`).
 *
 * Windows note: direct spawn like the bash tool's win32 branch — plain .exe
 * binaries on PATH work; `.cmd`/`.bat` shims may need the full path (no
 * shell indirection exists here to resolve them).
 */

import { z } from 'zod';
import { typedErr, typedOk, type ToolDefinition, type ToolResultMeta } from '@zelari/core/harness/tools/toolTypes';
import { findBlockedReason } from '../safety/shellBlocklist.js';
import { inspectCommand } from '../safety/selfKillGuard.js';
import { resolveSandboxedPath, SandboxViolationError } from '../safety/sandboxPath.js';
import { buildJailSpec, networkSpecFromClaimHosts, spawnJailed, type JailNetwork } from '../safety/osJail.js';

export const execProcessInputSchema = z.object({
  /** Program to execute: bare name resolved via PATH, or an absolute path. */
  program: z.string().min(1),
  /** Argument vector passed verbatim (no shell interpolation). */
  args: z.array(z.string()).optional(),
  /** Working directory; relative paths resolve inside the workspace sandbox. */
  cwd: z.string().optional(),
  /** Kill the child after this long (ms). Default 30 s, max 10 min. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export type ExecProcessInput = z.infer<typeof execProcessInputSchema>;

/** Structured result — machine-checkable, feeds evidence/audit summaries. */
export interface ExecProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Per-stream output cap — same budget as the bash tool. */
const MAX_STREAM_CHARS = 1024 * 1024;

export interface ExecProcessToolOptions {
  /**
   * t28: resolve the JailSpec network posture for THIS invocation from the
   * SAME layered claims engine the permission wrapper uses (no second
   * policy engine). Omitted ⇒ conservative deny.
   */
  resolveNetwork?: (args: ExecProcessInput) => JailNetwork;
}

export function createExecProcessTool(
  root: string,
  opts: ExecProcessToolOptions = {},
): ToolDefinition<ExecProcessInput, ExecProcessResult> {
  // The spec is per-registry (root is constant); only the network posture
  // is narrowed per invocation from the claims verdict.
  const baseSpec = buildJailSpec({ root });
  return {
    name: 'exec_process',
    description:
      'Execute ONE program with structured arguments WITHOUT shell interpolation: no pipes, globs, variable expansion or quoting pitfalls — exactly the argv you pass is executed. ' +
      'cwd stays inside the workspace, stdin is closed (non-interactive), and the call returns {exitCode, stdout, stderr, durationMs}. ' +
      'Prefer this over bash whenever you just need to run a single binary (tests, typecheckers, git) and do not need shell features.',
    permissions: ['execute'],
    sideEffect: 'local',
    timeoutMs: 60_000,
    inputSchema: execProcessInputSchema,
    execute: async (input, ctx) => {
      const argv = input.args ?? [];
      // Defense-in-depth: the blocklist regexes were written for shell strings,
      // but joined program+argv still catches the obvious destructive shapes.
      const blocked = findBlockedReason([input.program, ...argv].join(' '));
      if (blocked) {
        return typedErr(`[shell-blocked] exec_process refused (${blocked.reason}): ${blocked.pattern}`);
      }
      // Anti-self-kill: refuse argv that would terminate the agent host
      // itself (node image kills / own process tree) — same rejection
      // discipline as the blocklist above, BEFORE any spawn.
      const selfKill = inspectCommand([input.program, ...argv].join(' '), {
        selfPid: process.pid,
        parentPid: process.ppid,
      });
      if (selfKill.blocked && selfKill.message) {
        return typedErr(`[self-kill] exec_process refused: ${selfKill.message}`);
      }
      let cwd: string;
      try {
        // Absolute-inside-root or root-relative only — the child starts in
        // the workspace, never wherever the CLI happened to be launched.
        cwd = resolveSandboxedPath(input.cwd ?? '.', { root });
      } catch (err) {
        const msg = err instanceof SandboxViolationError ? err.message : String(err);
        return typedErr(`[sandbox] ${msg}`);
      }
      return new Promise((resolve) => {
        const start = Date.now();
        // v2.17 (t28): THE choke-point. Deny/notice/fail are handled below;
        // this path never touches child_process directly.
        const spec = { ...baseSpec, network: opts.resolveNetwork?.(input) ?? baseSpec.network };
        const res = spawnJailed(spec, {
          program: input.program,
          argv,
          cwd,
          signal: ctx?.signal,
          env: process.env,
          envExtras: { CI: process.env.CI ?? '1' },
        });
        if (res.outcome === 'denied') {
          resolve(typedErr(res.reason));
          return;
        }
        if (res.outcome === 'failed') {
          resolve(typedErr(`exec_process could not launch ${input.program}: ${res.reason}`));
          return;
        }
        // Visible fail-open (advisory): the notice rides on the result meta.
        const meta: ToolResultMeta | undefined = res.notice
          ? { status: 'complete', warnings: [`os-jail: ${res.notice}`] }
          : undefined;
        const child = res.child;
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => {
          if (stdout.length < MAX_STREAM_CHARS) stdout += d.toString('utf8');
        });
        child.stderr?.on('data', (d: Buffer) => {
          if (stderr.length < MAX_STREAM_CHARS) stderr += d.toString('utf8');
        });
        // Resilience guard: execute() must also behave when called directly
        // (tests/registry) bypassing zod parse, where the schema default
        // hasn't been applied yet.
        const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : 30_000;
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          resolve(
            typedErr(
              `exec_process timed out after ${timeoutMs}ms running: ${[input.program, ...argv].join(' ')}`,
            ),
          );
        }, timeoutMs);
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve(typedErr(`exec_process could not launch ${input.program}: ${err.message}`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(
            typedOk(
              {
                exitCode: code ?? -1,
                stdout: stdout.slice(0, MAX_STREAM_CHARS),
                stderr: stderr.slice(0, MAX_STREAM_CHARS),
                durationMs: Date.now() - start,
              },
              meta,
            ),
          );
        });
      });
    },
  };
}
