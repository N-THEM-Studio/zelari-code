import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationReport } from './types.js';
import { DEFAULT_NFR_SPEC } from './runChecks.js';

const SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script>/i;

/** Strip comments and excess whitespace from inline script bodies. */
function minifyInlineJs(js: string): string {
  let out = js.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
  return out.replace(/\n{2,}/g, '\n');
}

/** Drop optional v0.4 interaction blocks when budget still exceeded. */
function dropOptionalJsBlocks(js: string): string {
  return js
    .replace(
      /\/\*\s*={3,}[^*]*v0\.4[^*]*\*\/[\s\S]*?(?=\/\*\s*={3,}|const openAllFaq|window\.addEventListener\('beforeprint')/i,
      '',
    )
    .replace(
      /if\s*\(\s*!reduceMotion\s*\)\s*\{[\s\S]*?tiltEls\.forEach[\s\S]*?\}\s*\}/,
      '',
    )
    .replace(
      /const hero = document\.querySelector\('\.hero'\);[\s\S]*?aurora\.style\.transition = ''[\s\S]*?\}\s*,\s*600\);\s*\}/,
      '',
    )
    .replace(
      /const flowObserver = new IntersectionObserver[\s\S]*?flowObserver\.observe\(flowEl\);\s*/,
      '',
    );
}

function dropPaddingLiterals(js: string): string {
  return js.replace(/const\s+\w+\s*=\s*["'][^"']{400,}["']\s*;?/g, '');
}

function trimScriptBlock(js: string, maxBytes: number): { js: string; changed: boolean } {
  const original = js;
  let next = js;
  for (let pass = 0; pass < 4; pass++) {
    let step = minifyInlineJs(next);
    if (Buffer.byteLength(step, 'utf8') > maxBytes) {
      step = dropOptionalJsBlocks(step);
      step = minifyInlineJs(step);
    }
    if (Buffer.byteLength(step, 'utf8') > maxBytes) {
      step = dropPaddingLiterals(step);
      step = minifyInlineJs(step);
    }
    if (step === next) break;
    next = step;
    if (Buffer.byteLength(next, 'utf8') <= maxBytes) break;
  }
  return { js: next, changed: next !== original };
}

/** Deterministic inline &lt;script&gt; budget fix when LLM delivery fails. */
export function applyInlineJsAutofix(
  projectRoot: string,
  report: VerificationReport,
): { applied: boolean; filesChanged: string[]; fixes: string[] } {
  const fails = report.results.filter((r) => !r.ok && r.id === 'inline-js.budget' && r.file);
  if (fails.length === 0) {
    return { applied: false, filesChanged: [], fixes: [] };
  }

  const maxBytes = DEFAULT_NFR_SPEC.inlineJs?.maxBytes ?? 5120;
  const filesChanged: string[] = [];
  const fixes: string[] = [];

  for (const r of fails) {
    const rel = r.file ?? 'index.html';
    const abs = join(projectRoot, rel);
    let html: string;
    try {
      html = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const m = SCRIPT_RE.exec(html);
    if (!m) continue;
    const before = m[1] ?? '';
    const { js: after, changed } = trimScriptBlock(before, maxBytes);
    const afterBytes = Buffer.byteLength(after, 'utf8');
    if (!changed || afterBytes > maxBytes) continue;
    const nextHtml = html.replace(SCRIPT_RE, `<script>${after}</script>`);
    writeFileSync(abs, nextHtml, 'utf8');
    filesChanged.push(rel);
    fixes.push(
      `${rel}: trimmed inline script ${Buffer.byteLength(before, 'utf8')}→${afterBytes} bytes`,
    );
  }

  return {
    applied: filesChanged.length > 0,
    filesChanged,
    fixes,
  };
}
