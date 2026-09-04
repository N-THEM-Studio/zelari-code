#!/usr/bin/env node
/**
 * touches-judge.mjs — report whether a diff touches the "judge" (ADR-0036).
 *
 * The judge is the set of paths that decide safety and measure fitness
 * (JUDGE_PATHS in verify-principles.mjs). PRs that touch them deserve
 * heightened scrutiny (CI labels them `touches-judge`).
 *
 * Informational only: always exits 0 so it can run in any workflow step;
 * consumers act on stdout ("touches-judge: yes|no" + file list).
 *
 * Usage: node scripts/touches-judge.mjs [base-ref]   (default: origin/main)
 */
import { execFileSync } from 'node:child_process';
import { JUDGE_PATHS, REPO_ROOT } from './verify-principles.mjs';

const base = process.argv[2] ?? 'origin/main';

let changed = [];
try {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  changed = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
} catch (err) {
  console.error(`[touches-judge] git diff against ${base} unavailable (${err.message.split('\n')[0]}) — assuming no judge changes`);
  console.log('touches-judge: unknown');
  process.exit(0);
}

const normalize = (p) => p.replace(/\\/g, '/');
const touched = changed.filter((f) => {
  const rel = normalize(f);
  return JUDGE_PATHS.some((j) => {
    const judge = normalize(j);
    return rel === judge || rel.startsWith(judge + '/');
  });
});

if (touched.length > 0) {
  console.log('touches-judge: yes');
  for (const t of touched) console.log(`  ${t}`);
  console.log('[touches-judge] heightened scrutiny recommended (ADR-0036): the proposer must never edit the judge silently');
} else {
  console.log('touches-judge: no');
}
process.exit(0);
