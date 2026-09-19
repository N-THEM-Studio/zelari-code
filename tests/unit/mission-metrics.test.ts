/**
 * mission-metrics.mjs — guard tests (piano 2.37-NEXT §Fase M2, M2.3/M2.4).
 *
 * The script is the RC measurement instrument for the mission budget
 * ceilings: it must read .zelari/mission-state.json telemetry
 * (cumulativeTokens / cumulativeCostUsd / repairHistory window) and apply
 * the CANONICAL ceiling semantics of the loop (zelariMission.ts env
 * resolvers): unset ceiling = off, and M2.4 says a DEFINED ceiling with a
 * null measurement is NOT certifiable (unknown ≠ pass). These tests pin
 * exit 0 within ceilings, exit 2 on breach / not-certifiable, exit 1 on
 * missing or invalid state. Everything runs on temp fixtures — no mission,
 * no LLM, no network.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = path.join(repoRoot, 'scripts', 'mission-metrics.mjs');
const tmpDirs: string[] = [];

function run(args: string[], env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function fixture(state: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-mission-metrics-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.zelari'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.zelari', 'mission-state.json'),
    JSON.stringify(
      {
        missionId: 'm-test',
        status: 'success',
        iteration: 4,
        cumulativeTokens: 123456,
        cumulativeCostUsd: 1.25,
        repairHistory: [
          { gapKey: 'gap-a', outcome: 'improved' },
          { gapKey: 'gap-a', outcome: 'unchanged' },
        ],
        trace: [{}, {}, {}],
        ...state,
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe('mission-metrics — report mode', () => {
  it('within ceilings → exit 0 with the telemetry on stdout', () => {
    const dir = fixture({});
    const r = run(['--dir', dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('m-test (success)');
    expect(r.stdout).toContain('123456 (ceiling: off)');
    expect(r.stdout).toContain('1.25 (ceiling: off)');
    expect(r.stdout).toContain('VERDICT: within every defined ceiling');
  });

  it('--json emits exact numbers (window, distinct gaps, unchanged, budget)', () => {
    const dir = fixture({});
    const r = run(['--dir', dir, '--json']);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(true);
    expect(report.tokens).toBe(123456);
    expect(report.costUsd).toBe(1.25);
    expect(report.repairs).toEqual({ window: 2, distinctGaps: 1, unchanged: 1 });
    expect(report.iterationBudget).toEqual({ used: 4, max: 6 });
    expect(report.ceilings).toEqual({ tokens: undefined, costUsd: undefined, repairs: undefined });
    expect(report.breaches).toEqual([]);
  });
});

describe('mission-metrics — ceiling gates', () => {
  it('tokens over ZELARI_MISSION_MAX_TOKENS → exit 2 naming the breach', () => {
    const dir = fixture({});
    const r = run(['--dir', dir], { ZELARI_MISSION_MAX_TOKENS: '50000' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('tokens: 123456 > ceiling 50000');
    expect(r.stdout).toContain('VERDICT: BREACH');
  });

  it('tokens:null with a defined ceiling → exit 2 not certifiable (M2.4: unknown ≠ pass)', () => {
    const dir = fixture({ cumulativeTokens: undefined });
    const r = run(['--dir', dir], { ZELARI_MISSION_MAX_TOKENS: '50000' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not certifiable');
  });

  it('--max-repairs over the repair window → exit 2', () => {
    const dir = fixture({});
    const r = run(['--dir', dir, '--max-repairs', '1']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('repairs: window 2 > ceiling 1');
  });
});

describe('mission-metrics — input honesty', () => {
  it('missing state file → exit 1; invalid JSON → exit 1', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-mission-metrics-'));
    tmpDirs.push(empty);
    expect(run(['--dir', empty]).status).toBe(1);

    const broken = fixture({});
    fs.writeFileSync(path.join(broken, '.zelari', 'mission-state.json'), '{ not json', 'utf8');
    expect(run(['--dir', broken]).status).toBe(1);
  });
});
