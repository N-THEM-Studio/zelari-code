#!/usr/bin/env node
/**
 * dogfood-audit.mjs — ADR-0007-style sampled audit for t52 (W5.2 dogfooding):
 * compare what a chairman synthesis CLAIMS with the evidence that actually
 * landed in the diff. Deterministic and offline — it reads text and `git diff`,
 * never a model, never the network, never a JUDGE_PATH file.
 *
 *   node scripts/dogfood-audit.mjs --synthesis <path|-> [--base <ref>]
 *                                  [--out <md>] [--cwd <dir>]
 *
 * Claim grammar (small and deterministic): file-like tokens with a `/` ending
 * in a typical extension (.ts .tsx .mjs .js .md .json .yml) or starting with a
 * repo prefix (src/ packages/ scripts/ docs/ apps/ tools/ .github/), plus
 * backtick-quoted spans — paths are scored, other identifiers are reported as
 * informational (an identifier is not evidence for a file).
 *
 * Verdict — the exit code IS the contract (see tools/eval/runExploreFlipGate.ts):
 *   0  PASS / NO-PATH-CLAIMS — every asserted path is in `git diff --name-only`.
 *      Zero path claims on non-empty input is NOT a pass claim: the status says
 *      so and the diff is listed as "ground (not claimed)". Exit 0, warn.
 *   1  FAIL              — at least one asserted path is not in the diff.
 *   2  INSUFFICIENT-DATA — empty synthesis, empty diff, unreadable synthesis,
 *      unavailable git/ref or a usage error. Never a pass, never invented green.
 * Strict: a path merely mentioned in the diff body (rename source, deletion,
 * context line) is NOT grounded — only a changed file counts as evidence.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE = 'origin/main';
export const DEFAULT_OUT = path.join('.zelari', 'dogfood', 'audit.md');

const REPO_PREFIXES = ['src/', 'packages/', 'scripts/', 'docs/', 'apps/', 'tools/', '.github/'];
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.md', '.json', '.yml'];
const PATH_TOKEN = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g;
const BACKTICK_SPAN = /`([^`\n]+)`/g;

/** Drop the punctuation a prose sentence glues onto a path, and normalise separators. */
export function normalizeClaim(raw) {
  const trimmed = String(raw).trim().replace(/\\/g, '/').replace(/^[([{"'`]+/, '');
  return trimmed.replace(/[)\]}"'`,.;:]+$/, '').replace(/^\.\//, '');
}

/** True when a token is path-like enough to be audited against the diff. */
export function isPathLike(token) {
  if (!token.includes('/') || !/^[A-Za-z0-9_.]/.test(token)) return false;
  return EXTENSIONS.some((ext) => token.endsWith(ext)) || REPO_PREFIXES.some((p) => token.startsWith(p));
}

/** Extract the claims of a synthesis: scored paths first, identifiers for the record. */
export function extractClaims(text) {
  const paths = [];
  const identifiers = [];
  const seen = new Set();
  const note = (raw) => {
    const claim = normalizeClaim(raw);
    if (!claim || seen.has(claim)) return;
    seen.add(claim);
    (isPathLike(claim) ? paths : identifiers).push(claim);
  };
  const src = String(text ?? '');
  for (const m of src.matchAll(BACKTICK_SPAN)) note(m[1]);
  for (const m of src.matchAll(PATH_TOKEN)) {
    // A URL is not a repo path: skip tokens glued to "//".
    if (src.slice(Math.max(0, m.index - 3), m.index).includes('//')) continue;
    note(m[0]);
  }
  return { paths, identifiers };
}

/** Exact path first, then repo-relative suffix (`scripts/x.mjs` matches `a/scripts/x.mjs`). */
export function findGrounding(claim, diffPaths) {
  const exact = diffPaths.find((f) => f === claim);
  if (exact) return exact;
  return diffPaths.find((f) => f.endsWith('/' + claim)) ?? null;
}

function verdict(common, status, exitCode, reason, rows = []) {
  return { ...common, rows, status, exitCode, reason };
}

/** The decision table. Pure: it receives the synthesis and the diff, never reads them. */
export function auditClaims({ synthesis, diffPaths, diffText = '', base }) {
  const { paths, identifiers } = extractClaims(synthesis);
  const changed = (diffPaths ?? []).map((p) => p.replace(/\\/g, '/')).filter(Boolean);
  const common = { identifiers, paths, changed, base };

  if (String(synthesis ?? '').trim().length === 0) {
    return verdict(common, 'insufficient-data', 2, 'empty chairman synthesis — nothing to audit (never PASS on empty input)');
  }
  if (changed.length === 0) {
    return verdict(common, 'insufficient-data', 2, `empty diff vs ${base} (identical trees, or nothing landed) — no evidence to compare against`);
  }

  const rows = paths.map((claim) => {
    const hit = findGrounding(claim, changed);
    if (hit) return { claim, status: 'grounded', evidence: `changed in diff: ${hit}` };
    return {
      claim,
      status: 'ungrounded',
      evidence: diffText.includes(claim)
        ? 'not a changed file — appears in the diff body only (rename source / deletion / context); a mention is not evidence'
        : 'not in `git diff --name-only` and not referenced in the diff',
    };
  });
  const bad = rows.filter((r) => r.status === 'ungrounded');
  if (bad.length > 0) {
    const list = bad.map((r) => r.claim).slice(0, 5).join(', ');
    return verdict(common, 'fail', 1, `${bad.length}/${rows.length} asserted path(s) not in the diff: ${list}`, rows);
  }
  if (rows.length === 0) {
    return verdict(
      common,
      'no-path-claims',
      0,
      `no path claims in the synthesis (${changed.length} file(s) changed) — nothing confirmed; the diff is listed as ground (not claimed)`,
      rows,
    );
  }
  return verdict(common, 'pass', 0, `all ${rows.length} asserted path(s) are in the diff`, rows);
}

/** Markdown report: claim | status | evidence, plus the not-claimed diff files. */
export function formatReport(result, meta) {
  const grounded = result.rows.filter((r) => r.status === 'grounded').length;
  const lines = [
    '# Dogfood audit — synthesis vs diff (t52)',
    '',
    `- base: \`${meta.base}\``,
    `- status: **${result.status.toUpperCase()}** (exit ${result.exitCode}) — ${result.reason}`,
    `- diff: ${result.changed.length} changed file(s)`,
    `- claims: ${result.rows.length} path claim(s)${result.rows.length > 0 ? ` (${grounded} grounded, ${result.rows.length - grounded} ungrounded)` : ''}, ` +
      `${result.identifiers.length} backticked identifier(s)`,
    '- rule: only files in `git diff --name-only <base>...HEAD` count as evidence — strict by design',
    '',
  ];
  if (result.rows.length > 0) {
    lines.push('| claim | status | evidence |', '|---|---|---|');
    for (const row of result.rows) lines.push(`| \`${row.claim}\` | ${row.status} | ${row.evidence} |`);
    lines.push('', '');
  }
  if (result.status === 'insufficient-data') lines.push('_No verdict: the audit refused to score — this is not a pass._', '');
  if (result.rows.length === 0 && result.changed.length > 0) {
    lines.push('## Ground (not claimed)', '', ...result.changed.map((f) => `- \`${f}\``), '');
  }
  if (result.identifiers.length > 0) {
    lines.push(`Identifiers (informational, not path-checked): ${result.identifiers.map((i) => `\`${i}\``).join(', ')}`, '');
  }
  lines.push('_Generated by `scripts/dogfood-audit.mjs` — deterministic, no model, no network._');
  return lines.join('\n') + '\n';
}

export function firstLine(err) {
  return String((err && err.message) || err).split('\n')[0];
}

/** Read the changed-file list and the full diff; never throws. */
export function readDiff(base, cwd) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const names = run(['diff', '--name-only', `${base}...HEAD`]);
    const text = run(['diff', `${base}...HEAD`]);
    return { ok: true, paths: names.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), text };
  } catch (err) {
    return { ok: false, paths: [], text: '', error: firstLine(err) };
  }
}

/** A file path, or `-` for stdin. */
export async function readSynthesis(source, cwd) {
  if (source === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFileSync(path.resolve(cwd, source), 'utf8');
}

export const USAGE =
  'usage: node scripts/dogfood-audit.mjs --synthesis <path|-> [--base <ref>] [--out <md>] [--cwd <dir>]\n' +
  '       exit: 0 pass/no-path-claims · 1 fail (ungrounded path) · 2 insufficient-data/usage';
export function parseArgs(args) {
  const opts = { synthesis: null, base: DEFAULT_BASE, out: DEFAULT_OUT, cwd: process.cwd() };
  const valued = { '--synthesis': 'synthesis', '--base': 'base', '--out': 'out', '--cwd': 'cwd' };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const key = valued[flag];
    if (!key) return `unknown argument "${flag}"`;
    const next = args[i + 1];
    if (next === undefined) return `${flag} requires a value`;
    i += 1;
    opts[key] = key === 'cwd' ? path.resolve(next) : next;
  }
  if (!opts.synthesis) return '--synthesis <path|-> is required';
  return opts;
}

export async function main(args) {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    console.error(`dogfood-audit: ${parsed}`);
    console.error(USAGE);
    return 2;
  }

  let synthesis;
  try {
    synthesis = await readSynthesis(parsed.synthesis, parsed.cwd);
  } catch (err) {
    console.error(`dogfood-audit: INSUFFICIENT-DATA — cannot read synthesis "${parsed.synthesis}" (${firstLine(err)})`);
    return 2;
  }

  const diff = readDiff(parsed.base, parsed.cwd);
  const result = diff.ok
    ? auditClaims({ synthesis, diffPaths: diff.paths, diffText: diff.text, base: parsed.base })
    : verdict(
        { identifiers: [], paths: [], changed: [], base: parsed.base },
        'insufficient-data',
        2,
        `git diff vs "${parsed.base}" unavailable (${diff.error}) — no evidence readable, never PASS`,
      );

  let reportPath = null;
  if (parsed.out !== '-') {
    try {
      reportPath = path.resolve(parsed.cwd, parsed.out);
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, formatReport(result, { base: parsed.base }), 'utf8');
    } catch (err) {
      console.error(`dogfood-audit: report not written (${firstLine(err)})`);
      reportPath = null;
    }
  }

  const grounded = result.rows.filter((r) => r.status === 'grounded').length;
  const claims = `${result.rows.length} path (grounded ${grounded}, ungrounded ${result.rows.length - grounded}), ${result.identifiers.length} identifier`;
  console.log(`dogfood-audit: ${result.status.toUpperCase()} (exit ${result.exitCode}) — ${result.reason}`);
  console.log(`diff: ${result.changed.length} file(s) vs ${parsed.base} | claims: ${claims}`);
  console.log(`report: ${reportPath ?? 'not written (--out -)'}`);
  if (result.exitCode === 2) console.error(`dogfood-audit: INSUFFICIENT-DATA — ${result.reason}`);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
