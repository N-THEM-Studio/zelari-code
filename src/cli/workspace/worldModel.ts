/**
 * worldModel — Schema-inspired lightweight task world model (P0/P1).
 *
 * Persists under `<cwd>/.zelari/world/`:
 *   hypothesis.md   — working theory (notes.md analogue)
 *   checks.json     — certifiable checks for run_backtest
 *   timeline.jsonl  — append-only observations (optional ground truth)
 *
 * Kill switch: ZELARI_SCHEMA_LOOP=0 disables tool registration.
 *
 * Inspired by https://schema-harness.github.io/ — adapted for coding agents
 * (no ARC grid; certify via shell checks + hypothesis files).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  typedOk,
  typedErr,
  type ToolDefinition,
} from '@zelari/core/harness/tools/toolTypes';

export const WORLD_DIR_NAME = path.join('.zelari', 'world');
export const HYPOTHESIS_FILE = 'hypothesis.md';
export const CHECKS_FILE = 'checks.json';
export const TIMELINE_FILE = 'timeline.jsonl';

export interface WorldCheck {
  /** Stable id for reports. */
  id: string;
  /** Shell command relative to project root (cmd/sh). */
  command: string;
  /** Expected exit code (default 0). */
  expectExit?: number;
  /** Optional substring that must appear in combined stdout+stderr. */
  expectStdoutIncludes?: string;
  /** Soft timeout ms (default 120_000). */
  timeoutMs?: number;
}

export interface WorldChecksFile {
  checks: WorldCheck[];
}

export interface BacktestCheckResult {
  id: string;
  command: string;
  ok: boolean;
  exitCode: number;
  expectExit: number;
  durationMs: number;
  stdoutPreview: string;
  mismatch?: string;
}

export interface BacktestResult {
  ok: boolean;
  passed: number;
  failed: number;
  total: number;
  results: BacktestCheckResult[];
  hypothesisPath: string;
  checksPath: string;
}

function worldDir(cwd: string): string {
  return path.join(cwd, WORLD_DIR_NAME);
}

async function ensureWorldDir(cwd: string): Promise<string> {
  const dir = worldDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function appendTimeline(
  cwd: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const dir = await ensureWorldDir(cwd);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await fs.appendFile(path.join(dir, TIMELINE_FILE), line, 'utf8');
}

async function readChecks(cwd: string): Promise<WorldCheck[]> {
  const p = path.join(worldDir(cwd), CHECKS_FILE);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as WorldChecksFile;
    return Array.isArray(parsed.checks) ? parsed.checks : [];
  } catch {
    return [];
  }
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/c', command] : ['-c', command], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish(124);
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        clearTimeout(timer);
        finish(130);
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          clearTimeout(timer);
          finish(130);
        },
        { once: true },
      );
    }
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      if (stdout.length > 32_000) stdout = stdout.slice(0, 32_000);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > 32_000) stderr = stderr.slice(0, 32_000);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

export async function runBacktest(
  cwd: string,
  signal?: AbortSignal,
): Promise<BacktestResult> {
  const checksPath = path.join(worldDir(cwd), CHECKS_FILE);
  const hypothesisPath = path.join(worldDir(cwd), HYPOTHESIS_FILE);
  const checks = await readChecks(cwd);
  if (checks.length === 0) {
    return {
      ok: false,
      passed: 0,
      failed: 0,
      total: 0,
      results: [],
      hypothesisPath,
      checksPath,
    };
  }
  const results: BacktestCheckResult[] = [];
  for (const c of checks) {
    const expectExit = c.expectExit ?? 0;
    const timeoutMs = c.timeoutMs ?? 120_000;
    const start = Date.now();
    const { exitCode, stdout, stderr } = await runShell(c.command, cwd, timeoutMs, signal);
    const combined = `${stdout}${stderr}`;
    const preview = combined.slice(0, 400);
    let ok = exitCode === expectExit;
    let mismatch: string | undefined;
    if (!ok) {
      mismatch = `exit ${exitCode} (expected ${expectExit})`;
    } else if (c.expectStdoutIncludes && !combined.includes(c.expectStdoutIncludes)) {
      ok = false;
      mismatch = `stdout missing substring: ${c.expectStdoutIncludes}`;
    }
    results.push({
      id: c.id,
      command: c.command,
      ok,
      exitCode,
      expectExit,
      durationMs: Date.now() - start,
      stdoutPreview: preview,
      ...(mismatch ? { mismatch } : {}),
    });
  }
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const summary: BacktestResult = {
    ok: failed === 0 && results.length > 0,
    passed,
    failed,
    total: results.length,
    results,
    hypothesisPath,
    checksPath,
  };
  await appendTimeline(cwd, { kind: 'backtest', ok: summary.ok, passed, failed, total: results.length });
  return summary;
}

// ─── Tools ─────────────────────────────────────────────────────────────

const UpdateHypothesisSchema = z.object({
  content: z.string().min(1).describe('Full markdown hypothesis / working notes (replaces file).'),
  append: z
    .boolean()
    .optional()
    .describe('If true, append content under a timestamp instead of replacing.'),
});

export const updateWorldHypothesisTool: ToolDefinition<
  z.infer<typeof UpdateHypothesisSchema>,
  { path: string; bytes: number }
> = {
  name: 'update_world_hypothesis',
  description:
    'Write or append the task world-model hypothesis (Schema-style notes.md) to ' +
    '.zelari/world/hypothesis.md. Use this to record what you believe is true ' +
    'about the bug/system, competing hypotheses, and what experiment would discriminate them. ' +
    'Do NOT claim work is done until run_backtest is green.',
  permissions: ['write'],
  timeoutMs: 10_000,
  inputSchema: UpdateHypothesisSchema,
  execute: async (args, ctx) => {
    try {
      const dir = await ensureWorldDir(ctx.cwd);
      const file = path.join(dir, HYPOTHESIS_FILE);
      if (args.append) {
        const block = `\n\n## ${new Date().toISOString()}\n\n${args.content}\n`;
        await fs.appendFile(file, block, 'utf8');
      } else {
        await fs.writeFile(file, args.content, 'utf8');
      }
      const st = await fs.stat(file);
      await appendTimeline(ctx.cwd, { kind: 'hypothesis_update', bytes: st.size, append: !!args.append });
      return typedOk({ path: file, bytes: st.size });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};

const WorldCheckSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  expectExit: z.number().int().optional(),
  expectStdoutIncludes: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

const SetChecksSchema = z.object({
  checks: z
    .array(WorldCheckSchema)
    .min(1)
    .describe('List of certifiable shell checks (typecheck, unit tests, smoke scripts).'),
});

export const setWorldChecksTool: ToolDefinition<
  z.infer<typeof SetChecksSchema>,
  { path: string; count: number }
> = {
  name: 'set_world_checks',
  description:
    'Replace .zelari/world/checks.json with certifiable checks used by run_backtest. ' +
    'Each check is a shell command + expected exit code (default 0). Prefer fast, ' +
    'deterministic commands (npm run typecheck, npx vitest run path/to/file).',
  permissions: ['write'],
  timeoutMs: 10_000,
  inputSchema: SetChecksSchema,
  execute: async (args, ctx) => {
    try {
      const dir = await ensureWorldDir(ctx.cwd);
      const file = path.join(dir, CHECKS_FILE);
      const body: WorldChecksFile = { checks: args.checks };
      await fs.writeFile(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
      await appendTimeline(ctx.cwd, { kind: 'checks_set', count: args.checks.length });
      return typedOk({ path: file, count: args.checks.length });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};

const RunBacktestSchema = z.object({
  /** Reserved for future selective runs. */
  dryRun: z.boolean().optional(),
});

export const runBacktestTool: ToolDefinition<
  z.infer<typeof RunBacktestSchema>,
  BacktestResult
> = {
  name: 'run_backtest',
  description:
    'Schema-style certify: run every check in .zelari/world/checks.json and report ' +
    'exact pass/fail (exit code + optional stdout substring). Appends a timeline entry. ' +
    'If total=0, call set_world_checks first. NEVER claim the task is done when ok=false. ' +
    'On mismatch, revise hypothesis (update_world_hypothesis) and the implementation, then re-run.',
  permissions: ['execute'],
  timeoutMs: 600_000,
  inputSchema: RunBacktestSchema,
  execute: async (args, ctx) => {
    try {
      if (args.dryRun) {
        const checks = await readChecks(ctx.cwd);
        return typedOk({
          ok: false,
          passed: 0,
          failed: 0,
          total: checks.length,
          results: checks.map((c) => ({
            id: c.id,
            command: c.command,
            ok: false,
            exitCode: -1,
            expectExit: c.expectExit ?? 0,
            durationMs: 0,
            stdoutPreview: '(dryRun)',
            mismatch: 'dryRun',
          })),
          hypothesisPath: path.join(worldDir(ctx.cwd), HYPOTHESIS_FILE),
          checksPath: path.join(worldDir(ctx.cwd), CHECKS_FILE),
        });
      }
      const result = await runBacktest(ctx.cwd, ctx.signal);
      return typedOk(result);
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};

const RecordObsSchema = z.object({
  kind: z.string().min(1).describe('Observation kind, e.g. surprise, probe, prediction_mismatch.'),
  summary: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const recordWorldObservationTool: ToolDefinition<
  z.infer<typeof RecordObsSchema>,
  { path: string }
> = {
  name: 'record_world_observation',
  description:
    'Append one ground-truth observation to .zelari/world/timeline.jsonl (Schema timeline). ' +
    'Use after a surprising tool result (prediction mismatch, unexpected exit code, wrong path) ' +
    'so later deliberation cannot rewrite history.',
  permissions: ['write'],
  timeoutMs: 5_000,
  inputSchema: RecordObsSchema,
  execute: async (args, ctx) => {
    try {
      const dir = await ensureWorldDir(ctx.cwd);
      const file = path.join(dir, TIMELINE_FILE);
      await appendTimeline(ctx.cwd, {
        kind: args.kind,
        summary: args.summary,
        ...(args.data ? { data: args.data } : {}),
      });
      return typedOk({ path: file });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};

/** All world-model tools (omit when ZELARI_SCHEMA_LOOP=0). */
export function createWorldModelTools(): Array<ToolDefinition<Record<string, unknown>, unknown>> {
  if (process.env['ZELARI_SCHEMA_LOOP'] === '0') return [];
  // Cast: ToolDefinition is invariant on input; registry accepts heterogeneous tools.
  return [
    updateWorldHypothesisTool,
    setWorldChecksTool,
    runBacktestTool,
    recordWorldObservationTool,
  ] as Array<ToolDefinition<Record<string, unknown>, unknown>>;
}
