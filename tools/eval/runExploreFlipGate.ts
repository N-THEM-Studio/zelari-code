/*
 * tools/eval/runExploreFlipGate.ts — t57/C4 — explore quick-default flip gate
 * (measurement + decision only: it never flips the default and never writes).
 *
 *   node --experimental-strip-types tools/eval/runExploreFlipGate.ts \
 *     [--dir <root>] [--min-sessions N] [--max-drop-pp N] [--json]
 *
 * Data source: the per-session coverage reports written by the Kraken graph
 * (`<root>/<sessionId>/coverage.json`, see src/cli/kraken/exploreCoverage.ts).
 * Root default: `.zelari/radio/tentacles` under the current cwd.
 *
 * What it decides
 * ---------------
 * Sessions are classified by the thoroughness their EXPLORE sidecars declared:
 * `quick` only → flip phase; `medium`/`deep` only → baseline phase; anything
 * else (legacy sidecars without a `thoroughness:` header, mixed modes) is
 * EXCLUDED and counted, never guessed into a phase. The two phases are then
 * compared by MEDIAN explore→plan coverage ratio, in percentage points.
 *
 * Exit codes (the status IS the contract):
 *   0  keep              — drop ≤ --max-drop-pp, or no regression: quick is
 *                          authorised by the data (or the flip is already in).
 *   1  revert            — drop STRICTLY above --max-drop-pp with at least
 *                          --min-sessions valid sessions in BOTH phases: put
 *                          explore back on medium.
 *   2  insufficient-data — fewer than --min-sessions valid sessions in either
 *                          phase (this is also the status of a missing or
 *                          empty tentacles dir — honest empty, never invented
 *                          green), or a usage error.
 *
 * Exactly --max-drop-pp keeps: a tie is not a revert. Nothing here mutates
 * state, so it is safe to run on every dogfood run; the flip itself is a
 * separate change that reads this verdict.
 */

import path from 'node:path';
import { argv, cwd } from 'node:process';
import {
  DEFAULT_MAX_DROP_PP,
  DEFAULT_MIN_SESSIONS,
  TENTACLE_REPORTS_ROOT,
  evaluateFlipGate,
  scanTentacleReports,
  type FlipGateResult,
} from '../../src/cli/kraken/exploreFlipGate.ts';

interface CliOptions {
  root: string;
  minSessions: number;
  maxDropPp: number;
  json: boolean;
}

function usage(): string {
  return (
    'usage: runExploreFlipGate.ts [--dir <root>] [--min-sessions N] [--max-drop-pp N] [--json]\n' +
    '       --dir           sidecar root (default .zelari/radio/tentacles)\n' +
    '       --min-sessions  valid sessions required PER PHASE (default 5)\n' +
    '       --max-drop-pp   tolerated median coverage drop in pp (default 10; exactly 10 keeps)\n' +
    '       --json          machine-readable output\n' +
    '       exit: 0 keep · 1 revert · 2 insufficient-data/usage'
  );
}

/** Parse + validate the flags. Returns an error string instead of an options object when wrong. */
function parseArgs(args: string[]): CliOptions | string {
  const opts: CliOptions = {
    root: path.resolve(cwd(), TENTACLE_REPORTS_ROOT),
    minSessions: DEFAULT_MIN_SESSIONS,
    maxDropPp: DEFAULT_MAX_DROP_PP,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const next = args[i + 1];
    if (flag === '--json') {
      opts.json = true;
      continue;
    }
    if (flag === '--dir' || flag === '--min-sessions' || flag === '--max-drop-pp') {
      if (next === undefined || next.startsWith('--')) return `${flag} requires a value`;
      i += 1;
      if (flag === '--dir') {
        opts.root = path.resolve(next);
        continue;
      }
      const value = Number(next);
      if (!Number.isFinite(value)) return `${flag} must be a number (got "${next}")`;
      if (flag === '--min-sessions') {
        if (!Number.isInteger(value) || value < 1) return '--min-sessions must be an integer >= 1';
        opts.minSessions = value;
      } else {
        if (value < 0) return '--max-drop-pp must be >= 0';
        opts.maxDropPp = value;
      }
      continue;
    }
    return `unknown argument "${flag}"`;
  }
  return opts;
}

function pp(medianPp: number | null): string {
  return medianPp === null ? 'n/a' : `${medianPp}pp`;
}

function formatHuman(scan: { root: string; skipped: number; dirMissing: boolean }, r: FlipGateResult): string {
  const lines: string[] = [];
  lines.push('=== zelari explore:flip-gate — t57/C4 (measurement + decision only — no flip, no writes) ===');
  lines.push(
    scan.dirMissing
      ? `reports dir not found: ${scan.root} — nothing scanned (honest empty, not invented green)`
      : `reports dir: ${scan.root}${scan.skipped > 0 ? ` (${scan.skipped} skipped: absent/unreadable/corrupt)` : ''}`,
  );
  lines.push(
    `sessions: baseline n=${r.baseline.n} median=${pp(r.baseline.medianPp)}` +
      ` | flip n=${r.flip.n} median=${pp(r.flip.medianPp)}` +
      ` | excluded ${r.excludedCount}`,
  );
  lines.push(
    `thresholds: min-sessions ${r.minSessions}/phase, max-drop ${r.maxDropPp}pp` +
      ` | drop: ${r.dropPp === null ? 'not computed' : `${r.dropPp}pp`}`,
  );
  lines.push(`status: ${r.status.toUpperCase()} — ${r.reason}`);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const parsed = parseArgs(argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`runExploreFlipGate: ${parsed}`);
    console.error(usage());
    return 2;
  }

  const scan = await scanTentacleReports(parsed.root);
  const result = evaluateFlipGate(scan.reports, {
    minSessions: parsed.minSessions,
    maxDropPp: parsed.maxDropPp,
  });

  if (parsed.json) {
    console.log(
      JSON.stringify(
        {
          advisory: true,
          mutation: 'none',
          tool: 'explore:flip-gate',
          reportsDir: scan.root,
          dirMissing: scan.dirMissing,
          reportsSkipped: scan.skipped,
          status: result.status,
          dropPp: result.dropPp,
          baseline: result.baseline,
          flip: result.flip,
          excludedCount: result.excludedCount,
          minSessions: result.minSessions,
          maxDropPp: result.maxDropPp,
          reason: result.reason,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatHuman(scan, result));
  }

  // The status is the contract: an honest 'insufficient-data' is exit 2, so a
  // caller can never mistake "no data yet" for "flip safe".
  if (result.status === 'keep') return 0;
  if (result.status === 'revert') return 1;
  return 2;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  // `exitCode` + natural teardown, not `exit()`: a hard exit races the stdio
  // flush on win32 (observed as a libuv assertion and a bogus 127 exit code,
  // which would destroy the meaning of the status-as-contract above).
  process.exitCode = await main();
}
