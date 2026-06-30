import { z } from 'zod';
import { spawn } from 'node:child_process';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';

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
}

export const bashTool: ToolDefinition<BashArgs, BashResult> = {
  name: 'bash',
  description: 'Run a shell command. Streams stdout/stderr. Respects timeout and cancellation. Returns exit code.',
  permissions: ['execute'],
  timeoutMs: 60000,
  inputSchema: BashArgsSchema,
  execute: async (args, ctx) => {
    return new Promise((resolve) => {
      const start = Date.now();
      const cwd = args.cwd ?? ctx.cwd;
      const child = spawn(args.command, { shell: true, cwd, signal: ctx.signal });
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
        resolve(typedOk({
          stdout: stdout.slice(0, maxBuffer),
          stderr: stderr.slice(0, maxBuffer),
          exitCode: code ?? -1,
          durationMs: Date.now() - start,
        }));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(typedErr(err.message));
      });
    });
  },
};
