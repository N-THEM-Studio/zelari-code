#!/usr/bin/env node
/**
 * dogfood-brief.mjs — build the 3-section mission brief for a dogfood run (t52).
 *
 *   node scripts/dogfood-brief.mjs [--task <id>] [--plan <.zelari/plan.json>]
 *
 * Reads the plan, picks `--task <id>` or by default the first PENDING task at
 * medium-or-higher priority (else the first pending one), and prints the brief
 * to stdout. The brief is what a live zelari mission receives — see
 * scripts/dogfood-driver.mjs.
 *
 * Exit: 0 brief printed · 2 plan missing/unreadable or task not found
 * (INSUFFICIENT-DATA — never a silent empty brief).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PLAN = path.join('.zelari', 'plan.json');
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const rank = (p) => RANK[p] ?? 9;

/** `--task <id>` wins; otherwise the highest-priority pending task. Null when none. */
export function pickTask(tasks, id) {
  if (id) return tasks.find((t) => t.id === id) ?? null;
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  if (pending.length === 0) return null;
  const ranked = [...pending].sort((a, b) => rank(a.priority) - rank(b.priority));
  return ranked.find((t) => rank(t.priority) <= rank('medium')) ?? ranked[0];
}

export function formatBrief(task) {
  const scope = Array.isArray(task.files) && task.files.length > 0
    ? task.files.map((f) => `- \`${f}\``).join('\n')
    : '(unspecified)';
  return [
    `# Dogfood brief: ${task.id} — ${task.title ?? task.name ?? '(untitled)'}`,
    '',
    '## Context',
    '',
    String(task.notes ?? '').trim() || '(none)',
    '',
    '## Scope',
    '',
    scope,
    '',
    '## Constraint',
    '',
    'Output as a PR, never auto-merge. If the diff touches JUDGE_PATHS, two approvals required.',
    '',
  ].join('\n');
}

export function loadPlan(planPath) {
  return JSON.parse(readFileSync(planPath, 'utf8'));
}

export const USAGE =
  'usage: node scripts/dogfood-brief.mjs [--task <id>] [--plan <.zelari/plan.json>] (exit 0 ok · 2 insufficient-data)';

export function parseArgs(args) {
  const opts = { task: null, plan: DEFAULT_PLAN };
  const valued = { '--task': 'task', '--plan': 'plan' };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const key = valued[flag];
    if (!key) return `unknown argument "${flag}"`;
    const next = args[i + 1];
    if (next === undefined) return `${flag} requires a value`;
    i += 1;
    opts[key] = next;
  }
  return opts;
}

export function main(args) {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    console.error(`dogfood-brief: ${parsed}`);
    console.error(USAGE);
    return 2;
  }
  let plan;
  try {
    plan = loadPlan(path.resolve(parsed.plan));
  } catch (err) {
    const reason = String((err && err.message) || err).split('\n')[0];
    console.error(`dogfood-brief: INSUFFICIENT-DATA — cannot read plan "${parsed.plan}" (${reason})`);
    return 2;
  }
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const task = pickTask(tasks, parsed.task);
  if (!task) {
    const why = parsed.task ? `task "${parsed.task}" not found` : 'no pending task in the plan';
    console.error(`dogfood-brief: INSUFFICIENT-DATA — ${why} in "${parsed.plan}"`);
    return 2;
  }
  console.log(formatBrief(task).trimEnd());
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
