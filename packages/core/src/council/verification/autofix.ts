import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyInlineJsAutofix } from './inlineJsAutofix.js';
import { applyMotionAutofix } from './motionAutofix.js';
import type { VerificationReport } from './types.js';

export interface AutofixResult {
  applied: boolean;
  filesChanged: string[];
  fixes: string[];
}

/**
 * Deterministic autofix for motion, inline-js budget, and css.dead-hook.
 * Max one pass per hook invocation — no LLM loop.
 */
export function applyDeterministicAutofix(
  projectRoot: string,
  report: VerificationReport,
): AutofixResult {
  const motion = applyMotionAutofix(projectRoot, report);
  const inlineJs = applyInlineJsAutofix(projectRoot, report);
  const filesChanged = [...motion.filesChanged, ...inlineJs.filesChanged];
  const fixes = [...motion.fixes, ...inlineJs.fixes];

  const deadHooks = report.results.filter(
    (r) => r.id === 'css.dead-hook' && !r.ok && r.file,
  );
  for (const r of deadHooks) {
    const rel = r.file!;
    if (filesChanged.includes(rel)) continue;
    const m = r.evidence?.match(/classList\.add\(\s*['"]([\w-]+)['"]\s*\)/);
    if (!m || m[1] === 'rm') continue;
    const abs = join(projectRoot, rel);
    let html = readFileSync(abs, 'utf8');
    const snippet = m[0]!;
    if (!html.includes(snippet)) continue;
    const lines = html.split(/\r?\n/);
    const filtered = lines.filter((line) => !line.includes(snippet));
    if (filtered.length === lines.length) continue;
    writeFileSync(abs, filtered.join('\n'), 'utf8');
    filesChanged.push(rel);
    fixes.push(`removed dead hook line in ${rel}: ${snippet}`);
  }

  return {
    applied: filesChanged.length > 0,
    filesChanged: [...new Set(filesChanged)],
    fixes,
  };
}
