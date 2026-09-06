/**
 * outputCleaning — clarifying-question parsing and model output cleaning,
 * extracted verbatim from agents/councilApi.ts.
 */
import { scrubProprietaryLeak } from '../secrecyPolicy.js';

const QUESTION_MARKER = '---QUESTION---';
const QUESTION_END_MARKER = '---END---';

export interface ClarificationRequest {
  question: string;
  choices?: string[];
  context?: string;
}

/**
 * Extract the first top-level JSON object from `s` using brace depth so trailing
 * MiniMax/tool garbage after `}` does not break JSON.parse (common failure mode:
 * `---QUESTION--- {…}]<]minimax…` without ---END---).
 */
function extractBalancedJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseClarificationRequest(text: string): ClarificationRequest | null {
  const start = text.indexOf(QUESTION_MARKER);
  if (start < 0) return null;
  const rest = text.slice(start + QUESTION_MARKER.length);
  const end = rest.indexOf(QUESTION_END_MARKER);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  const cleaned = block.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const jsonText =
    extractBalancedJsonObject(cleaned) ??
    (() => {
      const objStart = cleaned.indexOf('{');
      const objEnd = cleaned.lastIndexOf('}');
      return objStart >= 0 && objEnd > objStart
        ? cleaned.slice(objStart, objEnd + 1)
        : cleaned;
    })();
  try {
    const parsed = JSON.parse(jsonText) as Partial<ClarificationRequest>;
    if (typeof parsed.question !== 'string' || !parsed.question.trim()) return null;
    return {
      question: parsed.question.trim(),
      choices: Array.isArray(parsed.choices)
        ? parsed.choices.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
        : undefined,
      context: typeof parsed.context === 'string' ? parsed.context.trim() : undefined,
    };
  } catch {
    return null;
  }
}

/** True when text contains a structured question with ≥2 choices (pause UI). */
export function hasInteractiveClarification(text: string): boolean {
  const c = parseClarificationRequest(text);
  return !!(c && c.choices && c.choices.length >= 2);
}

/**
 * Strip real clarification blocks from display prose.
 *
 * A block is real only when `---QUESTION---` is followed (after whitespace)
 * by `{`. Mentions of the marker in prose or backticks are left intact —
 * the old marker→EOF regex ate the rest of any reply that *talked about*
 * the protocol (Desktop/headless streamScrub then stopped emitting).
 *
 * Incomplete `{` (streaming, no balanced JSON, no ---END---) still hides
 * from the marker through EOF so JSON scaffolding does not flash.
 */
export function stripQuestionBlocks(text: string): string {
  let out = '';
  let rest = text;
  while (true) {
    const start = rest.indexOf(QUESTION_MARKER);
    if (start < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, start);
    const afterMarker = rest.slice(start + QUESTION_MARKER.length);
    const trimmed = afterMarker.replace(/^\s+/, '');
    if (!trimmed.startsWith('{')) {
      out += QUESTION_MARKER;
      rest = afterMarker;
      continue;
    }
    const endIdx = afterMarker.indexOf(QUESTION_END_MARKER);
    if (endIdx >= 0) {
      rest = afterMarker.slice(endIdx + QUESTION_END_MARKER.length);
      continue;
    }
    const json = extractBalancedJsonObject(trimmed);
    if (json) {
      const jsonAt = afterMarker.indexOf(json);
      rest = afterMarker.slice(jsonAt + json.length);
      continue;
    }
    break;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function parseThinking(text: string): string {
  // Prefer complete blocks; fall back to unclosed trailing block (common mid-stream).
  const complete = text.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
  if (complete) return complete[1].trim();
  const open = text.match(/<think(?:ing)?>([\s\S]*)$/i);
  return open ? open[1].trim() : '';
}

export interface CleanAgentContentOptions {
  /**
   * When true (default), strip `---QUESTION---` blocks from display text.
   * Set false when cleaning text for rolling PROVIDER history — the model
   * still needs to see its own clarifying question on the next turn.
   */
  stripQuestion?: boolean;
  /**
   * When true (default), strip `<think>` / `<thinking>` blocks (UI display).
   * Set **false** for multi-turn **provider** history: MiniMax-M3 (and M2.x)
   * require the full assistant `content` including think tags so interleaved
   * tool-use reasoning continues. Stripping them for the API degrades tool
   * loops ("announces intent then stops"). Display paths keep the default.
   */
  stripThink?: boolean;
}

/**
 * Strip model "private" channels from text shown to the user / re-fed as
 * history. Covers:
 *   - complete + unclosed `<think>` / `<thinking>` (GLM/MiniMax style) — optional
 *   - MiniMax XML tool-call wrappers
 *   - clarifying-question JSON blocks (display only; keep in provider history)
 *
 * Without unclosed-tag stripping, streamed thinking that never got a closing
 * tag leaked into the TUI as visible assistant prose (v1.8.1).
 */
export function cleanAgentContent(
  text: string,
  opts: CleanAgentContentOptions = {},
): string {
  const stripQuestion = opts.stripQuestion !== false;
  const stripThink = opts.stripThink !== false;
  let out = text;
  if (stripThink) {
    out = out
      .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
      .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
      .replace(/<\/think(?:ing)?>/gi, '');
  }
  // Tool-call markup that models sometimes dump into prose (MiniMax / GLM / generic).
  // Prefer closed-block removal first; only then strip *trailing* unclosed
  // open tags. Never use a mid-string open-tag → EOF wipe for tool tags when
  // there may still be real prose after a broken unclosed tag sequence —
  // headless streamScrub re-cleans the full buffer each push, so closed pairs
  // are enough mid-stream; trailing open is for end-of-turn.
  out = out
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi, '')
    .replace(/<\/?minimax:tool_call>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, '')
    .replace(/<\/?function_call>/gi, '')
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '')
    .replace(/<\/invoke>/gi, '')
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<\/parameter>/gi, '')
    .replace(
      /\]\s*<\]\s*minimax\s*\[>\s*\[?<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi,
      '',
    )
    // Trailing unclosed tool channels only (end of buffer)
    .replace(/<minimax:tool_call>[\s\S]*$/gi, '')
    .replace(/<tool_call>[\s\S]*$/gi, '')
    .replace(/<function_call>[\s\S]*$/gi, '')
    .replace(/<invoke\b[^>]*>[\s\S]*$/gi, '')
    .replace(/\]\s*<\]\s*minimax\s*\[>[\s\S]*$/gi, '')
    .replace(/^\s*\]\s*<\]\s*minimax\s*\[>.*$/gim, '')
    .replace(
      /^\s*<\/?(?:tool_call|function_call|invoke|parameter|minimax:tool_call)\b[^>]*>\s*$/gim,
      '',
    );
  if (stripQuestion) {
    out = stripQuestionBlocks(out);
  }
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  // Defense-in-depth: strip proprietary prompt dumps that escaped model policy.
  return scrubProprietaryLeak(out);
}
