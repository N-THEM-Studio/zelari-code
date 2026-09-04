#!/usr/bin/env node
/**
 * verify-principles.mjs — mechanical gate for the enforceable first principles.
 *
 * Ratified by PRINCIPLES.md (ADR-0010). Checks what can be checked
 * deterministically:
 *   P4  — license coherence (Apache-2.0 across the monorepo)
 *   P4  — secrecy policy coherence ("open runtime, protected experience")
 *   P5  — lightness: heavy-dep blacklist + @zelari/core runtime allowlist
 *   P2  — hooks choke-point lives in the registry invoke path
 *   P2  — Zod schemas in every builtin tool file that defines a tool
 *   —   — manifesto linkage (PRINCIPLES.md referenced and complete)
 *   —   — soft preferences: one tool per file, <= ~300 LOC (warnings only)
 *
 * Exit 0 when every hard check passes (warnings are allowed); exit 1 otherwise.
 * Used locally via `npm run verify:principles` and as a merge gate in
 * .github/workflows/ci.yml.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Product packages whose license and dependency policy is governed here. */
const PRODUCT_PACKAGES = ['package.json', 'packages/core/package.json', 'apps/desktop/package.json'];

/** Classic "heavy utility" libraries the repo convention bans (AGENTS.MD). */
const HEAVY_DEP_BLACKLIST = [
  /^lodash(-|$)/, /^immer$/, /^ramda$/, /^moment(-|$)/, /^axios$/, /^rxjs$/,
  /^underscore$/, /^jquery$/, /^bluebird$/, /^superagent$/, /^cheerio$/,
];

/**
 * P5: @zelari/core runtime dependencies. The core must stay std-lib first;
 * zod is the only sanctioned runtime dependency (schema engine).
 */
const CORE_RUNTIME_ALLOWLIST = new Set(['zod']);

const BUILTIN_TOOLS_DIR = 'packages/core/src/core/tools/builtin';

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function readJson(root, rel) {
  const text = readText(root, rel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function listTsFiles(root, relDir) {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.ts')) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** P4 — the whole monorepo is Apache-2.0. */
function checkLicenseCoherence(root, report) {
  const licenseText = readText(root, 'LICENSE');
  if (licenseText === null || !licenseText.startsWith('Apache License')) {
    report.error('license', 'LICENSE missing or not the Apache-2.0 text (P4)');
  } else {
    report.ok('license', 'LICENSE is Apache-2.0');
  }
  const coreLicenseText = readText(root, 'packages/core/LICENSE');
  const normalizeLicense = (text) => text?.replace(/\r\n/g, '\n').trimEnd();
  if (normalizeLicense(coreLicenseText) !== normalizeLicense(licenseText)) {
    report.error(
      'license',
      'packages/core/LICENSE must exactly match the root Apache-2.0 LICENSE (P4)',
    );
  } else {
    report.ok('license', 'packages/core/LICENSE matches root Apache-2.0 text');
  }
  for (const rel of PRODUCT_PACKAGES) {
    const pkg = readJson(root, rel);
    if (pkg === null) {
      report.error('license', rel + ' unreadable or invalid JSON');
      continue;
    }
    if (pkg.license === 'Apache-2.0') {
      report.ok('license', rel + ' → Apache-2.0');
    } else {
      report.error('license', rel + ' has license "' + pkg.license + '" — expected Apache-2.0 (P4)');
    }
  }
}

/** P4 — secrecy policy stays coherent with the open license. */
function checkSecrecyCoherence(root, report) {
  const rel = 'packages/core/src/agents/secrecyPolicy.ts';
  const text = readText(root, rel);
  if (text === null) {
    report.error('secrecy', rel + ' missing');
    return;
  }
  const marker = text.includes('## Proprietary Confidentiality');
  const apache = text.includes('Apache-2.0');
  const framing = text.includes('proprietary product surface');
  const hardRules = text.includes('Hard rules (non-negotiable)');
  if (marker && apache && framing && hardRules) {
    report.ok('secrecy', 'policy keeps marker, hard rules, and the Apache-2.0 framing');
  } else {
    report.error(
      'secrecy',
      rel + ' drifted: marker=' + marker + ' apache2=' + apache + ' framing=' + framing + ' hardRules=' + hardRules + ' (P4)',
    );
  }
}

/** P5 — no heavy utility deps; core runtime deps stay minimal. */
function checkDependencyPolicy(root, report) {
  let clean = true;
  for (const rel of PRODUCT_PACKAGES) {
    const pkg = readJson(root, rel);
    if (pkg === null) continue;
    for (const section of ['dependencies', 'devDependencies']) {
      for (const dep of Object.keys(pkg[section] ?? {})) {
        if (HEAVY_DEP_BLACKLIST.some((re) => re.test(dep))) {
          clean = false;
          report.error('deps', rel + ' ' + section + ' includes banned heavy dependency "' + dep + '" (P5)');
        }
      }
    }
  }
  const core = readJson(root, 'packages/core/package.json');
  if (core) {
    const deps = Object.keys(core.dependencies ?? {});
    const offenders = deps.filter((d) => !CORE_RUNTIME_ALLOWLIST.has(d));
    if (offenders.length > 0) {
      clean = false;
      report.error(
        'deps',
        '@zelari/core runtime dependencies outside the allowlist {zod}: ' + offenders.join(', ') + ' (P5)',
      );
    } else {
      report.ok('deps', '@zelari/core runtime deps ⊆ {zod} — std-lib first (P5)');
    }
  }
  if (clean) report.ok('deps', 'no banned heavy deps in product packages');
}

/** P2 — Zod schema per tool: every builtin file defining a tool imports zod. */
function checkZodToolSchemas(root, report) {
  let ok = true;
  for (const abs of listTsFiles(root, BUILTIN_TOOLS_DIR)) {
    const text = fs.readFileSync(abs, 'utf8');
    if (!/ToolDefinition</.test(text)) continue; // helper module, no tool
    if (!/from ['"]zod['"]/.test(text)) {
      ok = false;
      report.error('zod-tools', path.relative(root, abs) + ' defines a tool but imports no zod schema (P2 derivation)');
    }
  }
  if (ok) report.ok('zod-tools', 'every builtin tool file imports zod for its args schema');
}

/** P2 — the lifecycle-hook choke-point must live in the registry invoke path. */
function checkHooksChokePoint(root, report) {
  const rel = 'packages/core/src/core/tools/registry.ts';
  const text = readText(root, rel);
  if (text === null) {
    report.error('hooks', rel + ' missing');
    return;
  }
  const wired =
    text.includes('LifecycleHookRunner') &&
    text.includes('runPreToolUse(') &&
    text.includes('runPostToolUse(');
  if (wired) {
    report.ok('hooks', 'LifecycleHookRunner wired at the ToolRegistry.invoke choke-point (P2)');
  } else {
    report.error('hooks', rel + ' lost the lifecycle-hook wiring (P2)');
  }
}

/**
 * ADR-0036 — the "judge": everything that decides safety (P2) or measures
 * fitness (P1). Evolution artifacts may never live in, or be imported by,
 * these paths. Exported for scripts/touches-judge.mjs (CI PR labeling).
 * Keep this list honest: the check below fails if a path goes missing.
 */
export const JUDGE_PATHS = [
  'packages/core/src/core/tools/registry.ts',   // P2 choke-point (ToolRegistry.invoke)
  'packages/core/src/council/verification',     // honesty lint + tier ranking
  'src/cli/safety',                             // permissions policy, lifecycle hooks policy
  'eval/anchors',                               // Tier-0 eval anchors (sealed, ADR-0036)
  'tools/eval/runGate.ts',                      // deterministic eval gate runner
  '.github/workflows/eval-retention-gate.yml',  // retention gate
  'scripts/verify-principles.mjs',              // this gate
];

/** Evolution-genome locations (ADR-0036): proposer side, never judge. */
const EVOLUTION_PATHS = ['.zelari/evolution', 'src/cli/evolution'];

/** ADR-0036 — proposer/judge separation, enforced mechanically. */
function checkJudgePaths(root, report) {
  let ok = true;
  for (const rel of JUDGE_PATHS) {
    if (!fs.existsSync(path.join(root, rel))) {
      ok = false;
      report.error('judge', rel + ' is listed in JUDGE_PATHS but missing — keep the list honest (ADR-0036)');
    }
    if (EVOLUTION_PATHS.some((e) => rel === e || rel.startsWith(e + '/'))) {
      ok = false;
      report.error('judge', rel + ' is an evolution path listed in JUDGE_PATHS (ADR-0036)');
    }
  }
  const judgeFiles = [];
  for (const rel of JUDGE_PATHS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const f of listTsFiles(root, rel)) judgeFiles.push(f);
    } else if (rel.endsWith('.ts')) {
      judgeFiles.push(abs);
    }
  }
  for (const abs of judgeFiles) {
    const text = fs.readFileSync(abs, 'utf8');
    if (/from\s+['"][^'"]*evolution/.test(text) || /import\(['"][^'"]*evolution/.test(text)) {
      ok = false;
      report.error('judge', path.relative(root, abs) + " imports evolution code — the judge must not depend on the proposer (ADR-0036)");
    }
  }
  if (ok) report.ok('judge', 'JUDGE_PATHS intact; no evolution imports inside the judge (ADR-0036)');
}

/** Manifesto linkage — PRINCIPLES.md is complete and referenced. */
function checkManifestoLinkage(root, report) {
  const text = readText(root, 'PRINCIPLES.md');
  if (text === null) {
    report.error('manifesto', 'PRINCIPLES.md missing');
    return;
  }
  const missing = [];
  for (let i = 1; i <= 6; i += 1) {
    if (!new RegExp('### P' + i + ' · ').test(text)) missing.push('P' + i);
  }
  if (missing.length > 0) {
    report.error('manifesto', 'PRINCIPLES.md missing sections: ' + missing.join(', '));
  } else {
    report.ok('manifesto', 'PRINCIPLES.md defines P1–P6');
  }
  // The repo tracks this file as AGENTS.MD (uppercase MD). On
  // case-sensitive filesystems (Linux CI) the lowercase form would ENOENT,
  // so probe both spellings and accept the one that exists.
  for (const rel of ['AGENTS.MD', 'README.md']) {
    const doc = readText(root, rel);
    if (doc !== null && doc.includes('PRINCIPLES.md')) {
      report.ok('manifesto', rel + ' links PRINCIPLES.md');
    } else {
      report.error('manifesto', rel + ' does not reference PRINCIPLES.md');
    }
  }
}

/** Soft preference: one tool definition per builtin file. */
function checkOneToolPerFile(root, report) {
  for (const abs of listTsFiles(root, BUILTIN_TOOLS_DIR)) {
    const text = fs.readFileSync(abs, 'utf8');
    const count = (text.match(/ToolDefinition</g) ?? []).length;
    if (count > 1) {
      report.warn('one-tool', path.relative(root, abs) + ' defines ' + count + ' tools (convention prefers one per file)');
    }
  }
}

/** Soft preference: modules <= ~300 LOC. */
function checkLocPreferences(root, report) {
  const offenders = [];
  for (const relDir of ['packages/core/src', 'src/cli']) {
    for (const abs of listTsFiles(root, relDir)) {
      if (/.test.ts$/.test(abs)) continue;
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
      if (lines > 300) offenders.push({ rel: path.relative(root, abs), lines });
    }
  }
  offenders.sort((a, b) => b.lines - a.lines);
  for (const o of offenders.slice(0, 15)) {
    report.warn('loc', o.rel + ' is ' + o.lines + ' LOC (preference: <= ~300)');
  }
  if (offenders.length > 15) report.warn('loc', '…and ' + (offenders.length - 15) + ' more files over 300 LOC');
}

/**
 * Run every check. Returns { ok, errors, warnings }.
 * @param {string} root repo root (defaults to the monorepo root)
 * @param {{ok:Function,error:Function,warn:Function}} [report]
 */
export function runVerifyPrinciples(root = REPO_ROOT, report = { ok() {}, error() {}, warn() {} }) {
  const errors = [];
  const warnings = [];
  const sink = {
    ok: (check, msg) => report.ok?.(check, msg),
    error: (check, msg) => {
      errors.push({ check, msg });
      report.error?.(check, msg);
    },
    warn: (check, msg) => {
      warnings.push({ check, msg });
      report.warn?.(check, msg);
    },
  };
  checkLicenseCoherence(root, sink);
  checkSecrecyCoherence(root, sink);
  checkDependencyPolicy(root, sink);
  checkZodToolSchemas(root, sink);
  checkHooksChokePoint(root, sink);
  checkJudgePaths(root, sink);
  checkManifestoLinkage(root, sink);
  checkOneToolPerFile(root, sink);
  checkLocPreferences(root, sink);
  return { ok: errors.length === 0, errors, warnings };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const result = runVerifyPrinciples(REPO_ROOT, {
    ok: (check, msg) => console.log('  ✓ [' + check + '] ' + msg),
    error: (check, msg) => console.error('  ✗ [' + check + '] ' + msg),
    warn: (check, msg) => console.warn('  ⚠ [' + check + '] ' + msg),
  });
  console.log('');
  console.log(
    '[verify-principles] ' +
      (result.ok ? 'PASS' : 'FAIL') +
      ' — errors: ' + result.errors.length +
      ', warnings: ' + result.warnings.length,
  );
  process.exit(result.ok ? 0 : 1);
}
