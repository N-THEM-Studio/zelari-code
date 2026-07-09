import { z } from 'zod';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';
import { resolveShell } from './shellResolver.js';

/**
 * Ensure the directory of the running node binary is on PATH so agent shell
 * commands (npm, tsc, node) resolve even when Git Bash inherits a thinner Path.
 */
function withNodeDirOnPath(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  try {
    const nodeDir = dirname(process.execPath);
    if (!nodeDir) return env;
    const sep = process.platform === 'win32' ? ';' : ':';
    const current = env.PATH ?? env.Path ?? '';
    const parts = current.split(sep).filter((p) => p.length > 0);
    const has = parts.some((p) => p.toLowerCase() === nodeDir.toLowerCase());
    if (!has) {
      env.PATH = `${nodeDir}${sep}${current}`;
    }
  } catch {
    // best-effort
  }
  return env;
}

const BashArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

type BashArgs = z.infer<typeof BashArgsSchema>;

interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** Which shell executed the command (v0.7.2), e.g. "bash (D:\\Git\\bin\\bash.exe)" or "cmd.exe". */
  shellVia: string;
  /**
   * Actionable hint injected when the output matches an interactive-prompt
   * cancellation (v0.7.3). Scaffolders built on prompts/@clack print
   * "Operation cancelled" and often exit 0, so the model sees a "success"
   * that did nothing and retries variants of the same command forever
   * (live test 2026-07-02: 6× `npm create vite` in a non-empty dir).
   */
  hint?: string;
}

/** Output signatures of an interactive prompt dying on our closed stdin. */
const INTERACTIVE_CANCEL_RE = /operation cancell?ed|stdin is not a tty|the input device is not a tty/i;

const INTERACTIVE_HINT =
  'This command tried to PROMPT for input, but stdin is closed (non-interactive shell). ' +
  'Do NOT retry it — every variant will be cancelled the same way. Instead: ' +
  'scaffold into a fresh EMPTY subdirectory (e.g. `npm create vite@latest scaffold-tmp -- --template react-ts`, ' +
  'then move its contents here with `mv`/`cp`), or write package.json, configs and sources directly ' +
  'with write_file and then run `npm install`.';

export const bashTool: ToolDefinition<BashArgs, BashResult> = {
  name: 'bash',
  description:
    'Run a shell command. On Windows uses Git Bash when available (POSIX semantics: ls, $VAR, && work); falls back to cmd.exe otherwise. Streams stdout/stderr. Respects timeout and cancellation. Returns exit code. ' +
    'stdin is CLOSED (non-interactive): any command that prompts for input will fail or be cancelled — always pass non-interactive flags (--yes, -y, --template), and if a scaffolder insists on prompting (e.g. create-vite in a non-empty directory), create the files manually with write_file instead.',
  permissions: ['execute'],
  timeoutMs: 60000,
  inputSchema: BashArgsSchema,
  execute: async (args, ctx) => {
    return new Promise((resolve) => {
      const start = Date.now();
      const cwd = args.cwd ?? ctx.cwd;
      const resolved = resolveShell();

      // win32 + real bash: spawn the binary directly with `-c` and shell:false
      // so there is no cmd.exe indirection (npm, &&, $VAR, ls all work because
      // Git Bash's PATH resolves shims and `-c` runs a true POSIX string).
      // POSIX / fallback: keep the historical `shell: true` (Node picks /bin/sh
      // on posix, cmd.exe on win32-fallback — already warned by the resolver).
      let child: ReturnType<typeof spawn>;
      // v0.7.3: CI=1 pushes well-behaved CLIs (npm, scaffolders, test runners)
      // into non-interactive mode; stdin 'ignore' makes the rest fail FAST
      // with EOF instead of hanging on a prompt until the timeout (live test:
      // `npm create vite` in a non-empty dir prompted → "Operation cancelled").
      const baseEnv = withNodeDirOnPath({
        ...process.env,
        CI: process.env.CI ?? '1',
      });
      const env = resolved.isBash
        ? { ...baseEnv, MSYSTEM: process.env.MSYSTEM ?? 'MINGW64' }
        : baseEnv;
      if (resolved.isBash) {
        child = spawn(resolved.shell as string, ['-c', args.command], {
          cwd,
          signal: ctx.signal,
          shell: false,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        child = spawn(args.command, {
          shell: resolved.shell,
          cwd,
          signal: ctx.signal,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }

      let stdout = '';
      let stderr = '';
      const maxBuffer = 1024 * 1024; // 1MB cap on each stream
      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < maxBuffer) stdout += data.toString('utf-8');
      });
      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < maxBuffer) stderr += data.toString('utf-8');
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve(typedErr(
          `Bash command timed out after ${args.timeoutMs}ms. ` +
          'If it was waiting for interactive input: stdin is closed — pass non-interactive flags or create the files directly instead of retrying.',
        ));
      }, args.timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        const cappedStdout = stdout.slice(0, maxBuffer);
        const cappedStderr = stderr.slice(0, maxBuffer);
        const interactive = INTERACTIVE_CANCEL_RE.test(cappedStdout) || INTERACTIVE_CANCEL_RE.test(cappedStderr);
        resolve(
          typedOk({
            stdout: cappedStdout,
            stderr: cappedStderr,
            exitCode: code ?? -1,
            durationMs: Date.now() - start,
            shellVia: resolved.via,
            ...(interactive ? { hint: INTERACTIVE_HINT } : {}),
          }),
        );
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(typedErr(err.message));
      });
    });
  },
};
