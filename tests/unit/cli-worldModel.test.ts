/**
 * cli-worldModel.test.ts — Schema-inspired world model tools.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  updateWorldHypothesisTool,
  setWorldChecksTool,
  runBacktestTool,
  recordWorldObservationTool,
  createWorldModelTools,
  runBacktest,
  WORLD_DIR_NAME,
  HYPOTHESIS_FILE,
  CHECKS_FILE,
  TIMELINE_FILE,
} from '../../src/cli/workspace/worldModel.js';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: 'test',
    signal: new AbortController().signal,
    audit: () => {},
  };
}

describe('worldModel tools', () => {
  let dir: string;
  let prevSchema: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'world-'));
    prevSchema = process.env['ZELARI_SCHEMA_LOOP'];
    delete process.env['ZELARI_SCHEMA_LOOP'];
  });

  afterEach(() => {
    if (prevSchema === undefined) delete process.env['ZELARI_SCHEMA_LOOP'];
    else process.env['ZELARI_SCHEMA_LOOP'] = prevSchema;
    rmSync(dir, { recursive: true, force: true });
  });

  it('update_world_hypothesis writes hypothesis.md', async () => {
    const res = await updateWorldHypothesisTool.execute(
      { content: '# Theory\n\nThe bug is X.' },
      makeCtx(dir),
    );
    expect(res.ok).toBe(true);
    const p = join(dir, WORLD_DIR_NAME, HYPOTHESIS_FILE);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain('The bug is X');
  });

  it('set_world_checks + run_backtest certifies a green check', async () => {
    const set = await setWorldChecksTool.execute(
      {
        checks: [
          {
            id: 'echo-ok',
            // Portable: node is always available in this repo's test env.
            command: 'node -e "process.exit(0)"',
            expectExit: 0,
            timeoutMs: 10_000,
          },
        ],
      },
      makeCtx(dir),
    );
    expect(set.ok).toBe(true);

    const bt = await runBacktestTool.execute({}, makeCtx(dir));
    expect(bt.ok).toBe(true);
    if (bt.ok) {
      expect(bt.value.ok).toBe(true);
      expect(bt.value.passed).toBe(1);
      expect(bt.value.failed).toBe(0);
      expect(bt.value.total).toBe(1);
    }

    const timeline = join(dir, WORLD_DIR_NAME, TIMELINE_FILE);
    expect(existsSync(timeline)).toBe(true);
    expect(readFileSync(timeline, 'utf8')).toContain('"kind":"backtest"');
  });

  it('run_backtest reports red when expectExit mismatches', async () => {
    // Write a tiny script so quoting works the same on cmd.exe and POSIX shells.
    const { writeFileSync } = await import('node:fs');
    const failScript = join(dir, 'exit1.cjs');
    writeFileSync(failScript, 'process.exit(1);\n');
    await setWorldChecksTool.execute(
      {
        checks: [
          {
            id: 'fail',
            command: `node "${failScript}"`,
            expectExit: 0,
            timeoutMs: 10_000,
          },
        ],
      },
      makeCtx(dir),
    );
    const result = await runBacktest(dir);
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.mismatch).toMatch(/exit 1/);
  });

  it('run_backtest with no checks returns total=0 and ok=false', async () => {
    const result = await runBacktest(dir);
    expect(result.total).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('record_world_observation appends timeline', async () => {
    const res = await recordWorldObservationTool.execute(
      { kind: 'surprise', summary: 'cmd.exe rejected pwd' },
      makeCtx(dir),
    );
    expect(res.ok).toBe(true);
    const text = readFileSync(join(dir, WORLD_DIR_NAME, TIMELINE_FILE), 'utf8');
    expect(text).toContain('surprise');
    expect(text).toContain('cmd.exe');
  });

  it('createWorldModelTools empty when ZELARI_SCHEMA_LOOP=0', () => {
    process.env['ZELARI_SCHEMA_LOOP'] = '0';
    expect(createWorldModelTools()).toEqual([]);
  });

  it('createWorldModelTools registers four tools by default', () => {
    const tools = createWorldModelTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'record_world_observation',
      'run_backtest',
      'set_world_checks',
      'update_world_hypothesis',
    ]);
  });

  it('checks.json is written by set_world_checks', async () => {
    await setWorldChecksTool.execute(
      { checks: [{ id: 't', command: 'node -e "process.exit(0)"' }] },
      makeCtx(dir),
    );
    const raw = JSON.parse(readFileSync(join(dir, WORLD_DIR_NAME, CHECKS_FILE), 'utf8'));
    expect(raw.checks).toHaveLength(1);
    expect(raw.checks[0].id).toBe('t');
  });
});
