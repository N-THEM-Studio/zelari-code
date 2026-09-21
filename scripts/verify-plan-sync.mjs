#!/usr/bin/env node
/**
 * verify-plan-sync.mjs — mechanical commit ↔ plan ledger gate (t161).
 *
 * The drift this kills: work ships in a commit whose message says "(t164)" or
 * "merge t160" while `.zelari/plan.json` still lists that task as pending — the
 * "story says done, ledger says pending" mismatch that hit t153–t156 (work
 * committed, `task_update` forgotten). Prose cannot be audited; commit messages
 * and the durable task store are both machine-readable, so the mismatch is.
 *
 *   node scripts/verify-plan-sync.mjs [--range <git-range>] [--plan <path>]
 *
 * Range: last annotated tag..HEAD (`git describe --abbrev=0`), or the last 30
 *        commits when the repo carries no annotated tag; `--range` overrides
 *        both. Everything (git, the default plan path) resolves against cwd —
 *        npm runs legs at the package root.
 * Refs:  `\bt(\d{1,3})\b` over SUBJECT + BODY of every commit in range. Only
 *        ids that EXIST in the plan count, so prose like "t2 something" or a
 *        bare version string can never turn the gate red.
 *
 * Exit codes (the exit code IS the contract):
 *   0 PASS — no commit in range references a task that is still open;
 *            summary line: "N commits scanned, M task refs, 0 pending".
 *   0 SKIP — no plan.json (clean checkout / CI): nothing to compare. Printed as
 *            SKIP, never as PASS — a missing ledger is not evidence of sync.
 *   1 FAIL — a commit references a KNOWN task whose status is pending,
 *            in_progress or blocked; every offending commit↔task pair is
 *            printed with the remediation hint.
 *   2 USAGE/INSUFFICIENT-DATA — unknown flag, flag without value, unreadable
 *            plan.json (corrupt JSON) or an unusable git range. Never green:
 *            an unreadable ledger must not be mistaken for a synced one.
 *
 * A task in `completed`/`cancelled` is closed; any other vocabulary is reported
 * but never treated as drift (fail-open on statuses we do not own) — only the
 * three open statuses above can turn the gate red.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Default ledger location, relative to cwd (npm legs run at the package root). */
export const DEFAULT_PLAN = path.join('.zelari', 'plan.json');

/** Commits inspected when the repo has no annotated tag to anchor the range. */
export const FALLBACK_COMMITS = 30;

/** Statuses that mean "not closed yet": a commit referencing one is drift. */
export const OPEN_STATUSES = new Set(['pending', 'in_progress', 'blocked']);

/** Task-reference grammar: lowercase `t` + 1–3 digits (`t164`, `(t161)`). */
export const TASK_REF_SOURCE = '\\bt(\\d{1,3})\\b';

const FIELD = '\u001f';
const RECORD = '\u001e';

export function firstLine(err) {
  return String((err && err.message) || err).split('\n')[0];
}

/** Every task reference in a message, de-duplicated, in first-seen order. */
export function extractTaskRefs(text) {
  const found = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(new RegExp(TASK_REF_SOURCE, 'g'))) {
    const id = 't' + m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    found.push(id);
  }
  return found;
}

/**
 * Flatten a plan document into `Map<id, status>`. Accepts both the ADR-0018
 * envelope (`{ tasks: [...] }`) and the legacy council layout
 * (`phases[].tasks[]`, `done: true`) the CLI store normalizes on read.
 * Returns null for an empty/unknown document.
 */
export function collectPlanTasks(doc) {
  const rows = [
    ...(Array.isArray(doc?.tasks) ? doc.tasks : []),
    ...(Array.isArray(doc?.phases) ? doc.phases.flatMap((p) => (Array.isArray(p?.tasks) ? p.tasks : [])) : []),
  ];
  const tasks = new Map();
  for (const t of rows) {
    if (!t || typeof t.id !== 'string' || !t.id) continue;
    const status = typeof t.status === 'string' && t.status ? t.status : t.done === true ? 'completed' : undefined;
    if (status !== undefined) tasks.set(t.id, status);
  }
  return tasks.size > 0 ? tasks : null;
}

/**
 * Read the plan ledger. Distinguishes "absent" (a normal state: skip) from
 * "unreadable" (corrupt JSON: exit 2, never green).
 * @returns {{status:'ok',tasks:Map<string,string>,raw:object}|{status:'missing'}|{status:'error',message:string}}
 */
export function readPlan(planPath) {
  let text;
  try {
    text = readFileSync(planPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'error', message: firstLine(err) };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { status: 'error', message: 'invalid JSON (' + firstLine(err) + ')' };
  }
  const tasks = collectPlanTasks(doc);
  if (tasks === null) return { status: 'error', message: 'no tasks[] entries found' };
  return { status: 'ok', tasks, raw: doc };
}

function runGit(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (err) {
    return { ok: false, error: firstLine(err) };
  }
}

/** Last annotated tag..HEAD, or the last FALLBACK_COMMITS commits when untagged. */
export function resolveRange(requested, cwd = process.cwd()) {
  if (requested) return { range: requested, label: requested };
  const described = runGit(['describe', '--abbrev=0'], cwd);
  const tag = described.ok ? described.stdout.trim() : '';
  if (tag) return { range: tag + '..HEAD', label: tag + '..HEAD' };
  return { range: null, label: 'last ' + FALLBACK_COMMITS + ' commits (no annotated tag)' };
}

/** `git log` for the range, parsed into { sha, subject, body }; never throws. */
export function readCommits(range, cwd = process.cwd()) {
  const format = '--format=%H' + FIELD + '%s' + FIELD + '%b' + RECORD;
  const args = range
    ? ['log', format, range]
    : ['log', '-n', String(FALLBACK_COMMITS), format, 'HEAD'];
  const res = runGit(args, cwd);
  if (!res.ok) return { ok: false, error: res.error, commits: [] };
  const commits = res.stdout
    .split(RECORD)
    .map((chunk) => chunk.replace(/^[\r\n]+/, ''))
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const parts = chunk.split(FIELD);
      return { sha: parts[0].trim(), subject: (parts[1] ?? '').trim(), body: parts.slice(2).join(FIELD) };
    });
  return { ok: true, commits };
}

/**
 * The decision table. Pure: it receives the commits and the flattened ledger,
 * never reads them.
 * @param {{commits:Array<{sha:string,subject:string,body?:string}>,tasks:Map<string,string>|null,rangeLabel?:string,planLabel?:string}} input
 */
export function auditPlanSync({ commits = [], tasks = null, rangeLabel = '', planLabel = '' } = {}) {
  const common = { commits, rangeLabel, planLabel };
  if (tasks === null) {
    return { ...common, status: 'skip', exitCode: 0, scanned: 0, refs: [], unknown: 0, open: 0, blocked: [] };
  }
  const blocked = [];
  const refs = new Set();
  const unknown = new Set();
  for (const commit of commits) {
    const ids = extractTaskRefs(commit.subject + '\n' + (commit.body ?? ''));
    for (const id of ids) {
      if (!tasks.has(id)) {
        unknown.add(id); // unknown id: prose, not a ledger task — ignore silently
        continue;
      }
      refs.add(id);
      const status = tasks.get(id);
      if (OPEN_STATUSES.has(status)) {
        blocked.push({ sha: commit.sha, subject: commit.subject, taskId: id, status });
      }
    }
  }
  return {
    ...common,
    status: blocked.length > 0 ? 'fail' : 'pass',
    exitCode: blocked.length > 0 ? 1 : 0,
    scanned: commits.length,
    refs: [...refs].sort(),
    unknown: unknown.size,
    open: blocked.length,
    blocked,
  };
}

export const USAGE =
  'usage: node scripts/verify-plan-sync.mjs [--range <git-range>] [--plan <path>]\n' +
  '       defaults: last annotated tag..HEAD (or last ' +
  FALLBACK_COMMITS +
  ' commits), ' +
  DEFAULT_PLAN +
  '\n' +
  '       exit: 0 pass/skip · 1 commit references an open task · 2 usage/unreadable ledger';

/** Parse argv into opts, or return a usage-error string (dogfood-audit pattern). */
export function parseArgs(args) {
  const opts = { range: null, plan: DEFAULT_PLAN };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag !== '--range' && flag !== '--plan') return `unknown argument "${flag}"`;
    const next = args[i + 1];
    if (next === undefined) return `${flag} requires a value`;
    i += 1;
    if (flag === '--range') opts.range = next;
    else opts.plan = next;
  }
  return opts;
}

function shortSubject(subject, max = 100) {
  return subject.length > max ? subject.slice(0, max - 1) + '…' : subject;
}

export function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const parsed = parseArgs(args);
  if (!parsed || typeof parsed === 'string') {
    console.error('[verify-plan-sync] ' + parsed);
    console.error(USAGE);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }

  const planPath = path.resolve(cwd, parsed.plan);
  // A repo-relative label when it sits under cwd, the absolute path otherwise
  // (never a `..\..\walk` that reads like a different checkout).
  const relative = path.relative(cwd, planPath);
  const planLabel = relative && !relative.startsWith('..') ? relative : planPath;
  const plan = readPlan(planPath);

  if (plan.status === 'error') {
    console.error(`[verify-plan-sync] INSUFFICIENT-DATA — ${planLabel} unreadable: ${plan.message}`);
    console.error('  the ledger cannot be compared, and an unreadable ledger is never a synced one.');
    return 2;
  }
  if (plan.status === 'missing') {
    console.log(`[verify-plan-sync] skip: no plan.json (clean checkout) — ${planLabel} not found`);
    console.log('  0 commits scanned, 0 task refs, 0 pending (skipped, not verified)');
    return 0;
  }

  const { range, label } = resolveRange(parsed.range, cwd);
  const log = readCommits(range, cwd);
  if (!log.ok) {
    console.error(`[verify-plan-sync] INSUFFICIENT-DATA — git log "${label}" failed: ${log.error}`);
    return 2;
  }

  const result = auditPlanSync({
    commits: log.commits,
    tasks: plan.tasks,
    rangeLabel: label,
    planLabel,
  });

  console.log(
    `[verify-plan-sync] range ${label} · plan ${planLabel} (${plan.tasks.size} task${plan.tasks.size === 1 ? '' : 's'})`,
  );
  console.log(
    `  ${result.exitCode === 0 ? '✓' : '✗'} [plan-sync] ${result.scanned} commits scanned, ` +
      `${result.refs.length} task refs, ${result.open} pending`,
  );
  for (const row of result.blocked) {
    const sha = row.sha.slice(0, 7);
    console.log(`      ${sha} "${shortSubject(row.subject)}" → ${row.taskId} (${row.status})`);
  }
  if (result.unknown > 0) {
    console.log(`  ℹ ${result.unknown} id(s) in the range are not in the ledger (ignored)`);
  }

  if (result.exitCode === 0) {
    console.log(`[verify-plan-sync] PASS — every task reference in range is closed in ${planLabel}.`);
    return 0;
  }

  console.error(
    `[verify-plan-sync] FAIL — ${result.blocked.length} commit↔task mismatch(es): the commit landed, ` +
      `the ledger still says open.`,
  );
  console.error(
    '  remediation: run task_update in the same turn as the commit (status completed|cancelled), ' +
      'then re-run `npm run verify:plan-sync`.',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
