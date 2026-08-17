/**
 * inspectCommand — allowlisted, no-shell command inspector (WS3, v0.10.0).
 *
 * Available in plan/readOnly sessions exactly where `bash` is NOT: it gives
 * plan-mode "execution-verified" observations (git state, `tsc --noEmit`)
 * without unlocking mutations. The API is a discriminated union on
 * `operation` — the model picks from a menu, it never writes a command
 * string, so tokenizer/quote-parsing/metacharacter injection do not exist by
 * construction. Every argv is built here and executed with
 * `spawn(cmd, argv, { shell: false })`.
 *
 * Loud results: every payload carries `inspectionClass`
 * ('git-inspection' | 'project-code-execution' | 'env-info') so the model
 * knows when it is executing project code (typecheck) vs reading git state.
 * `typecheck` additionally applies the S3.5 artifact-safety guard (see
 * inspectTypecheckSafety.ts): tsbuildinfo redirected to the OS temp dir and
 * a pre/post workspace fingerprint — any delta is reported as `degraded`
 * with cleanup, never silently ignored.
 *
 * Kill-switch: ZELARI_INSPECT_COMMAND=0 (checked at registration time).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { typedOk, typedErr, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import {
  classifyTypecheckRefusal,
  cleanupArtifacts,
  diffFingerprints,
  fingerprintWorkspace,
} from './inspectTypecheckSafety.js';

/** Combined output cap (stdout+stderr) — 8 KB, matches the plan. */
const MAX_OUTPUT_CHARS = 8 * 1024;
/** Internal process timeout; the tool-level timeoutMs is 90 s. */
const SPAWN_TIMEOUT_MS = 85_000;
/** typecheck gets a longer leash: real projects take tens of seconds. */
const TYPECHECK_TIMEOUT_MS = 85_000;

export type InspectionClass = 'git-inspection' | 'project-code-execution' | 'env-info';

export const inspectInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('git_status'), short: z.boolean().optional() }),
  z.object({
    operation: z.literal('git_log'),
    limit: z.number().int().min(1).max(200).optional(),
    oneline: z.boolean().optional(),
  }),
  z.object({
    operation: z.literal('git_diff'),
    staged: z.boolean().optional(),
    path: z.string().optional(),
  }),
  z.object({ operation: z.literal('git_show'), ref: z.string().min(1) }),
  z.object({ operation: z.literal('git_branch_current') }),
  z.object({ operation: z.literal('git_ls_files') }),
  z.object({ operation: z.literal('typecheck'), project: z.string().optional() }),
  z.object({ operation: z.literal('node_version') }),
  z.object({ operation: z.literal('npm_ls') }),
  z.object({ operation: z.literal('npm_outdated') }),
  z.object({ operation: z.literal('npm_view'), package: z.string().min(1) }),
]);

export type InspectOperation = z.infer<typeof inspectInputSchema>;

export type BuiltInspect =
  | {
      ok: true;
      command: string;
      argv: string[];
      inspectionClass: InspectionClass;
      /** typecheck only: absolute tsbuildinfo redirect target (OS temp dir). */
      tsBuildInfoFile?: string;
    }
  | { ok: false; reason: string };

export interface BuildCtx {
  /** Workspace root (tool binding). */
  root: string;
  /** Working directory for relative-path resolution. */
  cwd: string;
  /** Override the tsc launcher (tests). Default: <root>/node_modules/typescript/bin/tsc. */
  tscPath?: string;
  /** Override the npm-cli.js launcher (tests). Default: <root>/node_modules/npm/bin/npm-cli.js. */
  npmCliPath?: string;
}

/** Free-string args that must never be interpretable as flags. */
function rejectFlagLike(kind: string, value: string): string | null {
  if (value.startsWith('-')) {
    return `${kind} must not start with "-" (got ${JSON.stringify(value)}) — pass a value, not a flag`;
  }
  return null;
}

/**
 * Pure argv builder — one case per operation. No user string ever reaches a
 * shell; forced safety flags (`--no-ext-diff --no-textconv` on diff/show)
 * cannot be disabled by input.
 */
export function buildInspectCommand(op: InspectOperation, ctx: BuildCtx): BuiltInspect {
  switch (op.operation) {
    case 'git_status':
      return {
        ok: true,
        command: 'git',
        argv: ['status', ...(op.short ? ['--short'] : [])],
        inspectionClass: 'git-inspection',
      };
    case 'git_log':
      return {
        ok: true,
        command: 'git',
        argv: [
          'log',
          ...(op.oneline ? ['--oneline'] : []),
          ...(op.limit !== undefined ? ['-n', String(op.limit)] : []),
        ],
        inspectionClass: 'git-inspection',
      };
    case 'git_diff': {
      if (op.path !== undefined) {
        const err = rejectFlagLike('path', op.path);
        if (err) return { ok: false, reason: err };
      }
      return {
        ok: true,
        command: 'git',
        argv: [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          ...(op.staged ? ['--staged'] : []),
          ...(op.path !== undefined ? ['--', op.path] : []),
        ],
        inspectionClass: 'git-inspection',
      };
    }
    case 'git_show': {
      const err = rejectFlagLike('ref', op.ref);
      if (err) return { ok: false, reason: err };
      return {
        ok: true,
        command: 'git',
        argv: ['show', '--no-ext-diff', '--no-textconv', op.ref],
        inspectionClass: 'git-inspection',
      };
    }
    case 'git_branch_current':
      return { ok: true, command: 'git', argv: ['branch', '--show-current'], inspectionClass: 'git-inspection' };
    case 'git_ls_files':
      return { ok: true, command: 'git', argv: ['ls-files'], inspectionClass: 'git-inspection' };
    case 'node_version':
      return { ok: true, command: process.execPath, argv: ['--version'], inspectionClass: 'env-info' };
    case 'npm_ls':
    case 'npm_outdated':
    case 'npm_view': {
      const npmCli = ctx.npmCliPath ?? path.join(ctx.root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (op.operation === 'npm_view') {
        const err = rejectFlagLike('package', op.package);
        if (err) return { ok: false, reason: err };
      }
      const sub =
        op.operation === 'npm_ls'
          ? ['ls', '--depth=0']
          : op.operation === 'npm_outdated'
            ? ['outdated']
            : ['view', op.package];
      return { ok: true, command: process.execPath, argv: [npmCli, ...sub], inspectionClass: 'env-info' };
    }
    case 'typecheck': {
      const project = path.resolve(ctx.cwd, op.project ?? 'tsconfig.json');
      const hash = createHash('sha256').update(project).digest('hex').slice(0, 16);
      const tsBuildInfoFile = path.join(os.tmpdir(), 'zelari-inspect', `${hash}.tsbuildinfo`);
      return {
        ok: true,
        command: process.execPath,
        argv: [
          ctx.tscPath ?? path.join(ctx.root, 'node_modules', 'typescript', 'bin', 'tsc'),
          '--noEmit',
          // S3.5 primary mechanism: redirect, never disable — composite forces
          // incremental (TS#30661), so --incremental false would break on the
          // very fixture it must support. The CLI override wins over any
          // tsBuildInfoFile written into the tsconfig.
          '--incremental',
          '--tsBuildInfoFile',
          tsBuildInfoFile,
          '-p',
          project,
        ],
        inspectionClass: 'project-code-execution',
        tsBuildInfoFile,
      };
    }
  }
}

export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/** Spawn WITHOUT a shell; kill on timeout/abort; never reject. */
export function runSpawn(
  command: string,
  argv: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, argv, { cwd: opts.cwd, shell: false });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), timedOut: false, spawnError: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      timedOut = true;
      child.kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function capOutput(stdout: string, stderr: string): { output: string; truncated: boolean } {
  const combined = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
  if (combined.length <= MAX_OUTPUT_CHARS) return { output: combined, truncated: false };
  return {
    output: `${combined.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated, ${combined.length} chars total)`,
    truncated: true,
  };
}

/** typecheck with the S3.5 pre/post artifact guard. */
async function typecheckGuarded(built: Extract<BuiltInspect, { ok: true }>, root: string, signal?: AbortSignal) {
  const pre = await fingerprintWorkspace(root);
  const r = await runSpawn(built.command, built.argv, { cwd: root, timeoutMs: TYPECHECK_TIMEOUT_MS, signal });
  if (r.spawnError) {
    return typedErr(`SPAWN_ERROR: typecheck could not launch: ${r.spawnError}`);
  }
  const { output, truncated } = capOutput(r.stdout, r.stderr);
  const refusal = r.code !== 0 ? classifyTypecheckRefusal(`${r.stdout}\n${r.stderr}`) : null;
  if (refusal) {
    return typedOk({
      status: 'unsupported_project_shape',
      operation: 'typecheck',
      inspectionClass: built.inspectionClass,
      reason: refusal,
      exitCode: r.code,
      output,
      truncated,
    });
  }
  const post = await fingerprintWorkspace(root);
  const delta = diffFingerprints(pre, post);
  if (delta.newTsbuildinfo.length > 0 || delta.gitStatusChanged) {
    const cleanup = await cleanupArtifacts(root, delta.newTsbuildinfo);
    return typedOk({
      status: 'degraded',
      operation: 'typecheck',
      inspectionClass: built.inspectionClass,
      exitCode: r.code,
      output,
      truncated,
      artifactsWritten: delta.newTsbuildinfo,
      gitStatusChanged: delta.gitStatusChanged,
      cleanedUp: cleanup.cleaned,
      cleanupFailed: cleanup.failed,
      note:
        'UNEXPECTED WORKSPACE ARTIFACTS: the typecheck wrote build artifacts into the workspace ' +
        'despite the tsbuildinfo redirect. This result is NOT a clean observation — treat the ' +
        'typecheck verdict as unreliable until the artifact leak is understood. ' +
        `${cleanup.cleaned.length} artifact(s) removed, ${cleanup.failed.length} could not be removed.`,
    });
  }
  return typedOk({
    status: 'ok',
    operation: 'typecheck',
    inspectionClass: built.inspectionClass,
    exitCode: r.code,
    output,
    truncated,
    note:
      r.code === 0
        ? 'compiler completed with no diagnostics; tsbuildinfo was redirected to the OS temp dir — the workspace is untouched (verified by pre/post fingerprint)'
        : `compiler exited ${r.code} — diagnostics above are real type errors (a successful, scoped observation: the run itself worked and wrote nothing to the workspace)`,
  });
}

/**
 * Create the `inspect_command` tool bound to a workspace root. Registration is
 * the registry's job (readOnly/plan/explore only — full/verify keep `bash`).
 */
export function createInspectCommandTool(rootOrDeps: string | { root: string; tscPath?: string; npmCliPath?: string }): ToolDefinition {
  const deps = typeof rootOrDeps === 'string' ? { root: rootOrDeps } : rootOrDeps;
  const tool: ToolDefinition = {
    name: 'inspect_command',
    description:
      'Allowlisted read-only command inspector for plan/read-only sessions (no shell, no mutations). ' +
      'Pick an operation instead of writing a command: git_status, git_log, git_diff, git_show, ' +
      'git_branch_current, git_ls_files, typecheck, node_version, npm_ls, npm_outdated, npm_view. ' +
      'typecheck runs the project TypeScript compiler with --noEmit and a temp-dir tsbuildinfo ' +
      'redirect, verified by a pre/post workspace fingerprint (inspectionClass: ' +
      "'project-code-execution' — you are executing the project's own toolchain, not reading git).",
    permissions: ['read'],
    timeoutMs: 90_000,
    inputSchema: inspectInputSchema,
    execute: async (input, ctx) => {
      const op = input as InspectOperation;
      const cwd = ctx?.cwd ?? deps.root;
      const built = buildInspectCommand(op, { root: deps.root, cwd, tscPath: deps.tscPath, npmCliPath: deps.npmCliPath });
      if (!built.ok) return typedErr(`INVALID_ARGUMENT: ${built.reason}`);
      if (op.operation === 'typecheck') {
        const tsc = built.argv[0];
        try {
          await fs.access(tsc);
        } catch {
          return typedErr(
            `TYPESCRIPT_UNAVAILABLE: no TypeScript compiler at ${tsc} — inspect_command typecheck ` +
              'uses the project toolchain (node <root>/node_modules/typescript/bin/tsc) and refuses to ' +
              'guess. Install dependencies or fall back to read_file/grep_content.',
          );
        }
        return typecheckGuarded(built, deps.root, ctx?.signal);
      }
      const r = await runSpawn(built.command, built.argv, { cwd, timeoutMs: SPAWN_TIMEOUT_MS, signal: ctx?.signal });
      if (r.spawnError) return typedErr(`SPAWN_ERROR: ${op.operation} could not launch: ${r.spawnError}`);
      const { output, truncated } = capOutput(r.stdout, r.stderr);
      return typedOk({
        status: r.timedOut ? 'timeout' : 'ok',
        operation: op.operation,
        inspectionClass: built.inspectionClass,
        exitCode: r.code,
        output,
        truncated,
        ...(r.timedOut ? { note: `command timed out after ${SPAWN_TIMEOUT_MS} ms` } : {}),
      });
    },
  };
  return tool;
}
