/*
 * tools/eval/runEvidenceReport.ts — Fase 1 — evidence aggregator CLI
 * (report-only, zero mutation; advisory).
 *
 *   node --experimental-strip-types tools/eval/runEvidenceReport.ts \
 *     [--sessions-dir <dir>] [--skill-history <file>] [--min-count N] [--json]
 *
 * Data sources:
 *  - session spine JSONL: <cwd>/.zelari/sessions/<id>/events.jsonl
 *    (override ZELARI_SESSIONS_DIR) — one envelope per line;
 *  - skill history JSONL: ~/.tmp/zelari-code/skill-history.jsonl
 *    (override ANATHEMA_SKILL_HISTORY_FILE). Missing file → the skill
 *    section is OMITTED with an honest note — that is not an error.
 *
 * ADVISORY by construction (like runMeasured.ts): exit 0 no matter what the
 * evidence says — it never mutates, repairs or gates. Exit 2 only for usage
 * errors. An empty/missing sessions dir yields an honest "nothing scanned",
 * not invented green.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { aggregateSpineEvidence, type SpineEvidenceReport } from './spineEvidence.ts';
import { aggregateSkillEvidence, type SkillEvidenceReport } from './skillEvidence.ts';

interface SkillSection {
  included: boolean;
  path: string;
  note?: string;
  report?: SkillEvidenceReport;
}

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function usage(): string {
  return 'usage: runEvidenceReport.ts [--sessions-dir <dir>] [--skill-history <file>] [--min-count N] [--json]';
}

/** Split raw file content into envelope lines (blank lines are skipped downstream). */
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

function scanSkillHistory(file: string): SkillSection {
  if (!existsSync(file)) {
    return {
      included: false,
      path: file,
      note: 'skill history file not found — skill section omitted (not an error)',
    };
  }
  let raw = '';
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return { included: false, path: file, note: 'skill history file unreadable — skill section omitted' };
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
  return { included: true, path: file, report: aggregateSkillEvidence(records) };
}

function formatFinding(f: { severity: string; id: string; count: number; sessions: string[]; detail: string; hint: string }): string {
  const sessions = f.sessions.length > 0 ? ` (sessions: ${f.sessions.join(', ')})` : '';
  return `  [${f.severity.toUpperCase()}] ${f.id} — count ${f.count}${sessions}\n      ${f.detail}\n      hint: ${f.hint}`;
}

function formatHuman(
  report: SpineEvidenceReport,
  skill: SkillSection,
  opts: { skipped: number; dirMissing: boolean; sessionsDir: string; minCount: number },
): string {
  const lines: string[] = [];
  lines.push('=== zelari evidence:report — Fase 1 evidence aggregator (advisory only — no mutation) ===');
  if (opts.dirMissing) {
    lines.push(`sessions dir not found: ${opts.sessionsDir} — nothing scanned (honest empty, not invented green)`);
  }
  const skipNote = opts.skipped > 0 ? ` (${opts.skipped} skipped: no/unreadable events.jsonl)` : '';
  lines.push(
    `sessions scanned: ${report.sessionsScanned}${skipNote} | events: ${report.eventsScanned}` +
      ` | malformed lines: ${report.malformedLines} | unknown-kind events: ${report.unknownKindEvents}` +
      ` | threshold min-count: ${opts.minCount}`,
  );
  if (report.findings.length === 0) {
    lines.push('no evidence patterns above threshold');
  } else {
    lines.push(`findings (${report.findings.length}):`);
    for (const f of report.findings) lines.push(formatFinding(f));
  }
  lines.push('');
  if (!skill.included) {
    lines.push(`skill history: OMITTED — ${skill.note} (${skill.path})`);
  } else {
    const r = skill.report!;
    lines.push(
      `skill history: ${r.recordsScanned} record(s) (${r.malformedRecords} malformed skipped) — findings: ${r.findings.length}`,
    );
    if (r.findings.length === 0) {
      lines.push('no skill evidence patterns above threshold');
    } else {
      for (const f of r.findings) lines.push(formatFinding(f));
    }
  }
  return lines.join('\n');
}

function main(): number {
  const sessionsDirArg = arg('sessions-dir');
  const skillHistoryArg = arg('skill-history');
  const minCountRaw = Number.parseInt(arg('min-count') ?? '3', 10);
  const json = argv.includes('--json');

  if (!Number.isFinite(minCountRaw) || minCountRaw < 1) {
    console.error('runEvidenceReport: --min-count must be a positive integer');
    console.error(usage());
    return 2;
  }

  const sessionsDir = path.resolve(
    sessionsDirArg ?? process.env.ZELARI_SESSIONS_DIR ?? path.join(cwd(), '.zelari', 'sessions'),
  );
  const skillHistoryPath = path.resolve(
    skillHistoryArg ??
      process.env.ANATHEMA_SKILL_HISTORY_FILE ??
      path.join(homedir(), '.tmp', 'zelari-code', 'skill-history.jsonl'),
  );

  const scan = scanSessions(sessionsDir);
  const report = aggregateSpineEvidence(scan.inputs, { minCount: minCountRaw });
  const skill = scanSkillHistory(skillHistoryPath);

  if (json) {
    console.log(
      JSON.stringify(
        {
          advisory: true,
          mutation: 'none',
          sessionsDir,
          sessionsSkipped: scan.skipped,
          skillHistory: skill.path,
          spine: report,
          skill,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatHuman(report, skill, {
      skipped: scan.skipped,
      dirMissing: scan.dirMissing,
      sessionsDir,
      minCount: minCountRaw,
    }));
  }
  // Advisory Fase 1: evidence never gates — exit 0 regardless of findings.
  return 0;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  exit(main());
}
