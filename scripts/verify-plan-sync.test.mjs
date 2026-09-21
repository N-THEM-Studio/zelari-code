/**
 * scripts/verify-plan-sync.test.mjs — t161, deterministic half.
 *
 * The gate must NEVER fake green: only a commit↔task pair whose task is
 * `pending`/`in_progress`/`blocked` may turn it red, an unknown id must be
 * ignored, a missing ledger is a SKIP (never a pass claim) and a corrupt ledger
 * is exit 2. Every CLI scenario runs against a throwaway git repo in
 * os.tmpdir(), so nothing is written inside the product tree and the real
 * `.zelari/plan.json` (gitignored, absent in worktrees) is never read.
 *
 * Same harness as scripts/dogfood-audit.test.ts: mkdtemp + local user config.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  auditPlanSync,
  collectPlanTasks,
  extractTaskRefs,
  readPlan,
  resolveRange,
} from './verify-plan-sync.mjs';

const SCRIPT = fileURLToPath(new URL('./verify-plan-sync.mjs', import.meta.url));
const repos = [];

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A plan document in the ADR-0018 envelope. */
function planDoc(rows) {
  return { schemaVersion: 1, counter: rows.length, tasks: rows };
}

/**
 * Throwaway repo with an optional `.zelari/plan.json` and one commit per
 * message (each commit touches its own file, so subjects stay unique).
 */
function makeRepo(rows, messages) {
  const dir = mkdtempSync(path.join(tmpdir(), 'zelari-plan-sync-'));
  repos.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'plan-sync@example.invalid']);
  git(dir, ['config', 'user.name', 'plan-sync test']);
  if (rows) {
    mkdirSync(path.join(dir, '.zelari'), { recursive: true });
    writeFileSync(
      path.join(dir, '.zelari', 'plan.json'),
      JSON.stringify(planDoc(rows), null, 2) + '\n',
      'utf8',
    );
  }
  for (const [i, message] of messages.entries()) {
    writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`, 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
  }
  return dir;
}

function run(dir, args = []) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('verify-plan-sync CLI (throwaway git repo)', () => {
  it('passes when every referenced task is closed', () => {
    const dir = makeRepo([{ id: 't10', status: 'completed' }], ['feat: thing (t10)']);
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('1 commits scanned, 1 task refs, 0 pending');
    expect(res.stdout).toContain('PASS');
  });

  it('fails on a pending task and prints the sha+subject → id (status) pair', () => {
    const dir = makeRepo([{ id: 't10', status: 'pending' }], ['feat: thing (t10)']);
    const sha = git(dir, ['rev-parse', 'HEAD']).trim().slice(0, 7);
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(`${sha} "feat: thing (t10)" → t10 (pending)`);
    expect(res.stdout).toContain('1 commits scanned, 1 task refs, 1 pending');
    expect(res.stderr).toContain('task_update in the same turn as the commit');
  });

  it('fails on in_progress and blocked too, and scans the commit BODY', () => {
    const dir = makeRepo(
      [
        { id: 't10', status: 'in_progress' },
        { id: 't11', status: 'blocked' },
      ],
      ['feat: one', 'feat: two\n\nnotes: t11 is still waiting, t10 in flight'],
    );
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('→ t11 (blocked)');
    expect(res.stdout).toContain('→ t10 (in_progress)');
    expect(res.stdout).toContain('2 pending');
  });

  it('ignores ids that do not exist in the ledger (anti-false-positive)', () => {
    const dir = makeRepo(
      [{ id: 't10', status: 'completed' }],
      ['chore: t2 prose and t999 noise, real ref t10'],
    );
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('1 commits scanned, 1 task refs, 0 pending');
    expect(res.stdout).toContain('2 id(s) in the range are not in the ledger');
  });

  it('skips (exit 0, never PASS) when plan.json is absent', () => {
    const dir = makeRepo(null, ['feat: thing (t10)']);
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('skip: no plan.json (clean checkout)');
    expect(res.stdout).toContain('skipped, not verified');
    expect(res.stdout).not.toContain('PASS');
  });

  it('skips (exit 0) when --plan points at a nonexistent file', () => {
    const dir = makeRepo(null, ['feat: thing (t10)']);
    const res = run(dir, ['--plan', path.join(dir, 'nope.json')]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('skip: no plan.json');
  });

  it('exits 2 on a corrupt ledger — an unreadable plan is never green', () => {
    const dir = makeRepo(null, ['feat: thing (t10)']);
    mkdirSync(path.join(dir, '.zelari'), { recursive: true });
    writeFileSync(path.join(dir, '.zelari', 'plan.json'), '{ not json', 'utf8');
    const res = run(dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('INSUFFICIENT-DATA');
    expect(res.stdout).not.toContain('PASS');
  });

  it('--range narrows the scan (a pending ref outside the range is not drift)', () => {
    const dir = makeRepo(
      [
        { id: 't10', status: 'pending' },
        { id: 't11', status: 'completed' },
      ],
      ['feat: one (t10)', 'feat: two (t11)'],
    );
    expect(run(dir).status).toBe(1); // untagged repo: last 30 commits, both in range
    const narrowed = run(dir, ['--range', 'HEAD~1..HEAD']);
    expect(narrowed.status).toBe(0);
    expect(narrowed.stdout).toContain('1 commits scanned');
  });

  it('rejects an unknown flag with exit 2 and a usage line', () => {
    const dir = makeRepo([{ id: 't10', status: 'completed' }], ['feat: thing (t10)']);
    const res = run(dir, ['--bogus']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('unknown argument "--bogus"');
    expect(res.stderr).toContain('usage: node scripts/verify-plan-sync.mjs');
  });
});

describe('verify-plan-sync core (pure)', () => {
  it('extracts lowercase t-refs only, de-duplicated and in order', () => {
    expect(extractTaskRefs('merge t160 and (t161), t160 again')).toEqual(['t160', 't161']);
    expect(extractTaskRefs('T164 t1 t12345 next12')).toEqual(['t1']);
    expect(extractTaskRefs('')).toEqual([]);
  });

  it('maps statuses to the exit-code contract', () => {
    const commit = (sha, subject) => ({ sha, subject, body: '' });
    const commits = [commit('a'.repeat(40), 'feat: x (t1)')];
    const tasks = (v) => new Map([['t1', v]]);
    expect(auditPlanSync({ commits, tasks: null }).exitCode).toBe(0);
    expect(auditPlanSync({ commits, tasks: null }).status).toBe('skip');
    expect(auditPlanSync({ commits, tasks: tasks('completed') }).exitCode).toBe(0);
    expect(auditPlanSync({ commits, tasks: tasks('cancelled') }).exitCode).toBe(0);
    expect(auditPlanSync({ commits, tasks: tasks('pending') }).exitCode).toBe(1);
    expect(auditPlanSync({ commits, tasks: tasks('blocked') }).blocked).toHaveLength(1);
    // Fail-open on vocabulary we do not own: unknown status is not drift.
    expect(auditPlanSync({ commits, tasks: tasks('archived') }).exitCode).toBe(0);
  });

  it('normalizes the ADR-0018 envelope and the legacy phased layout', () => {
    expect(collectPlanTasks(planDoc([{ id: 't1', status: 'pending' }]))).toEqual(
      new Map([['t1', 'pending']]),
    );
    expect(
      collectPlanTasks({ phases: [{ tasks: [{ id: 't2', done: true }, { id: 't3', status: 'blocked' }] }] }),
    ).toEqual(
      new Map([
        ['t2', 'completed'],
        ['t3', 'blocked'],
      ]),
    );
    expect(collectPlanTasks({})).toBeNull();
  });

  it('readPlan separates absent (skip) from unreadable (error)', () => {
    const dir = makeRepo([{ id: 't10', status: 'completed' }], ['feat: thing (t10)']);
    expect(readPlan(path.join(dir, '.zelari', 'plan.json')).status).toBe('ok');
    expect(readPlan(path.join(dir, 'absent.json')).status).toBe('missing');
  });

  it('resolveRange prefers the last annotated tag and falls back to 30 commits', () => {
    const tagged = makeRepo([{ id: 't10', status: 'completed' }], ['feat: thing (t10)']);
    git(tagged, ['tag', '-a', 'v9.9.9', '-m', 'release 9.9.9']);
    expect(resolveRange(null, tagged).label).toBe('v9.9.9..HEAD');
    const untagged = makeRepo([{ id: 't10', status: 'completed' }], ['feat: thing (t10)']);
    expect(resolveRange(null, untagged).range).toBeNull();
    expect(resolveRange('main..HEAD', untagged).label).toBe('main..HEAD');
  });
});
