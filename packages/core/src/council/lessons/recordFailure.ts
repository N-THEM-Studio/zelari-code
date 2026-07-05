import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationCheckResult, VerificationCheckId } from '../verification/types.js';
import { isAnswerLeak } from './isAnswerLeak.js';
import { LESSONS_FILE, readLessonsDeduped } from './io.js';
import { jaccardSimilarity, normalizeForSignature, tokenizeForSignature } from './signatures.js';
import type { CaptureFailureResult, LessonRecord } from './types.js';

const JACCARD_MERGE_THRESHOLD = 0.72;
const ENFORCED_AFTER_RECURRENCE = 2;

const METHODOLOGY: Partial<Record<VerificationCheckId, string>> = {
  'motion.keyframes': 'Grep @keyframes in targets before PASS; compositor budget allows only transform and opacity.',
  'motion.transitions': 'Grep transition properties before PASS; forbid layout-affecting props (grid-template-rows, box-shadow, etc.).',
  'css.dead-hook': 'Every classList.add must have a matching CSS rule; grep both script and style blocks.',
  'synthesis.tier-inflation': 'Verification status tier cannot exceed the report; never PASS a check prefix that still has FAIL in verification-report.',
  'synthesis.honesty': 'Claims like verificato/regressione require Evidence table with path:Lline or tool output — not prose alone.',
  'synthesis.cite-invalid': 'Every path:Lline citation must exist and be non-empty; grep before citing.',
  'synthesis.degraded-banner': 'Degraded runs must include DEGRADED_RUN banner; do not claim ready-to-commit.',
  'plan.reality': 'Milestone keywords in plan.json must appear in implementation targets before claiming compatibility.',
};

function methodologyFor(check: VerificationCheckResult): string {
  return (
    METHODOLOGY[check.id] ??
    `When ${check.id} fails, fix the underlying issue and cite grep/tool evidence before claiming PASS.`
  );
}

function keywordsFrom(check: VerificationCheckResult, signature: string): string[] {
  const words = signature.split(' ').filter((w) => w.length >= 4);
  const fromId = check.id.split(/[.-]/).filter((p) => p.length >= 4);
  return [...new Set([...fromId, ...words])].slice(0, 12);
}

function writeLesson(zelariRoot: string, lesson: LessonRecord): void {
  const path = join(zelariRoot, LESSONS_FILE);
  appendFileSync(path, `${JSON.stringify(lesson)}\n`, 'utf8');
}

function findSimilar(lessons: LessonRecord[], signature: string): LessonRecord | null {
  const sigTokens = tokenizeForSignature(signature);
  let best: LessonRecord | null = null;
  let bestScore = 0;
  for (const l of lessons) {
    const score = jaccardSimilarity(sigTokens, tokenizeForSignature(l.signature));
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return bestScore >= JACCARD_MERGE_THRESHOLD ? best : null;
}

/**
 * Capture a verification FAIL as a methodology lesson (append-only jsonl).
 */
export function captureFailure(
  zelariRoot: string,
  check: VerificationCheckResult,
): CaptureFailureResult {
  if (check.ok) {
    return { captured: false, reason: 'check passed' };
  }

  const methodology = methodologyFor(check);
  const leak = isAnswerLeak(`${methodology} ${check.message} ${check.evidence ?? ''}`);
  if (leak.leak) {
    return { captured: false, rejected: true, reason: leak.reason };
  }

  const signature = normalizeForSignature(check.id, check.message);
  const existing = readLessonsDeduped(zelariRoot);
  const similar = findSimilar(existing, signature);
  const now = new Date().toISOString();

  if (similar) {
    const recurrence = similar.recurrence + 1;
    const tier = recurrence >= ENFORCED_AFTER_RECURRENCE ? 'enforced' : similar.tier;
    const updated: LessonRecord = {
      ...similar,
      recurrence,
      tier,
      updatedAt: now,
    };
    writeLesson(zelariRoot, updated);
    return { captured: true, lesson: updated };
  }

  const lesson: LessonRecord = {
    id: `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    signature,
    checkId: check.id,
    methodology,
    tier: 'advisory',
    keywords: keywordsFrom(check, signature),
    recurrence: 1,
    createdAt: now,
    updatedAt: now,
  };
  writeLesson(zelariRoot, lesson);
  return { captured: true, lesson };
}
