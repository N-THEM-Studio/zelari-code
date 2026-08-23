import type { MemoryNode, MemorySanitizationResult, MemorySanitizer } from './types.js';
import { memoryTokens } from './scoring.js';

const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i;

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'openai-token', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'github-token', pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'oauth-token', pattern: /\b(?:ya29\.|xox[baprs]-)[A-Za-z0-9._-]{15,}\b/g },
  {
    name: 'credential-assignment',
    pattern:
      /\b(password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([^\s,"';]{8,})["']?/gi,
  },
];

const HIGH_ENTROPY_CANDIDATE = /\b[A-Za-z0-9+/_=-]{32,}\b/g;
const PRIVATE_REASONING_BLOCK = /<(think|analysis)>[\s\S]*?<\/\1>/gi;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksLikeHighEntropyCredential(value: string): boolean {
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[+/_=-]/.test(value),
  ].filter(Boolean).length;
  return classes >= 3 && shannonEntropy(value) >= 4.2;
}

export function normalizeMemoryContent(content: string): string {
  return content
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class DefaultMemorySanitizer implements MemorySanitizer {
  sanitize(raw: string): MemorySanitizationResult {
    PRIVATE_REASONING_BLOCK.lastIndex = 0;
    const containedPrivateReasoning = PRIVATE_REASONING_BLOCK.test(raw);
    PRIVATE_REASONING_BLOCK.lastIndex = 0;
    const content = normalizeMemoryContent(raw.replace(PRIVATE_REASONING_BLOCK, ''));
    if (PRIVATE_KEY.test(content)) {
      return {
        content: '[REJECTED PRIVATE KEY]',
        redactions: ['private-key'],
        rejected: true,
        reason: 'Private keys cannot be persisted in project memory.',
      };
    }
    const redactions: string[] = containedPrivateReasoning ? ['private-reasoning'] : [];
    let sanitized = content;
    for (const { name, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (!pattern.test(sanitized)) continue;
      redactions.push(name);
      pattern.lastIndex = 0;
      if (name === 'credential-assignment') {
        sanitized = sanitized.replace(pattern, (_all, key: string) => `${key}=[REDACTED]`);
      } else {
        sanitized = sanitized.replace(pattern, '[REDACTED]');
      }
    }
    HIGH_ENTROPY_CANDIDATE.lastIndex = 0;
    if ([...sanitized.matchAll(HIGH_ENTROPY_CANDIDATE)]
      .some((match) => looksLikeHighEntropyCredential(match[0]))) {
      redactions.push('high-entropy-token');
      HIGH_ENTROPY_CANDIDATE.lastIndex = 0;
      sanitized = sanitized.replace(HIGH_ENTROPY_CANDIDATE, (candidate) =>
        looksLikeHighEntropyCredential(candidate) ? '[REDACTED]' : candidate,
      );
    }
    return { content: sanitized, redactions, rejected: false };
  }
}

const SECRET_KEY = /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)/i;

/** Recursively sanitize metadata without flattening its useful structure. */
export function sanitizeMemoryMetadata(
  value: Record<string, unknown> | undefined,
  sanitizer: MemorySanitizer,
): Record<string, unknown> {
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 6) return '[TRUNCATED]';
    if (typeof input === 'string') {
      const result = sanitizer.sanitize(input);
      const sanitized = result.rejected ? '[REDACTED]' : result.content;
      return sanitized.length > 16_000 ? `${sanitized.slice(0, 15_999)}…` : sanitized;
    }
    if (Array.isArray(input)) return input.slice(0, 100).map((item) => visit(item, depth + 1));
    if (input && typeof input === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(input as Record<string, unknown>).slice(0, 200)) {
        output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : visit(child, depth + 1);
      }
      return output;
    }
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'boolean' || input === null) return input;
    if (input === undefined) return null;
    return '[UNSUPPORTED]';
  };
  return visit(value ?? {}, 0) as Record<string, unknown>;
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))]
    .sort()
    .slice(0, 64);
}

export function clampUnit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function normalizedMemoryKey(content: string): string {
  return memoryTokens(normalizeMemoryContent(content)).join(' ');
}

export function memorySimilarity(a: string, b: string): number {
  const left = new Set(memoryTokens(a));
  const right = new Set(memoryTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** External reads are project-visible, or private to the client that wrote them. */
export function canExternalClientRead(node: MemoryNode, client: string): boolean {
  return node.visibility !== 'private' || node.source.client === client;
}

/** External mutation is owner-only; hosts may add an explicit admin policy above this seam. */
export function canExternalClientMutate(node: MemoryNode, client: string): boolean {
  return node.source.client === client;
}
