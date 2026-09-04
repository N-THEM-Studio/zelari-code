/**
 * classifyTask — deterministic task classifier (Evolution Engine v0, ADR-0036).
 *
 * Pure regex + shape heuristics, NO LLM (P2: deterministic where possible).
 * Produces the `taskClass` key used by the evolution ledger and, later, by
 * P6 routing policies. Same input ⇒ same class, always.
 */
export type TaskClass = 'bugfix' | 'tests' | 'docs' | 'refactor' | 'feature' | 'chore';

export interface TaskShape {
  /** The user prompt / task title. */
  prompt: string;
  /** Files touched, when known. */
  fileCount?: number;
  /** Total diff lines, when known. */
  diffLines?: number;
  /** True when the task touches/creates test files. */
  hasTests?: boolean;
}

export interface ClassifyResult {
  taskClass: TaskClass;
  /** Ordered signals that fired (deterministic, for the ledger). */
  signals: string[];
}

/** Ordered rules — FIRST match wins. Bilingual IT/EN on purpose. */
const RULES: readonly (readonly [TaskClass, RegExp])[] = [
  ['bugfix', /\b(bug|fix\w*|regress\w*|crash|broken|non\s+funziona|fail\w*|panic)\b/i],
  ['tests', /\b(test\w*|vitest|jest|spec\b|coverage|copertura)\b/i],
  ['docs', /\b(readme|changelog|adr\b|doc\w*|guida|guide|documentation)\b/i],
  ['refactor', /\b(refactor\w*|rinomin\w*|rename|extract|simplif\w*|semplific\w*|clean\w*|pulizi\w*|migrat\w*)\b/i],
  ['feature', /\b(add\w*|aggiung\w*|implement\w*|feature|nuov[oa]\b|new\b|creat\w*|support\w*)\b/i],
];

const WIDE_DIFF_FILES = 8;
const LARGE_DIFF_LINES = 500;

/** Classify a task deterministically. Never throws, never calls out. */
export function classifyTask(shape: TaskShape): ClassifyResult {
  const prompt = shape.prompt ?? '';
  const signals: string[] = [];

  let taskClass: TaskClass | undefined;
  for (const [cls, re] of RULES) {
    if (re.test(prompt)) {
      taskClass = cls;
      signals.push(`prompt:${cls}`);
      break;
    }
  }

  if (shape.hasTests) signals.push('hasTests');
  if ((shape.fileCount ?? 0) >= WIDE_DIFF_FILES) signals.push('wide-diff');
  if ((shape.diffLines ?? 0) >= LARGE_DIFF_LINES) signals.push('large-diff');

  if (!taskClass) {
    if (!prompt.trim()) taskClass = 'chore';
    else if (shape.hasTests) taskClass = 'tests';
    else if ((shape.fileCount ?? 0) >= WIDE_DIFF_FILES || (shape.diffLines ?? 0) >= LARGE_DIFF_LINES) {
      taskClass = 'refactor';
    } else {
      taskClass = 'feature';
    }
  }

  return { taskClass, signals };
}
