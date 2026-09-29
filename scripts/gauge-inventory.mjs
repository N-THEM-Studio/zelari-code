#!/usr/bin/env node
/**
 * scripts/gauge-inventory.mjs - Gauge F0, label inventory (read-only).
 *
 * "Zelari Code - Gauge tentacolo di decisione calibrata.md" F0 asks for a
 * report on the sessions already on disk BEFORE the replay, so the go/no-go
 * F0 -> F1 is decided on a measured count instead of the ~900 estimate in
 * the design note.
 *
 * It is a LABEL inventory, not a session inventory: it counts, per source,
 * how many usable (rawProbability, realOutcome) PAIRS exist, because a
 * calibrator is fit on pairs, not on sessions.
 *
 * What counts as a label for `claim_supported`:
 *   verification.run with a real verdict (status != UNEVALUATED and
 *   verdict != null). A run with reason=strict-off is the runtime honestly
 *   reporting that it never evaluated: NOT evidence, so NOT a label.
 *   This is P1 applied to the dataset itself.
 *   verify.debt_cleared -> weak PASS. verify.debt_open -> FAIL signal.
 *   A completion CLAIM (assistant turn) is a candidate point, never a label.
 *
 * Everything is a floor: the design note also lists sources this script
 * cannot see (Minosse reviews in .zelari/reviews, checkpoint SHAs, synthetic
 * injections). Those are reported as absent, never as zero-by-omission.
 *
 * Exit codes:
 *   0 = inventory read and printed
 *   1 = bad args / no sessions directory
 *
 * Read-only: opens every events.jsonl, writes nothing.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const USAGE = `usage: node scripts/gauge-inventory.mjs [--dir <workspace>] [--sessions <path>] [--json]

  --dir       workspace containing .zelari/sessions (default: cwd)
  --sessions  explicit path to the sessions directory (overrides --dir)
  --json      machine-readable single-object output

Read-only. Counts usable label pairs per source, never sessions alone.

exit 0 inventory read - 1 bad input`;

function parseArgs(argv) {
  const out = { dir: '.', sessions: null, json: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--dir') {
      const v = argv[++i];
      if (!v) { out.error = '--dir needs a value'; break; }
      out.dir = v;
    } else if (a === '--sessions') {
      const v = argv[++i];
      if (!v) { out.error = '--sessions needs a value'; break; }
      out.sessions = v;
    } else if (a === '--help' || a === '-h') {
      out.error = null;
      out.help = true;
      break;
    } else {
      out.error = `unknown argument: ${a}`;
      break;
    }
  }
  return out;
}

/** A "claim point" is an assistant turn: the moment something could be declared done. */
function isCompletionCandidate(kind, data) {
  if (kind !== 'assistant.message') return false;
  const text = typeof data?.text === 'string' ? data.text : '';
  if (!text) return false;
  return /\b(done|complete|completed|finished|implemented|fixed|ready)\b/i.test(text);
}

async function scanFile(file, acc) {
  let stream;
  try {
    stream = readline.createInterface({
      input: (await fs.open(file, 'r')).createReadStream(),
      crlfDelay: Infinity,
    });
  } catch {
    acc.unreadable += 1;
    return;
  }
  for await (const line of stream) {
    // Skip blank lines only. A length guard would hide SHORT corrupt lines
    // and report them as clean - a false empty over the dataset.
    if (line.trim().length === 0) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      acc.corruptLines += 1;
      continue;
    }
    const kind = o?.kind;
    if (typeof kind !== 'string') continue;
    acc.events += 1;
    // Per-session, not per-event: a session may hold many user messages.
    if (kind === 'user.message' && !acc._sawUser) {
      acc._sawUser = true;
      acc.sessionsWithUserMessage += 1;
    }

    if (kind === 'verification.run') {
      const d = o.data ?? {};
      acc.verificationRuns += 1;
      const evaluated = d.status !== 'UNEVALUATED' && d.verdict != null;
      if (evaluated) {
        acc.labels.claim_supported += 1;
        acc.verdicts[d.verdict] = (acc.verdicts[d.verdict] ?? 0) + 1;
      } else {
        // The runtime said it did not evaluate. Honest absence, not a label.
        acc.unevaluatedRuns += 1;
        if (d.reason) acc.unevaluatedReasons[d.reason] = (acc.unevaluatedReasons[d.reason] ?? 0) + 1;
      }
    } else if (kind === 'verification.evidence') {
      acc.evidenceEvents += 1;
    } else if (kind === 'verify.debt_cleared') {
      acc.labels.claim_supported_weak += 1;
    } else if (kind === 'verify.debt_open') {
      acc.labels.claim_supported_weak += 1;
      acc.debtOpen += 1;
    } else if (kind === 'verify.requested') {
      acc.verifyRequested += 1;
    } else if (isCompletionCandidate(kind, o.data)) {
      acc.claimPoints += 1;
    }

    if (kind === 'session.started' || kind === 'session.harness_manifest') {
      const m = o.data ?? {};
      if (m.profile || m.version || m.zelariVersion) {
        const v = String(m.zelariVersion ?? m.version ?? 'unknown');
        acc.byVersion[v] = (acc.byVersion[v] ?? 0) + 1;
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  if (args.error) { console.error(`gauge-inventory: ${args.error}\n\n${USAGE}`); return 1; }

  const root = args.sessions ?? path.join(args.dir, '.zelari', 'sessions');
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    console.error(`gauge-inventory: cannot read sessions directory: ${root}`);
    return 1;
  }

  const acc = {
    sessions: 0,
    events: 0,
    corruptLines: 0,
    unreadable: 0,
    sessionsWithUserMessage: 0,
    claimPoints: 0,
    verificationRuns: 0,
    unevaluatedRuns: 0,
    unevaluatedReasons: {},
    evidenceEvents: 0,
    debtOpen: 0,
    verifyRequested: 0,
    verdicts: {},
    byVersion: {},
    labels: { claim_supported: 0, claim_supported_weak: 0 },
  };

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, 'events.jsonl');
    try {
      await fs.access(file);
    } catch {
      continue;
    }
    acc.sessions += 1;
    acc._sawUser = false;
    await scanFile(file, acc);
    acc._sawUser = false;
  }

  // Sources the design note lists that live OUTSIDE the spine. Reported so
  // an absent source is a measured absence, not an omission.
  const reviewsDir = path.join(args.dir, '.zelari', 'reviews');
  let reviews = 0;
  try {
    reviews = (await fs.readdir(reviewsDir)).length;
  } catch { reviews = null; }

  const hard = acc.labels.claim_supported;
  const weak = acc.labels.claim_supported_weak;
  const MIN_SAMPLES = 200;
  const MIN_PER_CLASS = 30;
  const go = hard >= MIN_SAMPLES;

  const report = {
    root,
    sessions: acc.sessions,
    events: acc.events,
    corruptLines: acc.corruptLines,
    unreadable: acc.unreadable,
    sessionsWithUserMessage: acc.sessionsWithUserMessage,
    claimPoints: acc.claimPoints,
    verification: {
      runs: acc.verificationRuns,
      unevaluated: acc.unevaluatedRuns,
      unevaluatedReasons: acc.unevaluatedReasons,
      verdicts: acc.verdicts,
      evidenceEvents: acc.evidenceEvents,
    },
    verifyFamily: { debtOpen: acc.debtOpen, verifyRequested: acc.verifyRequested },
    labels: {
      claim_supported_hard: hard,
      claim_supported_weak: weak,
      minosse_reviews: reviews,
    },
    gate: { minSamples: MIN_SAMPLES, minPerClass: MIN_PER_CLASS, go },
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const L = console.log;
  L('gauge-inventory - F0 label inventory (read-only)');
  L(`sessions dir: ${root}`);
  L('');
  L(`sessions scanned        : ${acc.sessions}`);
  L(`events scanned          : ${acc.events}${acc.corruptLines ? ` (corrupt lines skipped: ${acc.corruptLines})` : ''}`);
  L(`sessions with a user msg: ${acc.sessionsWithUserMessage}`);
  L(`claim points (candidates, NOT labels): ${acc.claimPoints}`);
  L('');
  L('verification.run');
  L(`  total                 : ${acc.verificationRuns}`);
  L(`  unevaluated           : ${acc.unevaluatedRuns}  <- NOT labels`);
  for (const [k, v] of Object.entries(acc.unevaluatedReasons)) L(`      reason=${k} : ${v}`);
  L(`  with a real verdict   : ${Object.values(acc.verdicts).reduce((a, b) => a + b, 0)}`);
  for (const [k, v] of Object.entries(acc.verdicts)) L(`      verdict=${k} : ${v}`);
  L(`  evidence events       : ${acc.evidenceEvents}`);
  L('');
  L('usable label pairs for claim_supported');
  L(`  hard (real verdict)   : ${hard}`);
  L(`  weak (debt open/cleared): ${weak}`);
  L(`  Minosse reviews       : ${reviews === null ? 'absent (.zelari/reviews not found)' : reviews}`);
  L('');
  L(`F0 -> F1 gate: ${go ? 'GO' : 'NO-GO'} (needs >= ${MIN_SAMPLES} hard labels, have ${hard})`);
  L('');
  L('A session is not a label. A calibrator is fit on (rawProbability, realOutcome)');
  L('pairs; only a real verdict supplies the outcome.');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('gauge-inventory: unexpected error:', e?.message ?? e);
  process.exit(1);
});
