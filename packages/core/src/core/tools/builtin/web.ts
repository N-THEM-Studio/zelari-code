import { z } from 'zod';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';

/**
 * web.ts — network tools: fetch_url + web_search (v0.7.5).
 *
 * Fills the CLI's biggest functional gap vs peer agents (opencode's
 * webfetch/websearch, Hermes' web_search): until now the only network
 * access was `bash` + curl, which is fragile on Windows and blocked by
 * the non-interactive shell constraints.
 *
 * Design constraints:
 *  - http(s) only; other schemes rejected before any I/O.
 *  - Hard timeout via AbortController (default 15s) — a hung host must
 *    not stall the whole agent turn.
 *  - Output truncated (default 40k chars) — a 5MB page must not blow the
 *    prompt budget.
 *  - `web_search` needs no API key by default (DuckDuckGo HTML endpoint);
 *    set TAVILY_API_KEY to switch to Tavily's JSON API for better results.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CHARS_DEFAULT = 40_000;
const USER_AGENT = 'zelari-code (+https://github.com/N-THEM-Studio/zelari-code)';

/** Reject anything that is not plain http/https BEFORE any network I/O. */
function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed, got: ${url.protocol}//`);
  }
  return url;
}

/** Fetch with an AbortController timeout, propagating the tool ctx signal. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onOuterAbort = (): void => ctrl.abort(outerSignal?.reason);
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Reduce an HTML document to readable text: drop script/style/head noise,
 * convert tags to whitespace, decode the handful of entities that matter.
 * Deliberately dependency-free — good enough for LLM consumption, not for
 * rendering.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// ── fetch_url ─────────────────────────────────────────────────────────

const FetchUrlArgsSchema = z.object({
  /** The http(s) URL to fetch. */
  url: z.string().min(1),
  /** Max characters of extracted text returned (default 40000). */
  maxChars: z.number().int().positive().max(200_000).default(MAX_CHARS_DEFAULT),
});

export type FetchUrlArgs = z.infer<typeof FetchUrlArgsSchema>;

export interface FetchUrlResult {
  url: string;
  status: number;
  contentType: string;
  /** Extracted text (HTML stripped) or raw body for non-HTML text types. */
  text: string;
  truncated: boolean;
}

export const fetchUrlTool: ToolDefinition<FetchUrlArgs, FetchUrlResult> = {
  name: 'fetch_url',
  description:
    'Fetch an http(s) URL and return its readable text content (HTML is stripped to text). ' +
    'Use for documentation pages, READMEs, API references, raw files. Not for binary content.',
  permissions: ['network'],
  inputSchema: FetchUrlArgsSchema,
  timeoutMs: FETCH_TIMEOUT_MS + 5_000,
  execute: async (args, ctx) => {
    try {
      const url = assertHttpUrl(args.url);
      const res = await fetchWithTimeout(
        url.toString(),
        { headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,application/json,*/*' }, redirect: 'follow' },
        ctx.signal,
        FETCH_TIMEOUT_MS,
      );
      const contentType = res.headers.get('content-type') ?? '';
      if (/image|video|audio|octet-stream|zip|pdf/i.test(contentType)) {
        return typedErr(`fetch_url: unsupported content-type "${contentType}" (binary). Only text content is supported.`);
      }
      const raw = await res.text();
      const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
      const text = isHtml ? htmlToText(raw) : raw;
      const truncated = text.length > args.maxChars;
      return typedOk({
        url: res.url || url.toString(),
        status: res.status,
        contentType,
        text: truncated ? text.slice(0, args.maxChars) + '\n…[truncated]' : text,
        truncated,
      });
    } catch (err) {
      return typedErr(`fetch_url failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ── web_search ────────────────────────────────────────────────────────

const WebSearchArgsSchema = z.object({
  /** Search query. */
  query: z.string().min(2),
  /** Max results (default 5). */
  maxResults: z.number().int().positive().max(10).default(5),
});

export type WebSearchArgs = z.infer<typeof WebSearchArgsSchema>;

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  provider: 'tavily' | 'duckduckgo';
  query: string;
  results: WebSearchHit[];
}

/** Parse the DuckDuckGo HTML SERP (html.duckduckgo.com) into hits. */
export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  // Each organic result renders as <a class="result__a" href="…">title</a>
  // … <a class="result__snippet" …>snippet</a>. Attribute order is stable
  // on the html.duckduckgo.com endpoint.
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(htmlToText(sm[1] ?? ''));
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && hits.length < maxResults) {
    let href = m[1] ?? '';
    // DDG wraps results as //duckduckgo.com/l/?uddg=<encoded-target>&rut=…
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg?.[1]) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        // keep the wrapped URL — still clickable
      }
    }
    if (href.startsWith('//')) href = 'https:' + href;
    hits.push({
      title: htmlToText(m[2] ?? ''),
      url: href,
      snippet: snippets[hits.length] ?? '',
    });
  }
  return hits;
}

async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<WebSearchHit[]> {
  const res = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
    },
    signal,
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 400),
  }));
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<WebSearchHit[]> {
  const res = await fetchWithTimeout(
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
    { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } },
    signal,
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  return parseDuckDuckGoHtml(await res.text(), maxResults);
}

export const webSearchTool: ToolDefinition<WebSearchArgs, WebSearchResult> = {
  name: 'web_search',
  description:
    'Search the web and return result titles, URLs, and snippets. ' +
    'Follow up with fetch_url on the most promising result to read the page. ' +
    'No API key needed (set TAVILY_API_KEY for higher-quality results).',
  permissions: ['network'],
  inputSchema: WebSearchArgsSchema,
  timeoutMs: FETCH_TIMEOUT_MS + 5_000,
  execute: async (args, ctx) => {
    const tavilyKey = process.env['TAVILY_API_KEY'];
    try {
      if (tavilyKey) {
        const results = await searchTavily(args.query, args.maxResults, tavilyKey, ctx.signal);
        return typedOk({ provider: 'tavily' as const, query: args.query, results });
      }
      const results = await searchDuckDuckGo(args.query, args.maxResults, ctx.signal);
      if (results.length === 0) {
        return typedOk({
          provider: 'duckduckgo' as const,
          query: args.query,
          results: [],
        });
      }
      return typedOk({ provider: 'duckduckgo' as const, query: args.query, results });
    } catch (err) {
      return typedErr(`web_search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
