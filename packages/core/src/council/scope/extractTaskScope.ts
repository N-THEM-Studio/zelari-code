import type { NfrSpec } from '../verification/types.js';

/** Keywords that indicate measurable NFR constraints (motion, perf, budget). */
export const NFR_KEYWORDS = [
  'motion',
  'animation',
  'animate',
  'keyframes',
  'transition',
  'compositor',
  'reduced-motion',
  'prefers-reduced-motion',
  'byte budget',
  'bytes',
  'performance',
  'perf budget',
  'nfr',
  'layout thrash',
  'box-shadow',
  'inline js',
  'inline-js',
] as const;

const FILE_PATH_RE =
  /\b((?:[\w.-]+\/)*[\w.-]+\.(?:html|css|js|ts|tsx|jsx|json|md|mjs|cjs))\b/gi;

const ANIMATE_KEYWORDS = [
  'animate',
  'animation',
  'motion',
  'transition',
  'keyframes',
  'fade',
  'slide',
] as const;

const BACKLOG_FEATURE_HINTS = [
  'command palette',
  'print stylesheet',
  'dark mode',
  'i18n',
  'localization',
  'auth',
  'login',
  'database',
  'api server',
] as const;

const EXPLICIT_OUT_RE =
  /\b(?:not|don't|do not|skip|defer(?:red)?|later|backlog|out of scope|exclude|without|no need for)\b[^.\n]{0,60}/gi;

const VERSION_DEFER_RE = /\bv\d+\.\d+(?:\.\d+)?\b/gi;

export interface TaskScope {
  /** Project-relative file targets for this task. */
  targets: string[];
  /** Task theme keywords (animation, motion, …). */
  keywords: string[];
  /** Features explicitly deferred or out of scope for this run. */
  explicitOut: string[];
  /** Whether NFR-style constraints appear in the user request. */
  nfrRelevant: boolean;
  sources: Array<'userMessage' | 'nfr-spec'>;
}

export interface ExtractTaskScopeInput {
  userMessage: string;
  nfrSpec?: NfrSpec | null;
  /** Optional plan text (JSON string or markdown) for backlog hints. */
  planText?: string;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueLower(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractFilePaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const raw = match[1];
    if (!raw) continue;
    const norm = normalizePath(raw);
    if (norm.includes('node_modules')) continue;
    found.push(norm);
  }
  return uniqueLower(found);
}

function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const kw of [...ANIMATE_KEYWORDS, ...NFR_KEYWORDS]) {
    if (lower.includes(kw)) hits.push(kw);
  }
  return uniqueLower(hits);
}

function extractExplicitOut(userMessage: string, planText?: string): string[] {
  const combined = `${userMessage}\n${planText ?? ''}`;
  const out: string[] = [];

  for (const match of combined.matchAll(EXPLICIT_OUT_RE)) {
    const phrase = match[0]?.trim();
    if (phrase && phrase.length > 8) out.push(phrase);
  }

  for (const hint of BACKLOG_FEATURE_HINTS) {
    if (combined.toLowerCase().includes(hint)) {
      const inScope =
        userMessage.toLowerCase().includes(hint) &&
        !/\b(?:not|don't|do not|skip|later|backlog|without)\b[^.\n]{0,30}/i.test(
          userMessage,
        );
      if (!inScope) out.push(hint);
    }
  }

  for (const match of combined.matchAll(VERSION_DEFER_RE)) {
    const ver = match[0];
    if (ver && /later|backlog|defer|not yet|planned/i.test(combined)) {
      out.push(`${ver} (deferred)`);
    }
  }

  return uniqueLower(out);
}

/** True when the task text mentions measurable NFR themes. */
export function taskMatchesNfrKeywords(
  userMessage: string,
  planText?: string,
): boolean {
  const lower = `${userMessage}\n${planText ?? ''}`.toLowerCase();
  return NFR_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Deterministic task scope from user message + optional nfr-spec.
 * No NLP — keyword overlap, file-path regex, and nfr-spec targets only.
 */
export function extractTaskScope(input: ExtractTaskScopeInput): TaskScope {
  const sources: TaskScope['sources'] = [];
  const targets: string[] = [];
  const keywords = extractKeywords(input.userMessage);
  if (input.userMessage.trim()) sources.push('userMessage');

  for (const p of extractFilePaths(input.userMessage)) {
    targets.push(p);
  }

  if (input.nfrSpec?.targets?.length) {
    sources.push('nfr-spec');
    for (const t of input.nfrSpec.targets) {
      targets.push(normalizePath(t));
    }
    if (input.nfrSpec.animation?.compositorOnly) {
      keywords.push('compositor-only');
    }
    if (input.nfrSpec.inlineJs?.maxBytes) {
      keywords.push(`inline-js<=${input.nfrSpec.inlineJs.maxBytes}b`);
    }
  }

  const explicitOut = extractExplicitOut(input.userMessage, input.planText);
  const nfrRelevant = taskMatchesNfrKeywords(input.userMessage, input.planText);

  return {
    targets: uniqueLower(targets),
    keywords: uniqueLower(keywords),
    explicitOut,
    nfrRelevant,
    sources: [...new Set(sources)],
  };
}

export interface ScopeMatchInput {
  name?: string;
  description?: string;
  id?: string;
}

/** Classify a plan task relative to extracted scope. */
export function classifyTaskScope(
  task: ScopeMatchInput,
  scope: TaskScope,
): 'in-scope' | 'backlog' | 'neutral' {
  const blob = `${task.name ?? ''} ${task.description ?? ''} ${task.id ?? ''}`.toLowerCase();

  for (const out of scope.explicitOut) {
    const needle = out.toLowerCase().replace(/\s*\(deferred\)$/i, '');
    if (needle.length >= 4 && blob.includes(needle)) return 'backlog';
  }

  for (const hint of BACKLOG_FEATURE_HINTS) {
    if (
      blob.includes(hint) &&
      scope.explicitOut.some((o) => o.toLowerCase().includes(hint))
    ) {
      return 'backlog';
    }
  }

  if (scope.targets.length > 0) {
    const hitsTarget = scope.targets.some((t) => blob.includes(t.toLowerCase()));
    if (hitsTarget) return 'in-scope';
  }

  if (scope.keywords.length > 0) {
    const hitsKeyword = scope.keywords.some((kw) => blob.includes(kw.toLowerCase()));
    if (hitsKeyword) return 'in-scope';
  }

  if (scope.targets.length > 0 || scope.keywords.length > 0) {
    return 'backlog';
  }

  return 'neutral';
}
