/**
 * skillSuggest — recommendation engine for skill selection (Task H.2).
 *
 * Given a user query (free-form text like "refactor this code" or
 * "debug the failing test"), returns a ranked list of candidate skills
 * from SKILL_CATALOG. Ranking combines:
 *  - **Tag match** (case-insensitive substring against `skill.tags`)
 *  - **Name match** (fallback when no tag match)
 *  - **Historical success rate** (from skillHistory.ts)
 *  - **Average duration** (lower = higher score, normalized to 30s)
 *
 * If nothing matches, falls back to top-5 by global success rate — the
 * "popular + reliable" skills that always deserve a recommendation.
 *
 * Pure module (no React/Ink deps). Caller wires it into a slash command
 * (e.g. `/skill-suggest <query>` — see Task H.3.1 if added, or use
 * directly from `app.tsx` dispatch).
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3-H.md (Task H.2)
 */

import { listSkills, type SkillMetadata } from '../agents/skills.js';
import { readSkillHistory, getSkillStats, type SkillStats } from './skillHistory.js';

export interface SuggestionEntry {
  skill: SkillMetadata;
  stats: SkillStats;
  score: number;
  /** Why this skill was matched. */
  matchReason: 'tag' | 'name' | 'fallback-popular';
}

export interface SuggestOptions {
  /** Max results. Default 5. */
  limit?: number;
  /** Injectable history records (for tests). Defaults to readSkillHistory from default file. */
  records?: import('./skillHistory.js').SkillHistoryRecord[];
  /** Injectable clock for tests (ms). Default `Date.now()`. */
  now?: number;
  /** Injectable skill catalog. Defaults to `listSkills()`. */
  catalog?: SkillMetadata[];
}

/**
 * Compute a score in [0, 1] for a skill given its stats + match reason.
 *
 * Formula (deterministic, no randomness):
 *   base     = successRate                  (0..1)
 *   speed    = 1 - min(avgDurationMs/30s, 1) (0..1)
 *   tagBoost = 1.0 (tag match) | 0.5 (name) | 0.0 (fallback)
 *
 *   score = 0.6 * base + 0.2 * speed + 0.2 * tagBoost
 *
 * The weights favor reliability (success rate matters most), then
 * speed, then recency/context match. Tunable later.
 */
export function computeSuggestionScore(
  stats: SkillStats,
  matchReason: 'tag' | 'name' | 'fallback-popular',
): number {
  const base = stats.successRate;
  const speed = stats.count === 0
    ? 0.5 // no history → neutral score (don't penalize unknown skills)
    : 1 - Math.min((stats.avgDurationMs ?? 0) / 30_000, 1);
  const tagBoost = matchReason === 'tag' ? 1.0
    : matchReason === 'name' ? 0.5
    : 0.0;
  return 0.6 * base + 0.2 * speed + 0.2 * tagBoost;
}

/**
 * Lowercase + trim helper for tag/name matching.
 */
function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Classify the match type for a single skill against the query.
 *  - 'tag': at least one of the skill's tags contains the query (case-insensitive substring)
 *  - 'name': name contains the query (fallback when no tag match)
 *  - null: no match at all
 */
function classifyMatch(skill: SkillMetadata, queryNorm: string): 'tag' | 'name' | null {
  if (queryNorm.length === 0) return null;
  const tags = skill.tags ?? [];
  for (const t of tags) {
    if (norm(t).includes(queryNorm)) return 'tag';
  }
  if (norm(skill.name).includes(queryNorm) || norm(skill.id).includes(queryNorm)) {
    return 'name';
  }
  return null;
}

/**
 * Rank all matching skills by score, with `limit` cap. If no matches,
 * returns the top-5 by global success rate (fallback).
 */
export async function suggestSkills(
  query: string,
  options: SuggestOptions = {},
): Promise<SuggestionEntry[]> {
  const limit = options.limit ?? 5;
  const catalog = options.catalog ?? listSkills();
  const records = options.records ?? await readSkillHistory(
    process.env.ANATHEMA_SKILL_HISTORY_FILE
      ?? `${process.env.HOME ?? '/tmp'}/.tmp/anathema-coder/skill-history.jsonl`,
  );

  const queryNorm = norm(query);

  // 1. Find candidates + classify match
  const candidates: Array<{ skill: SkillMetadata; matchReason: 'tag' | 'name' }> = [];
  for (const skill of catalog) {
    const m = classifyMatch(skill, queryNorm);
    if (m !== null) candidates.push({ skill, matchReason: m });
  }

  // 2a. If we have candidates, score and sort
  if (candidates.length > 0) {
    const scored: SuggestionEntry[] = candidates.map(({ skill, matchReason }) => {
      const stats = getSkillStats(records, skill.id);
      const score = computeSuggestionScore(stats, matchReason);
      return { skill, stats, score, matchReason };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // 2b. Fallback: top-5 by global success rate
  const fallback: SuggestionEntry[] = catalog
    .map((skill) => {
      const stats = getSkillStats(records, skill.id);
      return { skill, stats, matchReason: 'fallback-popular' as const };
    })
    .sort((a, b) => b.stats.successRate - a.stats.successRate || b.stats.count - a.stats.count)
    .slice(0, 5)
    .map((entry) => ({
      ...entry,
      score: computeSuggestionScore(entry.stats, entry.matchReason),
    }));

  return fallback;
}

/**
 * Format suggestion entries as a human-readable CLI output string.
 * Pure helper — testable without React/Ink.
 */
export function formatSuggestions(entries: SuggestionEntry[]): string {
  if (entries.length === 0) {
    return '[skill-suggest] no skills available';
  }
  const lines: string[] = ['[skill-suggest] recommended skills:'];
  for (const e of entries) {
    const reason = e.matchReason === 'tag' ? '(tag match)'
      : e.matchReason === 'name' ? '(name match)'
      : '(popular fallback)';
    const statsStr = e.stats.count === 0
      ? 'no history yet'
      : `${e.stats.count} runs, ${(e.stats.successRate * 100).toFixed(0)}% ok, avg ${e.stats.avgDurationMs.toFixed(0)}ms`;
    lines.push(`  ${e.skill.id} — ${e.skill.name} — score ${e.score.toFixed(2)} — ${statsStr} ${reason}`);
  }
  return lines.join('\n');
}
