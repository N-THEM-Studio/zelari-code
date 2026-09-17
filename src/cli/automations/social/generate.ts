/**
 * automations/social/generate.ts — LLM draft generation for social_post.
 *
 * Used when `SocialPostSpec.prompt` is set: the prompt (or the file it names) is
 * turned into a system+user message pair and one non-streaming completion is
 * issued via the shared `oneShot` helper (or an injected `complete` seam in
 * tests). Errors never degrade silently to a static draft — the runner maps an
 * `LlmDraftError.reason` to a failed run (P1: unknown ≠ success).
 */
import { readFile } from 'node:fs/promises';
import {
  chatCompletion,
  resolveLlm,
  type ChatUsage,
  type LlmTarget,
} from '../../llm/oneShot.js';
import { finalizeDraft, isFile, resolvePath, type Draft } from './draft.js';
import type { SocialPostSpec } from '../types.js';
import { webSearchTool } from '@zelari/core/harness/tools/builtin/web';

/** Built-in copywriter system prompt (used verbatim, no per-spec override). */
export const SOCIAL_SYSTEM_PROMPT =
  'You are a social-media copywriter for a single brand. Draft ONE post from ' +
  'the user brief. Output ONLY the post text — no surrounding quotes, no ' +
  '"Here is your post" commentary, no markdown fences. Write in the requested ' +
  'tone. Keep it within 280 characters when the target channel is X/Twitter. ' +
  'Use hashtags sparingly, only when the brief asks for them.';

/** Fallback instruction when a spec omits `prompt` (safety net for callers). */
const DEFAULT_DRAFT_INSTRUCTION =
  'Draft a concise, engaging social post from the brief below.';

/** The two-message request handed to the completion seam. */
export interface ChatLikeRequest {
  system: string;
  user: string;
}

/** Result shape of the completion seam. */
export interface ChatLikeResult {
  text: string;
  usage?: ChatUsage;
}

/** Injectable completion seam (defaults to the real one-shot helper). */
export type CompleteFn = (llm: LlmTarget, req: ChatLikeRequest) => Promise<ChatLikeResult>;

/** One web-search hit fed into the draft prompt (title/url/snippet). */
export interface ResearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Outcome of the research seam: fresh hits or a typed failure. */
export type ResearchOutcome =
  | { ok: true; provider: string; hits: ResearchHit[] }
  | { ok: false; error: string };

/** Injectable research seam (defaults to the shared keyless webSearchTool). */
export type ResearchFn = (query: string, maxResults: number) => Promise<ResearchOutcome>;

type WebSearchCtx = Parameters<typeof webSearchTool.execute>[1];

/** Default research: the shared keyless web_search tool (DuckDuckGo; Tavily when keyed). */
const defaultResearch: ResearchFn = async (query, maxResults) => {
  try {
    const res = await webSearchTool.execute(
      { query, maxResults },
      { signal: AbortSignal.timeout(15_000) } as unknown as WebSearchCtx,
    );
    if (!res.ok) return { ok: false, error: String(res.error ?? 'web_search_failed') };
    return {
      ok: true,
      provider: res.value.provider,
      hits: res.value.results.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/** A generated draft, tagged with the model that produced it. */
export interface LlmDraft extends Draft {
  generatedBy: { source: 'llm'; provider: string; model: string };
  usage?: ChatUsage;
}

/** Typed failure carrying a machine-readable reason for the run record. */
export class LlmDraftError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'LlmDraftError';
    this.reason = reason;
  }
}

/** Resolve a spec string, reading an existing `.md`/`.txt` file when named. */
async function resolveSpecText(raw: string, root: string): Promise<string> {
  const s = raw.trim();
  if (/\.(md|txt)$/i.test(s)) {
    const p = resolvePath(root, s);
    if (await isFile(p)) {
      try {
        return (await readFile(p, 'utf-8')).trim();
      } catch {
        return s;
      }
    }
  }
  return s;
}

/**
 * Build the system + user messages for a draft. `promptText` is the ALREADY
 * resolved prompt (file content or literal); it defaults to the literal
 * `spec.prompt`. `{{brief}}`/`{{topic}}` are substituted; without a placeholder
 * the brief is appended as a context block. Tone + target channels are added.
 */
export function buildMessages(
  spec: SocialPostSpec,
  briefText: string,
  promptText: string = spec.prompt ?? '',
): { system: string; user: string } {
  const instructions = promptText.trim() || DEFAULT_DRAFT_INSTRUCTION;
  const body = /\{\{\s*(brief|topic)\s*\}\}/.test(instructions)
    ? instructions.replace(/\{\{\s*(brief|topic)\s*\}\}/g, briefText)
    : `${instructions}\n\nBrief:\n${briefText}`;
  const parts = [body];
  const tone = spec.tone?.trim();
  if (tone) parts.push(`Tone: ${tone}`);
  if (spec.channels.length > 0) parts.push(`Target channels: ${spec.channels.join(', ')}`);
  return { system: SOCIAL_SYSTEM_PROMPT, user: parts.join('\n\n') };
}

/** Map any resolve/complete failure to a typed, run-friendly reason. */
function classifyLlmError(e: unknown, requestedProvider?: string): LlmDraftError {
  if (e instanceof LlmDraftError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/no api key/i.test(msg)) {
    const m = /provider '([^']+)'/.exec(msg);
    return new LlmDraftError(
      `llm_no_api_key:${m?.[1] ?? requestedProvider ?? 'unknown'}`,
      msg,
    );
  }
  if (/no model selected/i.test(msg)) return new LlmDraftError('llm_no_model', msg);
  if (/empty model response/i.test(msg)) return new LlmDraftError('llm_empty_response', msg);
  return new LlmDraftError(`llm_error:${msg}`, msg);
}

/**
 * Generate a draft via the LLM. `complete` is a test seam; the default issues a
 * real one-shot completion against the resolved provider/model. Throws a typed
 * `LlmDraftError` on any failure (never returns a static fallback).
 */
export async function generateDraftWithLlm(opts: {
  spec: SocialPostSpec;
  root: string;
  modelRef?: { provider?: string; id: string };
  complete?: CompleteFn;
  research?: ResearchFn;
}): Promise<LlmDraft> {
  const { spec, root, modelRef, complete, research: researchFn } = opts;
  const briefText = await resolveSpecText(spec.topicOrBrief, root);
  const promptText = spec.prompt ? await resolveSpecText(spec.prompt, root) : '';
  const { system, user } = buildMessages(spec, briefText, promptText);

  // Fresh research (researchQuery): keyless web search BEFORE the LLM call;
  // hits are appended to the user message. A failure degrades to a
  // `research_failed:*` warning — the draft still needs human approval.
  let researchBlock = '';
  let research: Draft['research'];
  const researchWarnings: string[] = [];
  const rq = spec.researchQuery?.trim();
  if (rq) {
    const fn = researchFn ?? defaultResearch;
    const out = await fn(rq, spec.researchMaxResults ?? 5);
    if (out.ok) {
      research = { query: rq, provider: out.provider, hits: out.hits.length };
      const lines = out.hits.map((h) => `- ${h.title} — ${h.url}\n  ${h.snippet}`);
      researchBlock =
        `\n\nWEB RESEARCH RESULTS (${new Date().toISOString().slice(0, 10)} UTC):\n` +
        lines.join('\n');
    } else {
      researchWarnings.push(`research_failed:${out.error.slice(0, 120)}`);
    }
  }
  const userWithContext = researchBlock ? `${user}${researchBlock}` : user;

  let llm: LlmTarget;
  try {
    llm = await resolveLlm({ provider: modelRef?.provider, model: modelRef?.id });
  } catch (e) {
    throw classifyLlmError(e, modelRef?.provider);
  }

  const call: CompleteFn = complete ?? ((target, req) => chatCompletion(target, req));
  let res: ChatLikeResult;
  try {
    res = await call(llm, { system, user: userWithContext });
  } catch (e) {
    throw classifyLlmError(e);
  }

  const text = res.text?.trim() ?? '';
  if (!text) throw new LlmDraftError('llm_empty_response', 'Empty model response');

  const draft = await finalizeDraft(text, spec, root);
  return {
    ...draft,
    warnings: [...draft.warnings, ...researchWarnings],
    research,
    generatedBy: { source: 'llm', provider: llm.provider, model: llm.model },
    usage: res.usage,
  };
}
