#!/usr/bin/env node
/**
 * perf-bench.mjs — Phase-0 latency collector (Int 3). Zero deps, read-only,
 * exit 0 with a "no data" note when nothing has run yet. Sources: the kraken
 * radio trail (`.zelari/radio/*.jsonl` — radioDir() in
 * src/cli/tools/krakenRadio.ts, most recent run only) and
 * `.zelari/completion-proof.json` (strict gate).
 *
 * Usage: npm run perf:bench
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const RADIO_DIR = path.join(ROOT, '.zelari', 'radio');
const PROOF_PATH = path.join(ROOT, '.zelari', 'completion-proof.json');
const RUN_WINDOW_MS = 1000; // files this close to the newest one = same run

const pad = (value, width) => String(value).padEnd(width);
const ms = (value) => `${Math.round(value)}ms`;

/** Newest run: the newest *.jsonl file(s), parsed leniently. */
function loadRadioRun() {
  const empty = { files: [], rows: [], badLines: 0 };
  if (!fs.existsSync(RADIO_DIR)) return empty;
  const entries = fs.readdirSync(RADIO_DIR).filter((n) => n.endsWith('.jsonl')).map((name) => {
    const full = path.join(RADIO_DIR, name);
    return { name, full, mtimeMs: fs.statSync(full).mtimeMs };
  });
  if (entries.length === 0) return empty;
  const newest = Math.max(...entries.map((entry) => entry.mtimeMs));
  const files = entries.filter((e) => newest - e.mtimeMs <= RUN_WINDOW_MS).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const rows = [];
  let badLines = 0;
  for (const file of files) {
    for (const line of fs.readFileSync(file.full, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        badLines += 1;
      }
    }
  }
  return { files, rows, badLines };
}

/** Per-kind counts + summed/max durationMs, plus the run wall clock. */
function summarize(rows) {
  const kinds = new Map();
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const row of rows) {
    const bucket = kinds.get(row.kind) ?? { count: 0, sum: 0, max: 0, timed: 0 };
    bucket.count += 1;
    if (typeof row.durationMs === 'number') {
      bucket.sum += row.durationMs;
      bucket.max = Math.max(bucket.max, row.durationMs);
      bucket.timed += 1;
    }
    kinds.set(row.kind, bucket);
    const ts = Date.parse(row.ts ?? '');
    if (Number.isFinite(ts)) {
      minTs = Math.min(minTs, ts);
      maxTs = Math.max(maxTs, ts);
    }
  }
  return { kinds, wallClockMs: Number.isFinite(minTs) && Number.isFinite(maxTs) ? maxTs - minTs : null };
}

/** Provider round-trips (adaptation: radio has no model-request kind). */
function countRoundTrips(rows) {
  const modelTagged = rows.filter((row) => typeof row.model === 'string' && row.model.length > 0);
  const byModel = new Map();
  for (const row of modelTagged) byModel.set(row.model, (byModel.get(row.model) ?? 0) + 1);
  return { spawns: rows.filter((row) => row.kind === 'spawn').length, modelTagged: modelTagged.length, byModel };
}

/** Deep scan for durationMs numbers — the proof payload shape varies by gate. */
function collectDurations(node, trail, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectDurations(item, `${trail}[${index}]`, out));
    return out;
  }
  const raw = node.durationMs ?? node.duration_ms;
  if (typeof raw === 'number') {
    const id = node.criterionId ?? node.id ?? node.check ?? node.command ?? node.detail ?? trail;
    out.push({ label: String(id), value: raw });
  }
  for (const [key, value] of Object.entries(node)) collectDurations(value, `${trail}.${key}`, out);
  return out;
}

function loadProof() {
  if (!fs.existsSync(PROOF_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(PROOF_PATH, 'utf8'));
  } catch {
    return { parseError: true };
  }
}

function printRadio(run) {
  console.log('== kraken radio (most recent run) ==');
  if (run.files.length === 0) {
    console.log(`no data — ${path.relative(ROOT, RADIO_DIR)} has no *.jsonl yet.`);
    console.log('run a Kraken task, then re-run: npm run perf:bench');
    return;
  }
  const { kinds, wallClockMs } = summarize(run.rows);
  const serial = [...kinds.values()].reduce((total, bucket) => total + bucket.sum, 0);
  console.log(`source: ${run.files.map((file) => file.name).join(', ')}`);
  console.log(`${pad('event kind', 22)}${pad('count', 8)}${pad('sum durationMs', 16)}max`);
  for (const [kind, bucket] of [...kinds.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const sum = bucket.timed ? ms(bucket.sum) : '—';
    console.log(`${pad(kind, 22)}${pad(bucket.count, 8)}${pad(sum, 16)}${bucket.timed ? ms(bucket.max) : '—'}`);
  }
  console.log(`${pad('TOTAL', 22)}${pad(run.rows.length, 8)}`);
  console.log(`run wall clock: ${wallClockMs === null ? 'unknown (no parseable ts)' : ms(wallClockMs)} · summed event durationMs: ${ms(serial)}`);
  if (run.badLines > 0) console.log(`warning: ${run.badLines} unparseable line(s) skipped`);

  const trips = countRoundTrips(run.rows);
  console.log('\n== provider round-trips (derived) ==');
  console.log(`spawn events (one per tentacle): ${trips.spawns}`);
  console.log(`events carrying a model id (done/verify_hint/error): ${trips.modelTagged}`);
  const top = [...trips.byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [model, count] of top) console.log(`  ${pad(model, 34)}${count}`);
}

function printProof(proof) {
  console.log('\n== strict gate (completion-proof.json) ==');
  if (!proof) return console.log('no data — no .zelari/completion-proof.json in this workspace yet.');
  if (proof.parseError) return console.log('unreadable — completion-proof.json is not valid JSON.');
  const evaluation = proof.evaluation ?? {};
  const legacy = evaluation.legacy ?? {};
  const evidence = evaluation.evidence ?? {};
  console.log(`verdict ${evaluation.verdict ?? '?'} · strict ${evaluation.strict ?? '?'} · engine ${evaluation.engine ?? '?'}`);
  console.log(`legacy checks: total ${legacy.total ?? 0} · passed ${legacy.passed ?? 0} · failed ${legacy.failed?.length ?? 0} · unknown ${legacy.unknown?.length ?? 0}`);
  console.log(`evidence: satisfied ${evidence.satisfied?.length ?? 0} · unsatisfied ${evidence.unsatisfied?.length ?? 0} · complete ${evidence.complete ?? '?'}`);
  const durations = collectDurations(proof, '', []);
  if (durations.length === 0) return console.log('criterion durations: none recorded in this proof payload shape.');
  console.log(`${pad('criterion', 46)}duration`);
  for (const entry of durations) console.log(`${pad(entry.label.slice(0, 44), 46)}${ms(entry.value)}`);
}

printRadio(loadRadioRun());
printProof(loadProof());
process.exit(0);
