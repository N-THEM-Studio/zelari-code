/**
 * Centralized redaction for run-recorder payloads (Frontier PHASE 5, §99).
 *
 * Every writer funnels through `redactRuntimePayload()`; no individual
 * recorder path is allowed to serialize secrets on its own. Best-effort by
 * nature (regex-based), but the single choke point keeps patterns auditable.
 */

export const REDACTED = '[REDACTED]';

/** Object keys whose values are always redacted regardless of content. */
const SECRET_KEY_RE =
  /(pass(word|wd)?|secret|token|api[-_]?key|auth(orization)?|credential|private[-_]?key|access[-_]?key)/i;

const VALUE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // "Authorization: <credential>" (with optional bearer/Basic scheme prefix) — whole value.
  // Value class excludes [ ] so the [REDACTED] marker can never be re-matched.
  {
    re: /\b(authorization\s*[:=]\s*)(?:bearer|basic|token)\s+[^\s,;"'}\]\[]+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    re: /\b(authorization\s*[:=]\s*)[^\s,;"'}\]\[]+/gi,
    replacement: '$1[REDACTED]',
  },
  // Bare bearer schemes anywhere ("bearer <token>", any casing)
  { re: /\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'bearer [REDACTED]' },
  // OpenAI-style keys (sk-, sk-proj-)
  { re: /\bsk-(proj-)?[A-Za-z0-9_-]{8,}\b/g, replacement: 'sk-[REDACTED]' },
  // GitHub tokens
  {
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED]',
  },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED]' },
  // Slack
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED]' },
  // AWS access keys
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED]' },
  // Google OAuth
  { re: /\bya29\.[A-Za-z0-9\-_.]+/g, replacement: '[REDACTED]' },
  // Secret-looking assignments, UPPER_SNAKE or lower: FOO_PASSWORD=x, password: x
  {
    re: /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}&\]]+)/gi,
    replacement: '$1=[REDACTED]',
  },
];

/** Redact secret-looking substrings from free text. */
export function redactString(input: string): string {
  let out = input;
  for (const { re, replacement } of VALUE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Recursively redact a payload before it is persisted by the recorder.
 * - secret-ish object keys → whole value replaced
 * - strings → pattern scrub
 * - arrays/objects → walked
 * - primitives → passed through
 */
export function redactRuntimePayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactRuntimePayload(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactRuntimePayload(val);
    }
    return out;
  }
  // Functions / symbols / bigints: nothing useful to persist.
  return REDACTED;
}
