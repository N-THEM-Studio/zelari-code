#!/usr/bin/env node
// gate-full.mjs — serial full gate for run_backtest (executor-agnostic).
// Legs: typecheck (rebuilds packages/core/dist) -> smoke -> test:safety ->
// verify:plan-sync (cheap git+ledger check, no dist dependency — appended last
// so the existing leg order and fail-fast semantics are untouched).
// Fail-fast like `&&`, but every leg's exit code and full output are tee'd
// to .zelari/world/last-gate.log so a red inside the backtest executor
// (opaque env, truncated preview) always leaves readable evidence on disk.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const LOG = resolve(ROOT, '.zelari/world/last-gate.log');
const LEGS = ['typecheck', 'smoke', 'test:safety', 'verify:plan-sync'];

mkdirSync(dirname(LOG), { recursive: true });
const chunks = [];
const log = (s) => {
  chunks.push(s);
  process.stdout.write(s);
};

// Executor env hygiene: the backtest executor runs this script INSIDE the
// product runtime, which exports its own knobs (ZELARI_*/ANATHEMA_*/GROK_*).
// The product-under-test must not inherit them — proven empirically: the same
// script, cwd and shell go green when launched from a clean shell and red
// (9 ask-fail-closed tests) when launched from the executor. Strip the
// product vars and leave an imprint in the log for future diagnosis.
const PRODUCT_ENV = /^(ZELARI_|ANATHEMA_|GROK_)/;
const env = {};
const stripped = [];
for (const [k, v] of Object.entries(process.env)) {
  if (PRODUCT_ENV.test(k)) stripped.push(k);
  else env[k] = v;
}
log(
  `\n[gate-full] env hygiene: stripped ${stripped.length} product var(s)${stripped.length ? ` [${stripped.join(', ')}]` : ''}\n`,
);

let failed = null;
for (const leg of LEGS) {
  log(`\n===== LEG ${leg} =====\n`);
  const r = spawnSync('npm', ['run', leg], {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  log(r.stdout ?? '');
  if (r.stderr) log(`[stderr] ${r.stderr}`);
  log(`\n[gate-full] LEG ${leg} exit=${r.status}\n`);
  if (r.status !== 0) {
    failed = { leg, status: r.status };
    break; // fail-fast: later legs depend on dist rebuilt by typecheck
  }
}

writeFileSync(LOG, chunks.join(''), 'utf8');
log(`\n[gate-full] ${failed ? `FAILED at ${failed.leg} (exit ${failed.status})` : 'ALL LEGS GREEN'} — full log: ${LOG}\n`);
process.exit(failed ? 1 : 0);
