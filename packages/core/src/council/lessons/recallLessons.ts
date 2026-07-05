import type { LessonRecord, RecallLessonsOptions } from './types.js';
import { readLessonsDeduped } from './io.js';

function scoreLesson(lesson: LessonRecord, taskText: string): number {
  const low = taskText.toLowerCase();
  let score = lesson.tier === 'enforced' ? 10 : 1;
  for (const kw of lesson.keywords) {
    if (low.includes(kw.toLowerCase())) score += 3;
  }
  if (low.includes(lesson.checkId.replace(/\./g, ' '))) score += 2;
  score += lesson.recurrence;
  return score;
}

/**
 * Recall top lessons for council context (enforced preferred, keyword overlap).
 */
export function recallLessons(
  zelariRoot: string,
  options: RecallLessonsOptions = {},
): LessonRecord[] {
  const maxLessons = options.maxLessons ?? 5;
  const maxBytes = options.maxBytes ?? 2048;
  const taskText = options.taskText ?? '';

  const all = readLessonsDeduped(zelariRoot);
  if (all.length === 0) return [];

  const ranked = [...all].sort((a, b) => {
    const sa = scoreLesson(a, taskText);
    const sb = scoreLesson(b, taskText);
    return sb - sa;
  });

  const picked: LessonRecord[] = [];
  let bytes = 0;
  for (const lesson of ranked) {
    if (picked.length >= maxLessons) break;
    const line = JSON.stringify(lesson);
    if (bytes + line.length > maxBytes && picked.length > 0) break;
    picked.push(lesson);
    bytes += line.length;
  }
  return picked;
}

/** Markdown block for workspace context injection. */
export function formatLessonsForContext(lessons: LessonRecord[]): string | null {
  if (lessons.length === 0) return null;
  const lines = [
    '## Council lessons (methodology — not answers)',
    'Apply enforced lessons before claiming verification PASS.',
    '',
  ];
  for (const l of lessons) {
    lines.push(`- **[${l.tier}]** \`${l.checkId}\`: ${l.methodology}`);
  }
  return lines.join('\n');
}
