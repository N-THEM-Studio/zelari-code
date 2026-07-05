import { existsSync } from "node:fs";
import { join } from "node:path";
import { recallLessons, formatLessonsForContext } from "@zelari/core/council";
import { resolveWorkspaceRoot } from "./paths.js";

/**
 * Build lessons block for council workspaceContext (max 5 lessons, ~2KB).
 */
export function buildLessonsSummary(
  projectRoot: string = process.cwd(),
  taskText?: string,
): string | null {
  if (process.env["ZELARI_LESSONS"] === "0") return null;
  const zelariRoot = resolveWorkspaceRoot(projectRoot);
  if (!existsSync(join(zelariRoot, "lessons.jsonl"))) return null;
  const lessons = recallLessons(zelariRoot, {
    maxLessons: 5,
    maxBytes: 2048,
    taskText,
  });
  return formatLessonsForContext(lessons);
}
