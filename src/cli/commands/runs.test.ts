/**
 * commands/runs.test.ts — K5.1/F31: `zelari-code runs list|show`.
 *
 * Red-if-reopens: F31 was "run records written (`.zelari/runs/`) but NO
 * reader exists". The fixtures below are real RunRecorder-shaped directories
 * (manifest.json + metrics.json + trace.jsonl + agents/*.jsonl); if the reader
 * regresses to unreadable, these tests fail first.
 *
 * Locks:
 * - list: newest-first, human + --json, corrupt manifest SKIPPED (never fatal);
 * - show: manifest + metrics + trace/agent counts, human + --json;
 * - unknown/missing run id ⇒ exit 1 with a clear stderr line, empty stdout;
 * - missing runs dir ⇒ empty list, exit 0 (not an error).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  listRunRecords,
  parseRunsFlags,
  resolveRunsDir,
  runRunsCommand,
  type RunManifestLike,
  type RunRecord,
} from './runs.js';

function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const outSpy = { write: (s: string) => ((stdout += s), true) };
  const errSpy = { write: (s: string) => ((stderr += s), true) };
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = outSpy.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = errSpy.write;
  return fn()
    .then((code) => ({ code, stdout, stderr }))
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    });
}

async function writeRun(
  runsDir: string,
  runId: string,
  manifest: RunManifestLike | string,
  extra: { metrics?: unknown; traceLines?: number; agents?: Record<string, number> } = {},
): Promise<void> {
  const dir = path.join(runsDir, runId);
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
    'utf8',
  );
  if (extra.metrics !== undefined) {
    await fs.writeFile(path.join(dir, 'metrics.json'), JSON.stringify(extra.metrics, null, 2), 'utf8');
  }
  const trace = Array.from({ length: extra.traceLines ?? 0 }, (_, i) => JSON.stringify({ type: 'tick', i })).join('\n');
  if (trace) await fs.writeFile(path.join(dir, 'trace.jsonl'), `${trace}\n`, 'utf8');
  for (const [id, events] of Object.entries(extra.agents ?? {})) {
    const body = Array.from({ length: events }, (_, i) => JSON.stringify({ type: 'agent_tick', i })).join('\n');
    await fs.writeFile(path.join(dir, 'agents', `${id}.jsonl`), `${body}\n`, 'utf8');
  }
}

describe('zelari-code runs (K5.1/F31)', () => {
  let root: string;
  let runsDir: string;

  beforeEach(async () => {
    root = path.join(tmpdir(), `runs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    runsDir = resolveRunsDir(root);
    await writeRun(
      runsDir,
      'run_b_new',
      { version: 1, runId: 'run_b_new', mode: 'kraken', phase: 'build', startedAt: 2000, status: 'running', cwd: root, models: { general: 'm1' } },
      { traceLines: 2, agents: { t1: 2 } },
    );
    await writeRun(
      runsDir,
      'run_a_old',
      {
        version: 1, runId: 'run_a_old', sessionId: 'sess-1', mode: 'kraken', phase: 'build',
        startedAt: 1000, endedAt: 1500, status: 'completed', cwd: root,
        models: { general: 'm1', verify: 'm2' },
      },
      { metrics: { durationMs: 500, modelCalls: 3, toolCalls: 12, toolFailures: 1, turns: 2 }, traceLines: 3, agents: { t1: 1 } },
    );
    await writeRun(runsDir, 'run_c_corrupt', '{ not json!!!', {});
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('list: newest first, corrupt manifest skipped (reported, never fatal)', async () => {
    const { records, skipped } = await listRunRecords(runsDir);
    expect(records.map((r) => r.runId)).toEqual(['run_b_new', 'run_a_old']);
    expect(skipped).toEqual(['run_c_corrupt']);
  });

  it('list (human): exit 0 with statuses and the skip warning', async () => {
    const { code, stdout, stderr } = await capture(() => runRunsCommand(['runs', 'list', '--cwd', root]));
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('run_b_new');
    expect(stdout).toContain('status=running');
    expect(stdout).toContain('run_a_old');
    expect(stdout).toContain('status=completed');
    expect(stdout.indexOf('run_b_new')).toBeLessThan(stdout.indexOf('run_a_old'));
    expect(stdout).toContain('skipped run_c_corrupt (unreadable manifest)');
  });

  it('list --json: machine-readable records + skipped ids', async () => {
    const { code, stdout } = await capture(() => runRunsCommand(['runs', 'list', '--json', '--cwd', root]));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { runs: RunRecord[]; skipped: string[] };
    expect(parsed.runs.map((r) => r.runId)).toEqual(['run_b_new', 'run_a_old']);
    expect(parsed.skipped).toEqual(['run_c_corrupt']);
    expect(parsed.runs[1]?.metrics?.toolFailures).toBe(1);
  });

  it('show (human): manifest + metrics + trace/agent counts', async () => {
    const { code, stdout } = await capture(() => runRunsCommand(['runs', 'show', 'run_a_old', '--cwd', root]));
    expect(code).toBe(0);
    expect(stdout).toContain('run run_a_old  status=completed');
    expect(stdout).toContain('session    sess-1');
    expect(stdout).toContain('modelCalls=3 toolCalls=12 toolFailures=1 turns=2');
    expect(stdout).toContain('trace      3 events');
    expect(stdout).toContain('t1 (1)');
  });

  it('show --json: parseable record + extras', async () => {
    const { code, stdout } = await capture(() => runRunsCommand(['runs', 'show', 'run_b_new', '--json', '--cwd', root]));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { run: RunRecord; traceEvents: number; agents: { id: string; events: number }[] };
    expect(parsed.run.manifest?.status).toBe('running');
    expect(parsed.run.metrics).toBeNull(); // not finalized
    expect(parsed.traceEvents).toBe(2);
    expect(parsed.agents).toEqual([{ id: 't1', events: 2 }]);
  });

  it('show: unknown run id ⇒ exit 1, clear stderr, empty stdout', async () => {
    const { code, stdout, stderr } = await capture(() => runRunsCommand(['runs', 'show', 'nope', '--cwd', root]));
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('run not found: nope\n');
  });

  it('show without run id ⇒ exit 1 with usage (no stack)', async () => {
    const { code, stderr } = await capture(() => runRunsCommand(['runs', 'show', '--cwd', root]));
    expect(code).toBe(1);
    expect(stderr).toBe('usage: zelari-code runs show <run-id>\n');
  });

  it('missing runs dir ⇒ empty list, exit 0 (not an error)', async () => {
    const emptyRoot = path.join(root, 'empty');
    const { code, stdout } = await capture(() => runRunsCommand(['runs', 'list', '--cwd', emptyRoot]));
    expect(code).toBe(0);
    expect(stdout).toContain('no runs recorded');
  });

  it('--help exits 0 and documents the subcommands', async () => {
    const { code, stdout } = await capture(() => runRunsCommand(['runs', '--help']));
    expect(code).toBe(0);
    expect(stdout).toContain('zelari-code runs list');
    expect(stdout).toContain('zelari-code runs show <run-id>');
  });

  it('parseRunsFlags: rejects unknown subcommand and bad --limit', () => {
    expect(parseRunsFlags(['runs', 'frobnicate'])).toEqual({ error: "unknown subcommand 'frobnicate' (expected list, show or --help)" });
    expect(parseRunsFlags(['runs', 'list', '--limit', '0'])).toEqual({ error: '--limit requires a positive number' });
  });
});
