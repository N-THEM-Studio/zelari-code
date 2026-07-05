import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSITOR_ONLY_PROPS,
  LAYOUT_MOTION_PROPS,
  scanKeyframesViolations,
  scanTransitionViolations,
} from './parseCssMotion.js';
import type { VerificationReport } from './types.js';
import { DEFAULT_NFR_SPEC } from './runChecks.js';

const FORBIDDEN_ANIM_PROPS = new Set([
  ...LAYOUT_MOTION_PROPS,
  'box-shadow',
  'background',
  'background-color',
  'background-position',
  'color',
  'border-color',
  'filter',
  'all',
]);

const RM_CSS = `
    .rm *, .rm *::before, .rm *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
      scroll-behavior: auto !important;
    }
    .rm .reveal { opacity: 1 !important; transform: none !important; }
    .rm .section-title h2::after { transform: scaleX(1) !important; }
    .rm .aurora { display: none; }
`;

function isForbiddenAnimProp(prop: string): boolean {
  const p = prop.toLowerCase();
  if (COMPOSITOR_ONLY_PROPS.has(p)) return false;
  return FORBIDDEN_ANIM_PROPS.has(p);
}

/** Keep only transform/opacity tokens in a transition shorthand fragment. */
function sanitizeTransitionPart(part: string): string | null {
  const tokens = part.trim().split(/\s+/);
  if (tokens.length === 0) return null;
  const prop = tokens[0]!.toLowerCase();
  if (prop === 'transform' || prop === 'opacity') return part.trim();
  return null;
}

function sanitizeTransitionValue(value: string): string {
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  const kept = parts
    .map(sanitizeTransitionPart)
    .filter((p): p is string => p !== null);
  return kept.length > 0 ? kept.join(', ') : 'none';
}

const TRANSITION_DECL_RE = /(transition(?:-property)?)\s*:\s*([^;{}]+)/gi;

function sanitizeTransitionsInCss(css: string): string {
  return css.replace(TRANSITION_DECL_RE, (full, prop: string, value: string) => {
    const next = sanitizeTransitionValue(value);
    if (next === value.trim()) return full;
    return `${prop}: ${next}`;
  });
}

const FORBIDDEN_DECL_RE =
  /\s*(?:box-shadow|background-position|background-color|background|color|border-color|filter|height|width|padding(?:-top|-bottom)?|margin(?:-top|-bottom)?|grid-template-rows|grid-template-columns)\s*:[^;{}]+;?/gi;

function sanitizeKeyframeBlock(block: string): string {
  return block.replace(/\{([^{}]*)\}/g, (_m, body: string) => {
    const cleaned = body.replace(FORBIDDEN_DECL_RE, '');
    return `{${cleaned}}`;
  });
}

const KEYFRAMES_BLOCK_RE = /@keyframes\s+[\w-]+\s*\{([^}]*(\{[^}]*\}[^}]*)*)\}/gs;

function sanitizeKeyframesInCss(css: string): string {
  KEYFRAMES_BLOCK_RE.lastIndex = 0;
  return css.replace(KEYFRAMES_BLOCK_RE, (block) => sanitizeKeyframeBlock(block));
}

function injectRmCss(html: string): string {
  if (/\.\brm\b/.test(html) && /\.rm\s*\*/.test(html)) return html;
  const styleClose = html.lastIndexOf('</style>');
  if (styleClose < 0) return html;
  return html.slice(0, styleClose) + RM_CSS + html.slice(styleClose);
}

function sanitizeHtmlMotion(html: string): { html: string; changed: boolean } {
  const styleRe = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;
  let changed = false;
  const out = html.replace(styleRe, (_full, open: string, css: string, close: string) => {
    let next = sanitizeTransitionsInCss(css);
    next = sanitizeKeyframesInCss(next);
    if (next !== css) changed = true;
    return open + next + close;
  });
  const withRm = injectRmCss(out);
  if (withRm !== out) changed = true;
  return { html: withRm, changed };
}

/** Apply deterministic motion + .rm CSS fixes to HTML targets from a verify report. */
export function applyMotionAutofix(
  projectRoot: string,
  report: VerificationReport,
): { applied: boolean; filesChanged: string[]; fixes: string[] } {
  const motionFails = report.results.filter(
    (r) =>
      !r.ok &&
      r.file &&
      (r.id === 'motion.keyframes' ||
        r.id === 'motion.transitions' ||
        r.id === 'css.dead-hook'),
  );
  if (motionFails.length === 0) {
    return { applied: false, filesChanged: [], fixes: [] };
  }

  const targets = new Set<string>();
  for (const r of motionFails) {
    if (r.file) targets.add(r.file);
  }
  if (targets.size === 0) targets.add('index.html');

  const filesChanged: string[] = [];
  const fixes: string[] = [];
  const scanOpts = {
    compositorOnly: DEFAULT_NFR_SPEC.animation?.compositorOnly ?? true,
    forbidLayoutProps: DEFAULT_NFR_SPEC.animation?.forbidLayoutProps ?? true,
  };

  for (const rel of targets) {
    const abs = join(projectRoot, rel);
    let html: string;
    try {
      html = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const beforeK = scanKeyframesViolations(html, scanOpts).length;
    const beforeT = scanTransitionViolations(html, scanOpts).length;
    const needsRm = motionFails.some(
      (r) => r.id === 'css.dead-hook' && r.file === rel && r.evidence?.includes("'rm'"),
    );
    const { html: next, changed: motionChanged } = sanitizeHtmlMotion(html);
    let final = next;
    if (needsRm && !/\.\brm\s*\*/.test(final)) {
      final = injectRmCss(final);
    }
    const afterK = scanKeyframesViolations(final, scanOpts).length;
    const afterT = scanTransitionViolations(final, scanOpts).length;
    if (final !== html || beforeK > afterK || beforeT > afterT) {
      writeFileSync(abs, final, 'utf8');
      filesChanged.push(rel);
      if (beforeK > afterK) fixes.push(`${rel}: sanitized ${beforeK - afterK} keyframe violation(s)`);
      if (beforeT > afterT) fixes.push(`${rel}: sanitized ${beforeT - afterT} transition violation(s)`);
      if (needsRm && /\.\brm\s*\*/.test(final)) fixes.push(`${rel}: added .rm reduced-motion CSS`);
      if (!fixes.some((f) => f.startsWith(rel))) fixes.push(`${rel}: motion CSS sanitized`);
    } else if (motionChanged) {
      writeFileSync(abs, final, 'utf8');
      filesChanged.push(rel);
      fixes.push(`${rel}: motion CSS sanitized`);
    }
  }

  return {
    applied: filesChanged.length > 0,
    filesChanged,
    fixes,
  };
}
