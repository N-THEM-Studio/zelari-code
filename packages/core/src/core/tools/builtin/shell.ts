import { z } from 'zod';
import { spawn } from 'node:child_process';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';
import { resolveShell } from './shellResolver.js';

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
}

export const bashTool: ToolDefinition<BashArgs, BashResult> = {
  name: 'bash',
  description:
    'Run a shell command. On Windows uses Git Bash when available (POSIX semantics: ls, $VAR, && work); falls back to cmd.exe otherwise. Streams stdout/stderr. Respects timeout and cancellation. Returns exit code.',
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
      const env = resolved.isBash
        ? { ...process.env, MSYSTEM: process.env.MSYSTEM ?? 'MINGW64' }
        : process.env;
      if (resolved.isBash) {
        child = spawn(resolved.shell as string, ['-c', args.command], {
          cwd,
          signal: ctx.signal,
          shell: false,
          env,
        });
      } else {
        child = spawn(args.command, { shell: resolved.shell, cwd, signal: ctx.signal, env });
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
        resolve(typedErr(`Bash command timed out after ${args.timeoutMs}ms`));
      }, args.timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(
          typedOk({
            stdout: stdout.slice(0, maxBuffer),
            stderr: stderr.slice(0, maxBuffer),
            exitCode: code ?? -1,
            durationMs: Date.now() - start,
            shellVia: resolved.via,
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
