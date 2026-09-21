/*
 * tools/eval/runPatternLedger.ts — S1 — failure-pattern ledger runner
 * (advisory; append-only clusters — ZERO auto-apply).
 *
 *   node --experimental-strip-types tools/eval/runPatternLedger.ts \
 *     [--min-distinct-tasks N] [--json] [--dry-run]
 *
 * Data source: the instance findings ledger
 *   <cwd>/.zelari/evolution/findings.jsonl (read via readFindings).
 * Output: clusters appended to <cwd>/.zelari/evolution/pattern-ledger.jsonl
 *   unless --dry-run. A missing dir/ledger ⇒ honest zero, exit 0 (never throws).
 *
 * ADVISORY by construction: clustering never promotes or applies anything (P1);
 * exit 2 only for usage errors. This runner READS src/cli/evolution — the
 * runner may depend on the proposer, never the reverse (ADR-0036).
 */

import path from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { readFindings } from '../../src/cli/evolution/ledger.ts';
import {
  appendClusters,
  clusterFailures,
  patternLedgerPath,
  type ClusterEntry,
} from '../../src/cli/evolution/patternLedger.ts';

const DEFAULT_MIN_DISTINCT_TASKS = 2;

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function usage(): string {
  return 'usage: runPatternLedger.ts [--min-distinct-tasks N] [--json] [--dry-run]';
}

function formatCluster(c: ClusterEntry): string {
  const keys = c.taskKeys.length > 0 ? c.taskKeys.join(', ') : '(none)';
  return `  [${c.id}] ${c.category} ${c.key} — count ${c.count} across ${c.distinctTasks} task(s) — taskKeys: ${keys}`;
}

async function main(): Promise<number> {
  const minDistinctRaw = arg('min-distinct-tasks');
  if (minDistinctRaw !== undefined && !/^\d+$/.test(minDistinctRaw)) {
    console.error('runPatternLedger: --min-distinct-tasks must be a positive integer');
    console.error(usage());
    return 2;
  }
  const minDistinctTasks = Number.parseInt(minDistinctRaw ?? String(DEFAULT_MIN_DISTINCT_TASKS), 10);
  if (minDistinctTasks < 1) {
    console.error('runPatternLedger: --min-distinct-tasks must be a positive integer');
    console.error(usage());
    return 2;
  }
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const root = cwd();

  // Missing evolution dir/ledger is NOT an error — honest empty, exit 0.
  const findings = readFindings(root);
  const { clusters, unmapped } = clusterFailures(findings, { minDistinctTasks });
  if (!dryRun) await appendClusters(clusters, root);

  if (json) {
    console.log(
      JSON.stringify(
        {
          advisory: true,
          mutation: dryRun ? 'none' : 'pattern-ledger-append',
          root,
          findings: findings.length,
          clusters,
          unmapped,
          written: dryRun ? 0 : clusters.length,
          patternLedger: patternLedgerPath(root),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push('=== zelari pattern:ledger — S1 failure-pattern ledger (advisory — proposes nothing) ===');
  lines.push(
    `findings in: ${findings.length} | clusters: ${clusters.length} | unmapped findings: ${unmapped} | threshold: ${minDistinctTasks} distinct task(s)`,
  );
  if (clusters.length === 0) {
    lines.push('no mechanism repeated across enough distinct tasks — nothing clustered');
  } else {
    for (const c of clusters) lines.push(formatCluster(c));
    lines.push(
      dryRun
        ? `DRY RUN — nothing written (${patternLedgerPath(root)})`
        : `${patternLedgerPath(root)}: ${clusters.length} cluster(s) appended`,
    );
  }
  console.log(lines.join('\n'));
  return 0;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  exit(await main());
}
