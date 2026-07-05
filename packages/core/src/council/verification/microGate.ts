import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanKeyframesViolations, scanTransitionViolations } from './parseCssMotion.js';
import { loadNfrSpec, DEFAULT_NFR_SPEC } from './runChecks.js';
import type { NfrSpec } from './types.js';

export interface MicroGateWarning {
  id: string;
  message: string;
  file: string;
  line?: number;
}

function checkDeadHooksInHtml(html: string): MicroGateWarning[] {
  const warnings: MicroGateWarning[] = [];
  const scripts: string[] = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) scripts.push(sm[1] ?? '');
  const styleText = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? []).join('\n');
  const addRe = /classList\.add\(\s*['"]([\w-]+)['"]\s*\)/g;
  for (const script of scripts) {
    let am: RegExpExecArray | null;
    addRe.lastIndex = 0;
    while ((am = addRe.exec(script)) !== null) {
      const cls = am[1] ?? '';
      const hasRule =
        new RegExp(`\\.${cls}\\b`).test(styleText) ||
        new RegExp(`html\\.${cls}\\b`).test(styleText);
      if (!hasRule) {
        warnings.push({
          id: 'css.dead-hook',
          message: `classList.add('${cls}') has no CSS rule (.${cls})`,
          file: '',
        });
      }
    }
  }
  return warnings;
}

/**
 * Quick subset of Gate A on a single file (HTML). Used for inline WARN after writes.
 */
export function runMicroVerificationOnFile(
  projectRoot: string,
  relPath: string,
  zelariRoot?: string,
): MicroGateWarning[] {
  const abs = join(projectRoot, relPath);
  if (!existsSync(abs) || !/\.html?$/i.test(relPath)) return [];
  const spec: NfrSpec = (zelariRoot ? loadNfrSpec(zelariRoot) : null) ?? DEFAULT_NFR_SPEC;
  const anim = spec.animation ?? { compositorOnly: true, forbidLayoutProps: true };
  const scanOpts = {
    compositorOnly: anim.compositorOnly ?? true,
    forbidLayoutProps: anim.forbidLayoutProps ?? true,
  };
  const html = readFileSync(abs, 'utf8');
  const warnings: MicroGateWarning[] = [];

  for (const v of scanKeyframesViolations(html, scanOpts)) {
    warnings.push({
      id: 'motion.keyframes',
      message: `@keyframes uses non-allowed property "${v.property}"`,
      file: relPath,
      line: v.line,
    });
  }
  for (const v of scanTransitionViolations(html, scanOpts)) {
    warnings.push({
      id: 'motion.transitions',
      message: `transition uses non-allowed property "${v.property}"`,
      file: relPath,
      line: v.line,
    });
  }
  for (const w of checkDeadHooksInHtml(html)) {
    warnings.push({ ...w, file: relPath });
  }
  return warnings;
}

export function parseProjectRootFromWorkspaceContext(ctx: string): string | null {
  const m = ctx.match(/Working directory:\s*(.+)/m);
  return m?.[1]?.trim() ?? null;
}

/** Run micro-gate when Lucifero writes a target HTML file. */
export function runChairmanMicroGate(input: {
  projectRoot: string;
  relPath: string;
  zelariRoot?: string;
}): MicroGateWarning[] {
  const normalized = input.relPath.replace(/\\/g, '/');
  const spec = (input.zelariRoot ? loadNfrSpec(input.zelariRoot) : null) ?? DEFAULT_NFR_SPEC;
  const inTarget = spec.targets.some(
    (t) => normalized === t || normalized.endsWith(`/${t}`),
  );
  if (!inTarget && !/\.html?$/i.test(normalized)) return [];
  return runMicroVerificationOnFile(input.projectRoot, normalized, input.zelariRoot);
}
