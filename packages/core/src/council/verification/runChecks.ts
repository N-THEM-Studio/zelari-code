import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyCitations } from './citeVerify.js';
import { lintSynthesisHonesty } from './honesty.js';
import { scanKeyframesViolations, scanTransitionViolations } from './parseCssMotion.js';
import { auditDegradedBanner } from './degraded.js';
import { auditSynthesisTiers } from './synthesisAudit.js';
import type {
  NfrSpec,
  RunVerificationInput,
  VerificationCheckResult,
  VerificationReport,
} from './types.js';

export const DEFAULT_NFR_SPEC: NfrSpec = {
  version: 1,
  targets: ['index.html'],
  animation: { compositorOnly: true, forbidLayoutProps: true },
  inlineJs: { maxBytes: 5120 },
  planFeatureKeywords: [
    'command palette',
    'theme toggle',
    'theme-toggle',
    '@media print',
    'print stylesheet',
  ],
};

export function loadNfrSpec(zelariRoot: string): NfrSpec | null {
  const path = join(zelariRoot, 'nfr-spec.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as NfrSpec;
    if (raw.version !== 1 || !Array.isArray(raw.targets)) return null;
    return raw;
  } catch {
    return null;
  }
}

function resolveTargets(projectRoot: string, spec: NfrSpec): string[] {
  const found: string[] = [];
  for (const rel of spec.targets) {
    if (existsSync(join(projectRoot, rel))) {
      found.push(rel);
    }
  }
  if (found.length === 0 && existsSync(join(projectRoot, 'index.html'))) {
    return ['index.html'];
  }
  return found;
}

function checkInlineJsBudget(html: string, relFile: string, maxBytes: number): VerificationCheckResult[] {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  const js = m[1] ?? '';
  const bytes = Buffer.byteLength(js, 'utf8');
  if (bytes <= maxBytes) return [];
  return [{
    id: 'inline-js.budget',
    severity: 'error',
    ok: false,
    tier: 'grep',
    file: relFile,
    message: `Inline script is ${bytes} bytes (limit ${maxBytes})`,
    evidence: `${bytes} bytes`,
  }];
}

function checkDeadCssHooks(html: string, relFile: string): VerificationCheckResult[] {
  const results: VerificationCheckResult[] = [];
  const scriptBlocks: string[] = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) {
    scriptBlocks.push(sm[1] ?? '');
  }
  const styleText = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? []).join('\n');
  const addRe = /classList\.add\(\s*['"]([\w-]+)['"]\s*\)/g;
  for (const script of scriptBlocks) {
    let am: RegExpExecArray | null;
    addRe.lastIndex = 0;
    while ((am = addRe.exec(script)) !== null) {
      const cls = am[1] ?? '';
      const hasRule =
        new RegExp(`\\.${cls}\\b`).test(styleText) ||
        new RegExp(`html\\.${cls}\\b`).test(styleText) ||
        new RegExp(`:${cls}\\b`).test(styleText);
      if (!hasRule) {
        results.push({
          id: 'css.dead-hook',
          severity: 'error',
          ok: false,
          tier: 'grep',
          file: relFile,
          message: `classList.add('${cls}') has no matching CSS rule (.${cls})`,
          evidence: am[0],
        });
      }
    }
  }
  return results;
}

function checkPlanReality(
  projectRoot: string,
  zelariRoot: string,
  targets: string[],
  keywords: string[],
): VerificationCheckResult[] {
  const planPath = join(zelariRoot, 'plan.json');
  if (!existsSync(planPath) || keywords.length === 0) return [];
  let plan: { milestones?: Array<{ description?: string; name?: string }> };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    return [];
  }
  const milestoneText = (plan.milestones ?? [])
    .map((m) => `${m.name ?? ''} ${m.description ?? ''}`)
    .join(' ')
    .toLowerCase();
  const results: VerificationCheckResult[] = [];
  const targetContent = targets
    .map((t) => readFileSync(join(projectRoot, t), 'utf8').toLowerCase())
    .join('\n');
  for (const kw of keywords) {
    const low = kw.toLowerCase();
    if (!milestoneText.includes(low)) continue;
    let found = targetContent.includes(low);
    if (low.includes('print')) {
      found = found || targetContent.includes('@media print');
    }
    if (low.includes('theme')) {
      found = found || targetContent.includes('theme-toggle') || targetContent.includes('theme toggle');
    }
    if (low.includes('command') && low.includes('palette')) {
      found = found || targetContent.includes('command-palette') || targetContent.includes('commandpalette');
    }
    if (!found) {
      results.push({
        id: 'plan.reality',
        severity: 'warn',
        ok: false,
        tier: 'grep',
        file: targets[0],
        message: `Milestone mentions "${kw}" but target file(s) do not contain it (planned, not implemented)`,
      });
    }
  }
  return results;
}

function checkReadmeStale(projectRoot: string, targets: string[]): VerificationCheckResult[] {
  const readmePath = join(projectRoot, 'README.md');
  if (!existsSync(readmePath) || targets.length === 0) return [];
  const readme = readFileSync(readmePath, 'utf8');
  const htmlPath = join(projectRoot, targets[0]!);
  if (!existsSync(htmlPath)) return [];
  const html = readFileSync(htmlPath, 'utf8');
  const sectionCount = (html.match(/<section\s+id=/gi) ?? []).length;
  const readmeSections = readme.match(/(\d+)\s+sezioni/i);
  if (readmeSections) {
    const claimed = Number.parseInt(readmeSections[1] ?? '0', 10);
    if (claimed > 0 && claimed !== sectionCount) {
      return [{
        id: 'docs.readme-stale',
        severity: 'warn',
        ok: false,
        tier: 'grep',
        file: 'README.md',
        message: `README claims ${claimed} sections but ${targets[0]} has ${sectionCount}`,
      }];
    }
  }
  return [];
}

/**
 * Run all deterministic implementation verification checks.
 */
export function runImplementationVerification(input: RunVerificationInput): VerificationReport {
  const persistedSpec = loadNfrSpec(input.zelariRoot);
  const spec = input.nfrSpec ?? persistedSpec ?? DEFAULT_NFR_SPEC;
  const targets = resolveTargets(input.projectRoot, spec);
  const results: VerificationCheckResult[] = [];

  if (!input.nfrSpec && !persistedSpec) {
    results.push({
      id: 'nfr-spec.missing',
      severity: 'warn',
      ok: false,
      tier: 'claimed',
      message: 'No .zelari/nfr-spec.json — using default NFR (compositor-only, layout props forbidden)',
    });
  }

  const anim = spec.animation ?? { compositorOnly: true, forbidLayoutProps: true };
  const scanOpts = {
    compositorOnly: anim.compositorOnly ?? true,
    forbidLayoutProps: anim.forbidLayoutProps ?? true,
  };

  for (const rel of targets) {
    const html = readFileSync(join(input.projectRoot, rel), 'utf8');

    for (const v of scanKeyframesViolations(html, scanOpts)) {
      results.push({
        id: 'motion.keyframes',
        severity: 'error',
        ok: false,
        tier: 'grep',
        file: rel,
        line: v.line,
        message: `@keyframes animates non-allowed property "${v.property}"`,
        evidence: v.snippet,
      });
    }
    for (const v of scanTransitionViolations(html, scanOpts)) {
      results.push({
        id: 'motion.transitions',
        severity: 'error',
        ok: false,
        tier: 'grep',
        file: rel,
        line: v.line,
        message: `transition animates non-allowed property "${v.property}"`,
        evidence: v.snippet,
      });
    }

    if (spec.inlineJs?.maxBytes) {
      results.push(...checkInlineJsBudget(html, rel, spec.inlineJs.maxBytes));
    }
    results.push(...checkDeadCssHooks(html, rel));
  }

  results.push(
    ...checkPlanReality(
      input.projectRoot,
      input.zelariRoot,
      targets,
      spec.planFeatureKeywords ?? [],
    ),
  );
  results.push(...checkReadmeStale(input.projectRoot, targets));

  const fileResults = [...results];
  const preliminaryReport: VerificationReport = {
    ok: fileResults.filter((r) => !r.ok && r.severity === 'error').length === 0,
    generatedAt: new Date().toISOString(),
    runMode: 'implementation',
    targets,
    results: fileResults,
  };

  results.push(...lintSynthesisHonesty(input.synthesisText));
  results.push(...verifyCitations(input.projectRoot, input.synthesisText));
  results.push(...auditSynthesisTiers(input.synthesisText, preliminaryReport));
  if (input.degradedRun) {
    results.push(...auditDegradedBanner(input.synthesisText, true));
  }

  const blocking = results.filter((r) => !r.ok && r.severity === 'error');
  return {
    ok: blocking.length === 0,
    generatedAt: new Date().toISOString(),
    runMode: 'implementation',
    targets,
    results,
  };
}

/** Persist verification report to `.zelari/verification-report.json`. */
export function writeVerificationReport(zelariRoot: string, report: VerificationReport): string {
  const outPath = join(zelariRoot, 'verification-report.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  return outPath;
}
