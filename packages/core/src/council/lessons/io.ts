import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LessonRecord } from './types.js';

export const LESSONS_FILE = 'lessons.jsonl';

/** Read lessons.jsonl, keeping the latest record per id. */
export function readLessonsDeduped(zelariRoot: string): LessonRecord[] {
  const path = join(zelariRoot, LESSONS_FILE);
  try {
    const raw = readFileSync(path, 'utf8');
    const byId = new Map<string, LessonRecord>();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as LessonRecord;
        const prev = byId.get(rec.id);
        if (!prev || rec.updatedAt >= prev.updatedAt) {
          byId.set(rec.id, rec);
        }
      } catch {
        // skip corrupt line
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}
