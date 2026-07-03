/**
 * core-webTools.test.ts — v0.7.5 fetch_url + web_search coverage.
 *
 * All network I/O is stubbed via vi.stubGlobal('fetch', …): these tests
 * must pass offline and never hit duckduckgo/tavily for real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchUrlTool,
  webSearchTool,
  htmlToText,
  parseDuckDuckGoHtml,
} from '@zelari/core/harness/tools/builtin/web';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  audit: () => {},
  sessionId: 'test',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('htmlToText', () => {
  it('strips scripts, styles, and tags; decodes entities', () => {
    const html = `<html><head><title>x</title></head><body>
      <script>alert(1)</script><style>.a{}</style>
      <h1>Hello &amp; welcome</h1><p>First</p><p>Second &lt;tag&gt;</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Hello & welcome');
    expect(text).toContain('First');
    expect(text).toContain('Second <tag>');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('<p>');
  });
});

describe('parseDuckDuckGoHtml', () => {
  const serp = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
    <a class="result__snippet" href="#">The example documentation site.</a>
    <a rel="nofollow" class="result__a" href="https://plain.example.org/page">Plain result</a>
    <a class="result__snippet" href="#">Second snippet.</a>`;

  it('extracts titles, unwraps uddg redirect URLs, pairs snippets', () => {
    const hits = parseDuckDuckGoHtml(serp, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.url).toBe('https://example.com/docs');
    expect(hits[0]!.title).toBe('Example Docs');
    expect(hits[0]!.snippet).toContain('example documentation');
    expect(hits[1]!.url).toBe('https://plain.example.org/page');
  });

  it('respects maxResults', () => {
    expect(parseDuckDuckGoHtml(serp, 1)).toHaveLength(1);
  });
});

describe('fetch_url', () => {
  it('rejects non-http(s) schemes without any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await fetchUrlTool.execute({ url: 'file:///etc/passwd', maxChars: 1000 }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Only http(s)');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('strips HTML and truncates to maxChars', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body><p>' + 'zelari '.repeat(100) + '</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )));
    const res = await fetchUrlTool.execute({ url: 'https://example.com', maxChars: 50 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.truncated).toBe(true);
      expect(res.value.text).toContain('zelari');
      expect(res.value.text).not.toContain('<p>');
      expect(res.value.text.length).toBeLessThan(80); // 50 + truncation marker
    }
  });

  it('rejects binary content types', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-1.4', {
      status: 200, headers: { 'content-type': 'application/pdf' },
    })));
    const res = await fetchUrlTool.execute({ url: 'https://example.com/x.pdf', maxChars: 1000 }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('unsupported content-type');
  });
});

describe('web_search', () => {
  it('uses DuckDuckGo HTML when no TAVILY_API_KEY', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('html.duckduckgo.com');
      return new Response(
        '<a class="result__a" href="https://vitest.dev/">Vitest</a><a class="result__snippet" href="#">Fast test runner.</a>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await webSearchTool.execute({ query: 'vitest', maxResults: 3 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.provider).toBe('duckduckgo');
      expect(res.value.results[0]!.url).toBe('https://vitest.dev/');
    }
  });

  it('uses Tavily when TAVILY_API_KEY is set', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tv-test');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('api.tavily.com');
      return new Response(JSON.stringify({
        results: [{ title: 'Hit', url: 'https://hit.example', content: 'snippet text' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const res = await webSearchTool.execute({ query: 'anything', maxResults: 3 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.provider).toBe('tavily');
      expect(res.value.results).toHaveLength(1);
      expect(res.value.results[0]!.url).toBe('https://hit.example');
    }
  });

  it('returns typedErr (not throw) on network failure', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    const res = await webSearchTool.execute({ query: 'x y', maxResults: 3 }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('web_search failed');
  });
});
