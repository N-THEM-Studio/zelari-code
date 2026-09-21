/**
 * Pure `relevantWhen` derivation (T-Mem lite, S3).
 *
 * Zero LLM, zero I/O: turns a memory's content / kind / tags into 1–3 short
 * situational trigger phrases describing *when* the memory is likely useful
 * (e.g. `when npm fails with etimedout`). The service sanitizes and caps the
 * result; this module only proposes candidate phrases and never persists them.
 */
import { memoryTokens } from './scoring.js';

/** Triggers kept by the service (the schema accepts up to 8 host-supplied). */
export const RELEVANT_WHEN_CAP = 3;
const MAX_PHRASE_LENGTH = 120;
/** Drop very long tokens so obvious secrets (sk-…, JWTs) never leak in. */
const MAX_TOKEN_LENGTH = 24;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'into', 'your', 'you', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'its', 'also', 'will', 'can', 'should',
  'must', 'them', 'they', 'our', 'out', 'any', 'all', 'each', 'per', 'via', 'use', 'using',
  'get', 'set', 'new', 'old', 'one', 'two', 'may',
]);

const TOOLISH =
  /(?:npm|pnpm|yarn|node|tsc|vitest|jest|eslint|prettier|docker|git|cargo|rustc|python|pip|go|mvn|gradle|make|curl|http|fetch|sqlite|postgres|redis|deploy|build|test|lint|install|migrate|migration)/i;
const ERRORISH =
  /(?:timeout|timedout|etimedout|econn|eaddrinuse|enoent|eacces|enospc|eexist|lock|locked|denied|refused|crash|signal|exhaust|oom|heap|exception|error|traceback|segfault|panic)/i;

function keyTokens(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of memoryTokens(value)) {
    if (token.length < 3 || token.length > MAX_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function clip(phrase: string): string {
  const trimmed = phrase.replace(/\s+/g, ' ').trim();
  return trimmed.length <= MAX_PHRASE_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_PHRASE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Derive up to {@link RELEVANT_WHEN_CAP} associative triggers. Pure and
 * deterministic; the caller applies the secret sanitizer afterwards.
 */
export function deriveRelevantWhen(
  content: string,
  kind: string,
  tags: readonly string[] = [],
): string[] {
  const tokens = keyTokens(content);
  for (const tag of tags) {
    for (const token of keyTokens(tag)) {
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  if (tokens.length === 0) return [];

  if (kind === 'failure') {
    const errorClass = tokens.find((token) => ERRORISH.test(token));
    const tool = tokens.find((token) => TOOLISH.test(token) && token !== errorClass) ?? tokens[0];
    return [clip(errorClass ? `when ${tool} fails with ${errorClass}` : `when ${tool} fails`)];
  }
  if (kind === 'procedure') {
    const command = tokens.find((token) => TOOLISH.test(token)) ?? tokens[0];
    return [clip(`when running ${command}`)];
  }

  const phrases: string[] = [];
  for (const token of tokens) {
    if (phrases.length >= RELEVANT_WHEN_CAP) break;
    phrases.push(clip(`when ${token}`));
  }
  return [...new Set(phrases)];
}
