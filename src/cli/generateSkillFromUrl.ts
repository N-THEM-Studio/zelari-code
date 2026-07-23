/**
 * Fetch a URL and ask the active (or flagged) model to draft a SKILL.md skill.
 * Used by Desktop skill-create form and CLI `--generate-skill-from-url`.
 */
import { getModelForProvider, getProviderConfig } from './providerConfig.js';
import { resolveApiKeyWithMeta, type ProviderName } from './keyStore.js';
import { resolveBaseUrl } from './provider/openai-compatible.js';
import { CODING_CATEGORIES_LIST } from './skillCategories.js';

const MAX_PAGE_CHARS = 24_000;
const FETCH_TIMEOUT_MS = 25_000;
const LLM_TIMEOUT_MS = 90_000;

export interface GeneratedSkillDraft {
  name: string;
  description: string;
  body: string;
  category?: string;
  tools?: string[];
  cost?: 'low' | 'medium' | 'high';
  sourceUrl: string;
  model: string;
  provider: string;
}

const SYSTEM = `You convert web page content into a Zelari Code coding skill (SKILL.md style).

Return ONLY a single JSON object (no markdown fences) with keys:
- name: string, kebab-case id (a-z0-9-hyphens, max 64, start with letter/digit)
- description: string, one line, what the skill does
- body: string, markdown instructions the agent should follow (steps, rules, checks)
- category: one of ${CODING_CATEGORIES_LIST.join('|')} (optional)
- tools: string[] of tool names the skill needs (optional, e.g. bash, read_file, write_file)
- cost: "low" | "medium" | "high" (optional, default medium)

Rules:
- Prefer actionable coding-agent instructions over marketing copy.
- If the page is a skill/prompt already, adapt it cleanly to this schema.
- If the page is docs/blog, distill a reusable workflow skill.
- name must be unique-looking and descriptive (not "untitled" or "skill").
- body must be non-empty markdown with clear steps.`;

function stripHtml(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  return t;
}

export async function fetchUrlText(url: string): Promise<string> {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) {
    throw new Error('URL must start with http:// or https://');
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(u, {
      signal: controller.signal,
      headers: {
        'user-agent': 'zelari-code-skill-import/1.0',
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`Fetch failed HTTP ${res.status}`);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const raw = await res.text();
    if (ct.includes('json') || raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
      return raw.slice(0, MAX_PAGE_CHARS);
    }
    if (ct.includes('html') || /<html[\s>]/i.test(raw) || /<body[\s>]/i.test(raw)) {
      return stripHtml(raw).slice(0, MAX_PAGE_CHARS);
    }
    return raw.slice(0, MAX_PAGE_CHARS);
  } finally {
    clearTimeout(t);
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  // Strip ```json fences if the model ignored instructions
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error('Model did not return valid JSON');
  }
}

function normalizeDraft(
  raw: unknown,
  sourceUrl: string,
  provider: string,
  model: string,
): GeneratedSkillDraft {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid skill draft object');
  }
  const o = raw as Record<string, unknown>;
  let name = String(o.name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    // Derive from URL path
    try {
      const path = new URL(sourceUrl).pathname
        .split('/')
        .filter(Boolean)
        .pop()
        ?.replace(/\.[a-z0-9]+$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
      name = path && /^[a-z0-9]/.test(path) ? path : 'imported-skill';
    } catch {
      name = 'imported-skill';
    }
  }
  const description = String(o.description ?? '').trim();
  const body = String(o.body ?? '').trim();
  if (!description) throw new Error('Model draft missing description');
  if (!body) throw new Error('Model draft missing body');

  const catRaw = String(o.category ?? '')
    .trim()
    .toLowerCase();
  const category = CODING_CATEGORIES_LIST.includes(catRaw as never)
    ? catRaw
    : undefined;

  let tools: string[] | undefined;
  if (Array.isArray(o.tools)) {
    tools = o.tools.map((t) => String(t).trim()).filter(Boolean);
  } else if (typeof o.tools === 'string' && o.tools.trim()) {
    tools = o.tools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const costRaw = String(o.cost ?? 'medium').trim().toLowerCase();
  const cost =
    costRaw === 'low' || costRaw === 'high' || costRaw === 'medium'
      ? costRaw
      : 'medium';

  return {
    name,
    description,
    body,
    category,
    tools,
    cost,
    sourceUrl,
    model,
    provider,
  };
}

async function resolveLlm(opts: {
  provider?: string;
  model?: string;
}): Promise<{ provider: string; model: string; apiKey: string; baseUrl: string }> {
  const active = (opts.provider?.trim() ||
    getProviderConfig().activeProviderId) as ProviderName;
  const meta = await resolveApiKeyWithMeta(active);
  if (!meta?.apiKey) {
    throw new Error(
      `No API key for provider '${active}'. Save a key in Settings → Provider.`,
    );
  }
  const baseUrl = resolveBaseUrl(active);
  if (!baseUrl) {
    throw new Error(
      `No base URL for provider '${active}'. Set a custom endpoint in Settings.`,
    );
  }
  const model =
    opts.model?.trim() ||
    getModelForProvider(active) ||
    process.env.ZELARI_MODEL ||
    '';
  if (!model) {
    throw new Error(`No model selected for provider '${active}'`);
  }
  return { provider: active, model, apiKey: meta.apiKey, baseUrl };
}

/**
 * Fetch URL page text and generate a skill draft via the selected model.
 */
export async function generateSkillFromUrl(opts: {
  url: string;
  provider?: string;
  model?: string;
}): Promise<GeneratedSkillDraft> {
  const page = await fetchUrlText(opts.url);
  if (!page.trim()) {
    throw new Error('Page content is empty after fetch');
  }

  const llm = await resolveLlm({
    provider: opts.provider,
    model: opts.model,
  });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const url = `${llm.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0.2,
        max_tokens: 4096,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content:
              `Source URL: ${opts.url.trim()}\n\n` +
              `Page content (truncated):\n${page}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(
        `LLM HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
      );
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty model response');
    const parsed = extractJsonObject(text);
    return normalizeDraft(parsed, opts.url.trim(), llm.provider, llm.model);
  } finally {
    clearTimeout(t);
  }
}
