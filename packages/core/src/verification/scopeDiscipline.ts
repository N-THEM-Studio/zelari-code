/**
 * Scope discipline (Zelari 2.x workstream E) — advisory, no LLM.
 *
 * unexpected file ≠ deterministic fail. Lockfile / generated paths are
 * reported separately so a real source-tree surprise stays visible.
 */

export interface ScopeAnalysisInput {
  changedFiles: string[];
  expectedFiles?: string[];
  inspectedFiles?: string[];
  generatedFiles?: string[];
}

export interface ScopeAnalysisResult {
  status: 'pass' | 'concern' | 'unknown';
  expected: string[];
  unexpected: string[];
  generated: string[];
  reasons: string[];
}

const GENERATED_NAME =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock)$/i;
const GENERATED_DIR = /(?:^|\/)(?:dist|build|out|coverage|\.next|node_modules)\//;

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isGeneratedPath(file: string): boolean {
  const n = normalize(file);
  return GENERATED_NAME.test(n) || GENERATED_DIR.test(n);
}

export function parseNameOnlyDiff(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(normalize);
}

export function analyzeScope(input: ScopeAnalysisInput): ScopeAnalysisResult {
  const changed = input.changedFiles.map(normalize);
  if (changed.length === 0) {
    return {
      status: 'unknown',
      expected: [],
      unexpected: [],
      generated: [],
      reasons: ['no changed files observed'],
    };
  }

  const expectedSet = new Set((input.expectedFiles ?? []).map(normalize));
  const generatedExtra = new Set((input.generatedFiles ?? []).map(normalize));
  const generated: string[] = [];
  const unexpected: string[] = [];
  const expectedHit: string[] = [];

  for (const file of changed) {
    if (generatedExtra.has(file) || isGeneratedPath(file)) {
      generated.push(file);
      continue;
    }
    if (expectedSet.size === 0) {
      expectedHit.push(file);
      continue;
    }
    if (expectedSet.has(file)) expectedHit.push(file);
    else unexpected.push(file);
  }

  const reasons: string[] = [];
  if (unexpected.length > 0) {
    reasons.push(`${unexpected.length} file(s) outside expected scope: ${unexpected.join(', ')}`);
  }
  if (generated.length > 0) {
    reasons.push(`${generated.length} generated/lockfile path(s) ignored for the concern`);
  }

  let status: ScopeAnalysisResult['status'] = 'pass';
  if (expectedSet.size === 0) {
    status = 'unknown';
    reasons.push('no expected-files allowlist — cannot judge scope');
  } else if (unexpected.length > 0) {
    status = 'concern';
  }

  return { status, expected: expectedHit, unexpected, generated, reasons };
}
