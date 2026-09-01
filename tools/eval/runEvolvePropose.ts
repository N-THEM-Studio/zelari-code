/*
 * tools/eval/runEvolvePropose.ts — Fase 2.0 — evolution proposal CLI
 * (advisory; writes proposal documents ONLY — applying a patch is out of
 * scope by construction: human approval is structural).
 *
 *   node --experimental-strip-types tools/eval/runEvolvePropose.ts \
 *     [--sessions-dir <dir>] [--skill-history <file>] [--min-count N] \
 *     [--out <file>] [--json] [--dry-run]
 *
 * Data sources (same contract as runEvidenceReport.ts):
 *  - session spine JSONL: <cwd>/.zelari/sessions/<id>/events.jsonl
 *    (override ZELARI_SESSIONS_DIR);
 *  - skill history JSONL: ~/.tmp/zelari-code/skill-history.jsonl
 *    (override ANATHEMA_SKILL_HISTORY_FILE). Missing file → the skill
 *    findings are OMITTED with an honest note — that is not an error.
 *
 * Proposal store: <cwd>/.zelari/evolution/proposals.jsonl (override --out).
 * Append-only JSONL, one proposal per line; dedupe by fingerprint, always
 * fail-closed (unknown stored status BLOCKS re-proposal).
 *
 * ADVISORY by construction (like runEvidenceReport.ts): exit 0 no matter
 * what is proposed — nothing is ever applied here. Exit 2 only for usage
 * errors. Zero findings yields an honest "nothing to propose", exit 0.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { aggregateSpineEvidence } from './spineEvidence.ts';
import { type EvidenceFinding } from './spineEvidence.ts';
import { aggregateSkillEvidence } from './skillEvidence.ts';
import {
  appendProposals,
  buildProposals,
  parseProposalStore,
  type EvolutionProposal,
  type StoredProposal,
} from './evolvePropose.ts';

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** True when `--name` is present but its value is missing (absent or another flag). Usage error. */
function flagWithoutValue(name: string): boolean {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && (i + 1 >= argv.length || argv[i + 1].startsWith('--'));
}

function usage(): string {
  return 'usage: runEvolvePropose.ts [--sessions-dir <dir>] [--skill-history <file>] [--min-count N] [--out <file>] [--json] [--dry-run]';
}

// The small scan helpers below are copied LOCALLY from runEvidenceReport.ts
// (they are private there by design — CLI files do not import CLI files).
// Same tolerant behavior: missing/unreadable inputs are honest skips.

/** Split raw file content into record lines (blank lines are skipped downstream). */
function jsonlLines(raw: string): string[] {
  return raw.split(/\r?\n/);
}

/** Scan every subdir of `dir` for events.jsonl. Missing file/dir → session skipped, counted. */
function scanSessions(dir: string): {
  inputs: { sessionId: string; lines: string[] }[];
  skipped: number;
  dirMissing: boolean;
} {
  if (!existsSync(dir)) return { inputs: [], skipped: 0, dirMissing: true };
  const inputs: { sessionId: string; lines: string[] }[] = [];
  let skipped = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const eventsPath = path.join(dir, entry.name, 'events.jsonl');
    if (!existsSync(eventsPath)) {
      skipped += 1;
      continue;
    }
    try {
      inputs.push({ sessionId: entry.name, lines: jsonlLines(readFileSync(eventsPath, 'utf-8')) });
    } catch {
      skipped += 1; // unreadable file is an honest skip, never a crash
    }
  }
  return { inputs, skipped, dirMissing: false };
}

interface SkillScan {
  included: boolean;
  path: string;
  note?: string;
  findings: EvidenceFinding[];
}

function scanSkillHistory(file: string): SkillScan {
  if (!existsSync(file)) {
    return {
      included: false,
      path: file,
      note: 'skill history file not found — skill findings omitted (not an error)',
      findings: [],
    };
  }
  let raw = '';
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return { included: false, path: file, note: 'skill history file unreadable — skill findings omitted', findings: [] };
  }
  // Unparseable lines are passed through raw: aggregateSkillEvidence counts
  // them as malformedRecords (single tolerant parse, no double counting).
  const records: unknown[] = [];
  for (const line of jsonlLines(raw)) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push(line);
    }
  }
  return { included: true, path: file, findings: aggregateSkillEvidence(records).findings };
}

/** Missing store → empty; unreadable store → behaves like empty (append layer will too). */
function readStore(file: string): { records: StoredProposal[]; malformed: number } {
  if (!existsSync(file)) return { records: [], malformed: 0 };
  try {
    return parseProposalStore(jsonlLines(readFileSync(file, 'utf-8')));
  } catch {
    return { records: [], malformed: 0 };
  }
}

function formatProposalLine(p: EvolutionProposal): string {
  const validate = p.requiredValidation.length > 0 ? p.requiredValidation.join(', ') : '(none — review only)';
  return `[${p.id}] ${p.status} ${p.operator} ${p.surface} — ${p.evidence.kinds.join('+')} x${p.evidence.count} — validate: ${validate}`;
}

function main(): number {
  for (const valueFlag of ['sessions-dir', 'skill-history', 'min-count', 'out']) {
    if (flagWithoutValue(valueFlag)) {
      console.error(`runEvolvePropose: --${valueFlag} requires a value`);
      console.error(usage());
      return 2;
    }
  }
  const minCountRaw = arg('min-count');
  if (minCountRaw !== undefined && !/^\d+$/.test(minCountRaw)) {
    console.error('runEvolvePropose: --min-count must be a positive integer');
    console.error(usage());
    return 2;
  }
  const minCount = Number.parseInt(minCountRaw ?? '3', 10);
  if (minCount < 1) {
    console.error('runEvolvePropose: --min-count must be a positive integer');
    console.error(usage());
    return 2;
  }

  const sessionsDir = path.resolve(
    arg('sessions-dir') ?? process.env.ZELARI_SESSIONS_DIR ?? path.join(cwd(), '.zelari', 'sessions'),
  );
  const skillHistoryPath = path.resolve(
    arg('skill-history') ??
      process.env.ANATHEMA_SKILL_HISTORY_FILE ??
      path.join(homedir(), '.tmp', 'zelari-code', 'skill-history.jsonl'),
  );
  const outPath = path.resolve(arg('out') ?? path.join(cwd(), '.zelari', 'evolution', 'proposals.jsonl'));
  const dryRun = argv.includes('--dry-run');
  const json = argv.includes('--json');

  const scan = scanSessions(sessionsDir);
  const spine = aggregateSpineEvidence(scan.inputs, { minCount });
  const skill = scanSkillHistory(skillHistoryPath);
  const allFindings: EvidenceFinding[] = [...spine.findings, ...skill.findings];

  const store = readStore(outPath);
  const { proposals, deduped, unmapped } = buildProposals(allFindings, store.records);
  const { written } = appendProposals(outPath, proposals, { dryRun });

  if (json) {
    console.log(JSON.stringify({ proposals, deduped, unmapped, storePath: outPath, written }, null, 2));
    // Advisory Fase 2.0: proposals never apply — exit 0 regardless.
    return 0;
  }

  const lines: string[] = [];
  lines.push('=== zelari evolve:propose — Fase 2.0 proposal engine (advisory — proposes, never applies) ===');
  if (!skill.included) {
    lines.push(`skill history: OMITTED — ${skill.note} (${skill.path})`);
  }
  if (allFindings.length === 0) {
    lines.push('no evidence patterns above threshold — nothing to propose');
  } else {
    lines.push(
      `findings in: ${allFindings.length} → proposals: ${proposals.length} new, ${deduped} deduped, ${unmapped} unmapped`,
    );
    for (const p of proposals) lines.push(formatProposalLine(p));
    lines.push(dryRun ? `DRY RUN — nothing written (${outPath})` : `${outPath}: ${written} proposal(s) written`);
  }
  console.log(lines.join('\n'));
  // Advisory Fase 2.0: proposals never apply — exit 0 regardless.
  return 0;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  exit(main());
}
