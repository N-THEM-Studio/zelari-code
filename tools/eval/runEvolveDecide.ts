/*
 * tools/eval/runEvolveDecide.ts — Fase 2.1 — evolution decision CLI
 * (advisory; records human DECISIONS on proposals ONLY — applying a patch
 * is out of scope by construction: this CLI never mutates project code,
 * decisions are metadata appended to the proposal store).
 *
 *   node --experimental-strip-types tools/eval/runEvolveDecide.ts --list \
 *     [--store <file>] [--json]
 *   node --experimental-strip-types tools/eval/runEvolveDecide.ts \
 *     --id <p-NNNN> --decision <applied|rejected|withdrawn> \
 *     [--ref <git-ref-or-worktree-path>] [--evidence <str>]... \
 *     [--note <str>] [--store <file>] [--json] [--dry-run]
 *
 * Store: <cwd>/.zelari/evolution/proposals.jsonl (override --store).
 * Append-only JSONL — a decision is a NEW record repeating the proposal's
 * id (event-sourced; the original record is never rewritten). The
 * EFFECTIVE status of an id is its last record's status in file order.
 *
 * Evidence is fail-closed for 'applied': every entry of the proposal's
 * requiredValidation needs one --evidence entry (>= 1 even when the ask
 * list is empty) plus a non-empty --ref; evidence that does not state
 * "exit 0" gets a non-fatal warning on stderr.
 *
 * ADVISORY semantics: exit 0 for every successfully recorded decision
 * (including rejected/withdrawn) and for honest noops; exit 2 ONLY for
 * usage/validation errors.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { parseProposalStore, type StoredProposal } from './evolvePropose.ts';
import {
  appendDecision,
  decide,
  type DecisionInput,
  type DecisionRecord,
  type DecisionStatus,
} from './evolveDecide.ts';

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** True when `--name` is present but its value is missing (absent or another flag). Usage error. */
function flagWithoutValue(name: string): boolean {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && (i + 1 >= argv.length || argv[i + 1].startsWith('--'));
}

/** Every value of a REPEATABLE flag, in argv order. */
function argsAll(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && i + 1 < argv.length) values.push(argv[i + 1]);
  }
  return values;
}

/** A repeatable flag occurrence with a missing value (end of argv / next flag) → usage error. */
function anyOccurrenceWithoutValue(name: string): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && (i + 1 >= argv.length || argv[i + 1].startsWith('--'))) return true;
  }
  return false;
}

function usage(): string {
  return 'usage: runEvolveDecide.ts --list [--store <file>] [--json] | --id <p-NNNN> --decision <applied|rejected|withdrawn> [--ref <git-ref-or-worktree-path>] [--evidence <str>]... [--note <str>] [--store <file>] [--json] [--dry-run]';
}

// Local store reader (same tolerant behavior as runEvolvePropose.ts — CLI
// files do not import CLI files): missing store → empty; unreadable → empty.
function readStore(file: string): { records: StoredProposal[]; malformed: number } {
  if (!existsSync(file)) return { records: [], malformed: 0 };
  try {
    return parseProposalStore(readFileSync(file, 'utf-8').split(/\r?\n/));
  } catch {
    return { records: [], malformed: 0 };
  }
}

/** Last numeric evidence.count across ALL records of an id (decision records carry string[] evidence). */
function proposalEvidenceCount(records: StoredProposal[], id: string): number {
  let count = 0;
  for (const r of records) {
    if (r.id === id && r.evidence !== null && typeof r.evidence === 'object' && !Array.isArray(r.evidence)
      && typeof (r.evidence as { count?: unknown }).count === 'number') {
      count = (r.evidence as { count: number }).count;
    }
  }
  return count;
}

function listMode(storePath: string, json: boolean): number {
  const { records, malformed } = readStore(storePath);
  // Fold by id, LAST record wins (event-sourced projection).
  const byId = new Map<string, { status: string; record: StoredProposal }>();
  for (const r of records) {
    if (typeof r.id === 'string' && r.id !== '') byId.set(r.id, { status: String(r.status), record: r });
  }
  if (byId.size === 0) {
    if (json) console.log(JSON.stringify({ storePath, malformed, proposals: [] }, null, 2));
    else console.log(malformed > 0 ? `no proposals recorded (${malformed} malformed line(s) skipped)` : 'no proposals recorded');
    return 0;
  }
  const ids = [...byId.keys()].sort();
  const list = ids.map((id) => {
    const eff = byId.get(id)!;
    return {
      id,
      status: eff.status,
      operator: String(eff.record.operator ?? '?'),
      surface: String(eff.record.surface ?? '?'),
      count: proposalEvidenceCount(records, id),
    };
  });
  if (json) {
    console.log(JSON.stringify({ storePath, malformed, proposals: list }, null, 2));
    return 0;
  }
  const statusCounts = new Map<string, number>();
  for (const p of list) statusCounts.set(p.status, (statusCounts.get(p.status) ?? 0) + 1);
  const counts = [...statusCounts.entries()].sort().map(([s, n]) => `${s}=${n}`).join(' ');
  const lines: string[] = [];
  lines.push('=== zelari evolve:decide — Fase 2.1 decision loop (advisory — records decisions, never applies) ===');
  for (const p of list) {
    lines.push(`${p.id}  ${p.status.padEnd(8)}  ${p.operator.padEnd(23)}  ${p.surface}  count=${p.count}`);
  }
  lines.push(`=== ${list.length} proposal id(s) — ${counts} (malformed lines: ${malformed}) ===`);
  lines.push(`store: ${storePath}`);
  console.log(lines.join('\n'));
  return 0;
}

function decisionMode(storePath: string, json: boolean, dryRun: boolean): number {
  const id = arg('id') ?? '';
  const status = arg('decision') ?? '';
  if (!['applied', 'rejected', 'withdrawn'].includes(status)) {
    console.error(`runEvolveDecide: --decision must be applied | rejected | withdrawn (got '${status}')`);
    console.error(usage());
    return 2;
  }
  const input: DecisionInput = {
    id,
    status: status as DecisionStatus,
    evidence: argsAll('evidence'),
  };
  const ref = arg('ref');
  if (ref !== undefined) input.ref = ref;
  const note = arg('note');
  if (note !== undefined) input.note = note;

  const { records } = readStore(storePath);
  let result: ReturnType<typeof decide>;
  try {
    // The CLI owns the clock — the decision core stays pure.
    result = decide(records, input, new Date().toISOString());
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(usage());
    return 2;
  }

  if (result.outcome === 'noop') {
    if (json) {
      console.log(JSON.stringify({ outcome: 'noop', id, status, storePath, written: 0 }, null, 2));
    } else {
      console.log(`decision noop: ${id} already '${status}' (effective status) — nothing written`);
    }
    return 0;
  }

  const record = result.record as DecisionRecord;
  const { written } = appendDecision(storePath, record, { dryRun });
  const refShown = input.ref !== undefined ? input.ref : 'none';
  if (json) {
    console.log(JSON.stringify({ outcome: 'appended', written, storePath, record, warnings: result.warnings }, null, 2));
  } else {
    console.log(`decision recorded: ${id} -> ${status} (ref=${refShown}, evidence=${input.evidence.length})`);
    if (dryRun) console.log(`DRY RUN — nothing written (${storePath})`);
  }
  for (const w of result.warnings) console.error(w);
  // Advisory Fase 2.1: recording a decision never applies anything — exit 0.
  return 0;
}

function main(): number {
  for (const valueFlag of ['id', 'decision', 'ref', 'evidence', 'note', 'store']) {
    const missing = valueFlag === 'evidence' ? anyOccurrenceWithoutValue(valueFlag) : flagWithoutValue(valueFlag);
    if (missing) {
      console.error(`runEvolveDecide: --${valueFlag} requires a value`);
      console.error(usage());
      return 2;
    }
  }
  const wantsList = argv.includes('--list');
  const idGiven = argv.includes('--id');
  const decisionGiven = argv.includes('--decision');
  if (wantsList && (idGiven || decisionGiven)) {
    console.error('runEvolveDecide: --list cannot be combined with --id/--decision');
    console.error(usage());
    return 2;
  }
  if (!wantsList && !(idGiven && decisionGiven)) {
    console.error('runEvolveDecide: give either --list or both --id and --decision');
    console.error(usage());
    return 2;
  }
  const storePath = path.resolve(arg('store') ?? path.join(cwd(), '.zelari', 'evolution', 'proposals.jsonl'));
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  return wantsList ? listMode(storePath, json) : decisionMode(storePath, json, dryRun);
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  exit(main());
}
