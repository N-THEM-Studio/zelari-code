import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationCheckResult } from './types.js';

const CITE_RE =
  /(?:^|[\s|])([A-Za-z0-9_./-]+\.(?:html|css|js|ts|tsx|jsx|md|json)):(?:L)?(\d{1,6})\b/gi;

export interface CiteRef {
  file: string;
  line: number;
  raw: string;
}

/** Extract path:line citations from synthesis text. */
export function extractCitations(text: string): CiteRef[] {
  const out: CiteRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text)) !== null) {
    const file = (m[1] ?? '').replace(/^\.\//, '');
    const line = Number.parseInt(m[2] ?? '0', 10);
    const key = `${file}:${line}`;
    if (!file || line < 1 || seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line, raw: m[0].trim() });
  }
  return out;
}

/**
 * Verify that cited path:line references exist and the line is non-empty.
 */
export function verifyCitations(
  projectRoot: string,
  synthesisText: string | undefined,
): VerificationCheckResult[] {
  if (!synthesisText?.trim()) return [];
  const results: VerificationCheckResult[] = [];
  for (const cite of extractCitations(synthesisText)) {
    const abs = join(projectRoot, cite.file);
    if (!existsSync(abs)) {
      results.push({
        id: 'synthesis.cite-invalid',
        severity: 'error',
        ok: false,
        tier: 'grep',
        file: cite.file,
        line: cite.line,
        message: `Citation ${cite.file}:L${cite.line} — file not found`,
        evidence: cite.raw,
      });
      continue;
    }
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    if (cite.line > lines.length) {
      results.push({
        id: 'synthesis.cite-invalid',
        severity: 'error',
        ok: false,
        tier: 'grep',
        file: cite.file,
        line: cite.line,
        message: `Citation ${cite.file}:L${cite.line} — line out of range (file has ${lines.length} lines)`,
        evidence: cite.raw,
      });
      continue;
    }
    const content = lines[cite.line - 1] ?? '';
    if (!content.trim()) {
      results.push({
        id: 'synthesis.cite-invalid',
        severity: 'error',
        ok: false,
        tier: 'grep',
        file: cite.file,
        line: cite.line,
        message: `Citation ${cite.file}:L${cite.line} — line is empty`,
        evidence: cite.raw,
      });
    }
  }
  return results;
}
