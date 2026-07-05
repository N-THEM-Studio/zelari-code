const FLAG_RE = /flag\{[^}]+\}/i;
const CHALLENGE_ANSWER_RE = /challenge[-_\s]?id\s*[:=].{0,40}answer\s*[:=]/i;
const TEST_WORKSPACE_RE = /\b(TESTMCP|T3MP3ST)\b/i;
const WIN_ABS_PATH_RE = /[A-Z]:\\[^\s'"]+/i;
const UNIX_ABS_PATH_RE = /\/(?:Users|home|tmp|var)\/[^\s'"]+/i;
const HARDCODED_BENCHMARK_RE = /\b\d{4,}\s*bytes\b/i;

export interface LeakCheckResult {
  leak: boolean;
  reason?: string;
}

/** Reject lesson text that looks like an answer leak, not methodology. */
export function isAnswerLeak(text: string): LeakCheckResult {
  const t = text.trim();
  if (!t) return { leak: true, reason: 'empty' };
  if (FLAG_RE.test(t)) return { leak: true, reason: 'flag-shaped secret' };
  if (CHALLENGE_ANSWER_RE.test(t)) return { leak: true, reason: 'challenge-id + answer pair' };
  if (TEST_WORKSPACE_RE.test(t)) return { leak: true, reason: 'test workspace name' };
  if (WIN_ABS_PATH_RE.test(t)) return { leak: true, reason: 'absolute windows path' };
  if (UNIX_ABS_PATH_RE.test(t)) return { leak: true, reason: 'absolute unix path' };
  if (HARDCODED_BENCHMARK_RE.test(t)) return { leak: true, reason: 'hardcoded byte benchmark' };
  return { leak: false };
}
