/**
 * automations/social/draft.ts — turn a social_post spec into a draft (F2).
 *
 * No LLM in the static path: `topicOrBrief` IS the draft. If it names an
 * existing file (resolved against the project root) the file's trimmed content
 * is used instead. Never throws — a missing media path or an over-limit text
 * becomes a non-blocking warning.
 *
 * The LLM path (generate.ts) shares `finalizeDraft` + `resolvePath`/`isFile` so
 * media validation and the length warning are identical for generated drafts.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SocialPostSpec } from '../types.js';

/** x/Twitter single-tweet limit used for the (non-blocking) length warning. */
export const TEXT_LIMIT = 280;

/** How a draft's text was produced. */
export interface DraftProvenance {
  source: 'static' | 'llm';
  provider?: string;
  model?: string;
}

/** The draft produced from a spec. */
export interface Draft {
  text: string;
  media: string[];
  warnings: string[];
  /** Static brief vs an LLM call (absent on hand-built drafts). */
  generatedBy?: DraftProvenance;
  /** Fresh web research executed before the LLM call (`researchQuery`). */
  research?: { query: string; provider: string; hits: number };
}

/** true when `p` exists and is a regular file. */
export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Resolve a spec path against the project root (absolute paths pass through). */
export function resolvePath(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

/**
 * Validate media paths and flag an over-limit text on ALREADY-RESOLVED text.
 * Shared by the static and LLM draft paths so both warn identically.
 */
export async function finalizeDraft(
  text: string,
  spec: SocialPostSpec,
  root: string,
): Promise<Draft> {
  const warnings: string[] = [];
  const media: string[] = [];
  for (const raw of spec.media?.paths ?? []) {
    if (await isFile(resolvePath(root, raw))) {
      media.push(raw);
    } else {
      warnings.push(`media_missing:${raw}`);
    }
  }
  if (text.length > TEXT_LIMIT) {
    warnings.push('text_exceeds_x_limit');
  }
  return { text, media, warnings };
}

/** Build a draft from `spec`, resolving relative paths against `root`. */
export async function draftSocialPost(spec: SocialPostSpec, root: string): Promise<Draft> {
  const warnings: string[] = [];

  const brief = spec.topicOrBrief.trim();
  const briefPath = resolvePath(root, brief);
  let text: string;
  if (/\.(md|txt)$/i.test(brief) && (await isFile(briefPath))) {
    try {
      text = (await readFile(briefPath, 'utf-8')).trim();
    } catch (e) {
      warnings.push(`brief_unreadable:${e instanceof Error ? e.message : String(e)}`);
      text = brief;
    }
  } else {
    text = brief;
  }

  const draft = await finalizeDraft(text, spec, root);
  draft.warnings = [...warnings, ...draft.warnings];
  draft.generatedBy = { source: 'static' };
  return draft;
}
