/**
 * Lightweight CSS motion scanner — @keyframes and transition declarations.
 * No full CSS parser; conservative regex over `<style>` blocks and inline CSS.
 */

const KEYFRAMES_BLOCK_RE = /@keyframes\s+[\w-]+\s*\{([^}]*(\{[^}]*\}[^}]*)*)\}/gs;

/** Properties always treated as non-compositor. */
export const LAYOUT_MOTION_PROPS = new Set([
  'width', 'height', 'top', 'left', 'right', 'bottom',
  'margin', 'margin-top', 'margin-bottom', 'padding', 'padding-top', 'padding-bottom',
  'grid-template-rows', 'grid-template-columns',
  'max-height', 'min-height', 'max-width', 'min-width',
  'border-width', 'gap', 'line-height', 'font-size',
]);

export const COMPOSITOR_ONLY_PROPS = new Set(['transform', 'opacity']);

export interface CssMotionViolation {
  kind: 'keyframes' | 'transition';
  property: string;
  line: number;
  snippet: string;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function extractStyleBlocks(html: string): string {
  const blocks: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1] ?? '');
  }
  return blocks.join('\n');
}

/** Strip block/line comments so annotation text (e.g. `COMPLIANT:`) is not parsed as declarations. */
function stripCssComments(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function propertiesInKeyframeBlock(block: string): string[] {
  const props = new Set<string>();
  const declRe = /([a-z-]+)\s*:/gi;
  const body = stripCssComments(block);
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(body)) !== null) {
    const name = (m[1] ?? '').toLowerCase();
    if (name !== 'from' && name !== 'to' && !name.endsWith('%')) {
      props.add(name);
    }
  }
  return [...props];
}

export function scanKeyframesViolations(
  html: string,
  opts: { compositorOnly: boolean; forbidLayoutProps: boolean },
): CssMotionViolation[] {
  const css = extractStyleBlocks(html);
  const violations: CssMotionViolation[] = [];
  let match: RegExpExecArray | null;
  KEYFRAMES_BLOCK_RE.lastIndex = 0;
  while ((match = KEYFRAMES_BLOCK_RE.exec(css)) !== null) {
    const block = match[0] ?? '';
    const props = propertiesInKeyframeBlock(block);
    for (const prop of props) {
      if (opts.compositorOnly && !COMPOSITOR_ONLY_PROPS.has(prop)) {
        violations.push({
          kind: 'keyframes',
          property: prop,
          line: lineNumberAt(html, match.index),
          snippet: block.slice(0, 120),
        });
      } else if (opts.forbidLayoutProps && LAYOUT_MOTION_PROPS.has(prop)) {
        violations.push({
          kind: 'keyframes',
          property: prop,
          line: lineNumberAt(html, match.index),
          snippet: block.slice(0, 120),
        });
      }
    }
  }
  return violations;
}

/** Parse property names from a transition shorthand or transition-property value. */
function parseTransitionProperties(value: string): string[] {
  const trimmed = value.trim().replace(/!important/g, '');
  if (!trimmed || trimmed === 'none' || trimmed === 'all') {
    return trimmed === 'all' ? ['all'] : [];
  }
  // Shorthand: property tokens before first duration (number or var()
  const parts = trimmed.split(',').map((p) => p.trim());
  const props: string[] = [];
  for (const part of parts) {
    const tokens = part.split(/\s+/);
    const propTokens: string[] = [];
    for (const tok of tokens) {
      if (/^[\d.]+m?s$/.test(tok) || tok.startsWith('cubic-bezier') || tok.startsWith('var(') ||
          ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end'].includes(tok)) {
        break;
      }
      propTokens.push(tok.toLowerCase());
    }
    if (propTokens.length > 0) {
      props.push(...propTokens);
    } else if (parts.length === 1) {
      props.push(tokens[0]?.toLowerCase() ?? '');
    }
  }
  return props.filter(Boolean);
}

const TRANSITION_DECL_RE = /(transition(?:-property)?)\s*:\s*([^;{}]+)/gi;

export function scanTransitionViolations(
  html: string,
  opts: { compositorOnly: boolean; forbidLayoutProps: boolean },
): CssMotionViolation[] {
  const css = extractStyleBlocks(html);
  const violations: CssMotionViolation[] = [];
  let match: RegExpExecArray | null;
  TRANSITION_DECL_RE.lastIndex = 0;
  while ((match = TRANSITION_DECL_RE.exec(css)) !== null) {
    const value = match[2] ?? '';
    const props = parseTransitionProperties(value);
    for (const prop of props) {
      if (prop === 'all') {
        violations.push({
          kind: 'transition',
          property: 'all',
          line: lineNumberAt(html, match.index),
          snippet: match[0].slice(0, 100),
        });
        continue;
      }
      if (opts.compositorOnly && !COMPOSITOR_ONLY_PROPS.has(prop)) {
        violations.push({
          kind: 'transition',
          property: prop,
          line: lineNumberAt(html, match.index),
          snippet: match[0].slice(0, 100),
        });
      } else if (opts.forbidLayoutProps && LAYOUT_MOTION_PROPS.has(prop)) {
        violations.push({
          kind: 'transition',
          property: prop,
          line: lineNumberAt(html, match.index),
          snippet: match[0].slice(0, 100),
        });
      }
    }
  }
  return violations;
}
