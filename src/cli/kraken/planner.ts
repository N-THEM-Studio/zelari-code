/**
 * Kraken graph engine — planner (F4).
 *
 * Turns a free-text prompt into a validated `TaskGraph` by asking an LLM for
 * a small JSON DAG of explore/general nodes, then deterministically
 * post-processing it: a `verify` node is auto-injected after every
 * `general` node, and a `merge` node is auto-injected once two or more
 * `general` nodes exist (so their worktree-isolated work gets sequentially
 * merged after verification — see the F3 executor's merge handling).
 *
 * Follows the existing one-shot "LLM → JSON → parse with fallback" pattern
 * used by `generateSkillFromUrl.ts` (raw `fetch` to `/chat/completions`,
 * `stream: false`) rather than spinning up the full `AgentHarness` tool
 * loop, since planning is a single structured-completion request with no
 * tool use of its own.
 *
 * @since v0.10.x — Kraken graph engine (F4)
 */

import { z } from 'zod';
import {
  createGraph,
  validateGraph,
  DEFAULT_MAX_NODES,
  type TaskGraph,
  type TaskNode,
  type TaskNodeKind,
} from '@zelari/core';
import { getModelForProvider, getProviderConfig } from '../providerConfig.js';
import { resolveApiKeyWithMeta, type ProviderName } from '../keyStore.js';
import { resolveBaseUrl } from '../provider/openai-compatible.js';
import { buildWorkspaceSummary } from '../workspace/workspaceSummary.js';
import { parseQualifiedModelRef, resolveKrakenPlannerModel } from '../tools/krakenModel.js';

const MAX_PLAN_ATTEMPTS = 2;

/**
 * Char budget for the project listing handed to the planner.
 *
 * The planner is a one-shot completion that used to see the goal text and
 * nothing else — so it invented directory layouts, and every `scope` it
 * produced was a guess. Since scopes are what the executor uses to decide
 * which writers may run in parallel, a hallucinated scope is not cosmetic:
 * it makes the parallelism decision meaningless. Same budget the council
 * path gives the same summary (`ZELARI_CTX_WORKSPACE_CHARS` default).
 */
const DEFAULT_PLANNER_WORKSPACE_CHARS = 3000;

function resolvePlannerWorkspaceChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_PLANNER_WORKSPACE_CHARS;
  if (raw === undefined || raw === '') return DEFAULT_PLANNER_WORKSPACE_CHARS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLANNER_WORKSPACE_CHARS;
}

/**
 * Default wall-clock budget for the planner's (non-streaming) completion
 * request. Matches the executor's `DEFAULT_NODE_TIMEOUT_MS`: a single graph
 * node is already allowed 5 minutes, so capping the planning step at less
 * made no sense — reasoning-capable models routinely spend well over a
 * minute on chain-of-thought before emitting the JSON answer, and a
 * non-streaming request shows nothing until it's done. Set
 * ZELARI_KRAKEN_PLANNER_TIMEOUT_MS=0 to disable the timer entirely.
 */
const DEFAULT_LLM_TIMEOUT_MS = 300_000;

function resolvePlannerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_PLANNER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_LLM_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LLM_TIMEOUT_MS;
}

/**
 * A failure of the LLM *transport* (timeout, HTTP error, network error) as
 * opposed to a malformed-but-received response. The retry-with-corrective-
 * feedback loop in {@link planTaskGraph} only helps for the latter: re-asking
 * a model that never answered just doubles the wait, with an even longer
 * prompt than the one that already timed out.
 */
export class PlannerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerTransportError';
  }
}

/**
 * Default max_tokens for the planner's completion request. Complex/long
 * prompts against reasoning-capable models can burn most or all of a small
 * budget on chain-of-thought before ever emitting the JSON answer, leaving
 * `message.content` empty (finish_reason='length') — the retry loop alone
 * can't fix that since it repeats the exact same truncation. Override with
 * ZELARI_KRAKEN_PLANNER_MAX_TOKENS for especially large planning prompts.
 */
const DEFAULT_LLM_MAX_TOKENS = 8192;

function resolvePlannerMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_PLANNER_MAX_TOKENS;
  if (raw === undefined || raw === '') return DEFAULT_LLM_MAX_TOKENS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LLM_MAX_TOKENS;
}

/** Default retry budget per auto-generated/planned node kind. */
const DEFAULT_MAX_RETRIES: Record<TaskNodeKind, number> = {
  explore: 0,
  general: 1,
  verify: 1,
  fix: 0,
  merge: 0,
  // Pillar 2 persona kinds: same retry budget as `verify` (the gate is
  // the same — trailer-based).
  spec: 1,
  conformance: 1,
};

export const KRAKEN_PLANNER_SYSTEM_PROMPT = [
  'You are the PLANNER for Kraken, a multi-agent graph executor.',
  "Decompose the user's goal into a small DAG of sub-agent tasks (\"tentacles\").",
  '',
  'Return ONLY a single JSON object (no markdown fences, no prose) of the form:',
  '{ "nodes": [ { "id": string, "kind": "explore"|"general", "label": string, ' +
    '"prompt": string, "scope"?: string[], "acceptance"?: string[], "deps": string[] } ] }',
  '',
  'Rules:',
  '- kind "explore": read-only research (no edits). Use to gather context before edits.',
  '- kind "general": can edit files for one bounded, self-contained unit of work.',
  '- Do NOT emit "verify", "spec", "conformance", "fix", or "merge" nodes — the executor adds those automatically based on the writer kind and the goal shape.',
  '- "id" must be short, unique, kebab-case (e.g. "e1", "g-auth", "g-ui").',
  '- "prompt" must be self-contained: the sub-agent sees ONLY this prompt, not this conversation.',
  '- "deps" lists ids of nodes that must finish first (topological order); [] if none.',
  '- A node DOES receive what its "deps" reported when they finished — the executor injects ' +
    'their conclusions into its prompt. So write a dependent node as "using the findings above, …" ' +
    'rather than duplicating the research its dependency will do.',
  '- When two "general" nodes touch disjoint parts of the codebase, give each a "scope" ' +
    '(path/glob allowlist) so they can run in parallel safely. If scopes might overlap, ' +
    'either omit scope (forces sequential execution) or add a dep between them.',
  '- The user message includes a listing of the real project on disk. Build every "scope" ' +
    'from paths that appear there (or new paths that clearly belong beside them) — an ' +
    'invented path makes the parallelism decision meaningless, since scopes are exactly ' +
    'what the executor uses to decide which writers may run at the same time.',
  '- Prefer one "explore" node feeding several parallel "general" nodes over one giant node.',
  '- Keep the graph small: most goals need 3-8 nodes total.',
  '- "acceptance" (optional) lists concrete, checkable criteria for a "general" node. ' +
    'These are ENFORCED: the executor adds a verify tentacle that checks them on disk and can ' +
    'send the work back for a rework round when they are not met. Write criteria a reader can ' +
    'settle by opening a file or running a command ("exports slugify(input: string): string", ' +
    '"npm test passes"), never subjective ones ("the code is elegant") — a criterion nobody can ' +
    'check just burns a rework round.',
  '',
  '# Reviewer personas (Pillar 2 spec council)',
  '',
  'After every `general` node, the executor auto-injects a `verify` tentacle ' +
    'that checks the `acceptance[]` criteria. For goals that have a written ' +
    'spec or that must literally match the user prompt, the executor also ' +
    'auto-injects two more personas:',
  '  - `spec` (spec-reviewer) — compares the writer\'s output against a ' +
    'written spec/plan, per requirement. Conservative: "reasonable but ' +
    'different" is a FAIL.',
  '  - `conformance` (conformance-reviewer) — compares the writer\'s output ' +
    'against the USER\'S ORIGINAL VERBATIM PROMPT. Literal: "use session ' +
    'cookies" is a FAIL when the prompt said "use JWT".',
  '',
  'You (the JSON planner) do NOT emit these directly; the executor decides ' +
    'when to inject them. To hint that a node needs a `conformance` reviewer, ' +
    'include the user\'s original ask verbatim in the `prompt`.',
].join('\n');

/**
 * Optional extension to the planner system prompt — Bennett's Razor
 * (arXiv:2301.12987), a principled tie-breaker for "which plan should I
 * emit when two would both work?". Bennett proves that the hypothesis
 * with the *largest* extension (the one that "assumes the least") is
 * the one most likely to generalise — 1.1×–5× the rate of MDL in his
 * binary-arithmetic experiments.
 *
 * In planner terms: when two plans both cover the goal, prefer the one
 * with narrower commitments (fewer pinned paths, fewer exact versions,
 * fewer invariants about external state). It is a *tie-breaker*, not a
 * goal: a plan too vague to act on is still useless.
 *
 * Opt-in via `ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR=1`. Default off in
 * v1.31.x so existing plans aren't disturbed; promote to default-on
 * once we have evidence the directive improves plan-success rate.
 *
 * See `.zelari/decisions/013-weakness-hypothesis-selection.md` for the
 * full rationale and the Spec Council tie-breaker integration plan.
 */
const KRAKEN_PLANNER_BENNETTS_RAZOR_SECTION = [
  '',
  '# Bennett\'s Razor (tie-breaker)',
  '',
  'When two valid plans cover the goal, prefer the one that "assumes the least".',
  'A plan is *more specific* when it pins exact paths, exact semver, exact function',
  'signatures, or hard invariants about external state. A more general plan that',
  'still satisfies the goal generalises better (Bennett, AGI 2023: 1.1×–5× the rate',
  'of MDL in his experiments).',
  '',
  'Examples of the bias you should apply:',
  '- "edit the user model" > "edit /src/models/user.ts and add a nullable email field"',
  '  when the goal can be met either way.',
  '- "use a stable sort" > "use Array.prototype.sort with a custom comparator" unless',
  '  the user pinned the API.',
  '- Prefer plans that touch fewer files and assume less about runtime versions.',
  '',
  'Hard constraint: do NOT weaken a plan below the bar in the name of weakness. The',
  'goal must be reachable by following the plan as written; weakness is only a',
  'tie-breaker among plans that do reach the goal.',
].join('\n');

/**
 * Resolve whether Bennett's Razor should be appended to the planner
 * system prompt. Opt-in via env var; default off in v1.31.x.
 */
function resolveBennettsRazorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR;
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Build the planner system prompt, optionally appending Bennett's Razor
 * directive. Pure: same env → same prompt, so test-snapshottable.
 *
 * Replaces the direct `KRAKEN_PLANNER_SYSTEM_PROMPT` reference at the
 * `client.complete({ system: ... })` call site so existing tests that
 * import the constant still see the un-augmented base.
 */
export function buildPlannerSystemPrompt(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!resolveBennettsRazorEnabled(env)) return KRAKEN_PLANNER_SYSTEM_PROMPT;
  return KRAKEN_PLANNER_SYSTEM_PROMPT + '\n' + KRAKEN_PLANNER_BENNETTS_RAZOR_SECTION;
}

const PlannedNodeSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'id must be alphanumeric/dash/underscore'),
  kind: z.enum(['explore', 'general']),
  label: z.string().min(1).max(200),
  prompt: z.string().min(1),
  scope: z.array(z.string().min(1)).max(32).optional(),
  acceptance: z.array(z.string().min(1)).max(16).optional(),
  deps: z.array(z.string()).max(32).default([]),
});

const PlannedGraphSchema = z.object({
  nodes: z.array(PlannedNodeSchema).min(1).max(DEFAULT_MAX_NODES),
});

type PlannedNode = z.infer<typeof PlannedNodeSchema>;

/** Injectable LLM transport so the planner is unit-testable without network calls. */
export interface PlannerLlmClient {
  complete(opts: { system: string; user: string }): Promise<string>;
}

export interface PlanTaskGraphOptions {
  /** The user's goal, in free text. */
  prompt: string;
  /** Stable id for the resulting graph (defaults to a timestamp-based id). */
  graphId?: string;
  provider?: string;
  model?: string;
  maxNodes?: number;
  /** Override the LLM transport (tests only) — default hits the real provider. */
  llmClient?: PlannerLlmClient;
  /**
   * Briefing about a previous, unfinished graph on this goal (see
   * `graphMemory.formatSnapshotForPlanner`). Appended to the user prompt so a
   * follow-up like "continua" plans the REMAINING work instead of starting
   * over with no idea what already exists.
   */
  previousAttempt?: string;
  /**
   * Project root whose real tree/stack/scripts are summarized into the
   * planning prompt, so scopes name paths that exist. Omit to plan blind
   * (tests, or a goal with no project yet).
   */
  cwd?: string;
  /** Pre-built project listing, overriding the one derived from `cwd` (tests). */
  workspace?: string;
}

/**
 * Strip inline `<think>` blocks and ```json fences, then walk the balanced
 * `{...}` objects in the reply and parse the first usable one — falling back
 * to {@link repairLooseJson} when a strict parse fails. Pass `requireKey` to
 * skip objects that lack it, which is what separates a draft fragment left in
 * the model's reasoning from the actual answer. Some models emit
 * JS-object-literal-ish output
 * (unquoted keys, single-quoted strings, trailing commas) despite explicit
 * "valid JSON only" instructions; repairing once here is cheaper and more
 * reliable than relying solely on the retry-with-feedback loop for a mistake
 * a model tends to repeat identically.
 */
export function extractJsonObject(text: string, opts: { requireKey?: string } = {}): unknown {
  const stripped = stripReasoningBlocks(text);
  // Safety net: an unterminated `<think>` with the answer after it would be
  // stripped away entirely. Stripping must never lose an answer we would
  // otherwise have found, so fall back to the raw reply when it leaves
  // nothing usable behind.
  const usable = findJsonIn(stripped, opts);
  if (usable) return usable.value;
  const raw = findJsonIn(text, opts);
  if (raw) return raw.value;

  const body = bodyOf(stripped) || bodyOf(text);
  try {
    return JSON.parse(body);
  } catch (err) {
    try {
      return JSON.parse(repairLooseJson(body));
    } catch {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

/** Strip a ```json fence, if the whole body is one. */
function bodyOf(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/**
 * Scan the balanced objects in `text` and return the first usable one:
 * preferring an object carrying `requireKey`, else the first that parses.
 */
function findJsonIn(text: string, opts: { requireKey?: string }): { value: unknown } | null {
  let firstParsed: { value: unknown } | null = null;

  for (const candidate of balancedJsonObjects(bodyOf(text))) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      try {
        value = JSON.parse(repairLooseJson(candidate));
      } catch {
        continue;
      }
    }
    if (!opts.requireKey) return { value };
    // Reasoning models sketch partial JSON while thinking, so the FIRST
    // balanced object in the reply is often a fragment ({"id":"g-add",...})
    // rather than the answer. Keep scanning for one that carries the key the
    // caller actually needs; the first parseable object is the fallback.
    if (value && typeof value === 'object' && opts.requireKey in (value as object)) {
      return { value };
    }
    // Models sometimes wrap the answer one level down ({"plan": {"nodes": …}},
    // {"graph": {"nodes": …}}). Unwrap rather than fail schema validation with
    // a confusing "expected array, received undefined".
    const unwrapped = unwrapKey(value, opts.requireKey);
    if (unwrapped) return { value: unwrapped };
    if (!firstParsed) firstParsed = { value };
  }

  return firstParsed;
}

/** Find a direct child object that carries `key`, one level down. */
function unwrapKey(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === 'object' && key in (child as object)) {
      return child as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Remove inline chain-of-thought blocks. Several reasoning models (MiniMax-M3
 * among them) put their thinking in `message.content` wrapped in `<think>`
 * tags rather than in a separate `reasoning_content` field — and that thinking
 * routinely contains draft JSON, which the extractor would otherwise pick up
 * instead of the real answer.
 */
export function stripReasoningBlocks(text: string): string {
  let out = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  // An unterminated opening tag means the answer (if any) follows the last
  // one; everything from that tag on is thinking, so there is nothing to keep
  // unless a closing tag appeared earlier, which the replace above handled.
  const openIdx = out.search(/<(think|thinking|reasoning)>/i);
  if (openIdx >= 0) out = out.slice(0, openIdx);
  return out;
}

/** Yield every top-level balanced `{...}` object in `s`, in order. */
function* balancedJsonObjects(s: string): Generator<string> {
  let from = 0;
  while (from < s.length) {
    const next = extractBalancedJsonObject(s.slice(from));
    if (!next) return;
    yield next;
    const idx = s.indexOf(next, from);
    if (idx < 0) return;
    from = idx + next.length;
  }
}

/**
 * Find the first top-level `{...}` object by brace depth, ignoring braces
 * inside "double" or 'single' quoted strings (some models emit single-quoted
 * strings despite JSON instructions — without tracking those too, a `}`
 * inside one would prematurely close the balance count).
 */
function extractBalancedJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Best-effort repair for the JSON mistakes models make most often despite
 * being told "valid JSON only": single-quoted strings (Python/JS-dict
 * style), unquoted/bareword object keys (JS-object-literal style), trailing
 * commas before `}`/`]`, and raw control characters inside string literals.
 * That last one is the most common failure here by far: the planner asks for
 * a self-contained multi-line `prompt` per node, so models routinely emit
 * real newlines inside the string rather than `\n` escapes. Deliberately
 * permissive — this is a fallback tried only after a strict `JSON.parse` has
 * already failed, not a general JSON5 parser.
 */
/**
 * Escape a character that JSON forbids raw inside a string literal (anything
 * below U+0020). Everything else is returned unchanged.
 */
function escapeJsonControlChar(c: string): string {
  if (c >= ' ') return c;
  switch (c) {
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    default:
      return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }
}

function repairLooseJson(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = s[i];
        i += 1;
        if (c === '\\') {
          out += c;
          if (i < n) {
            out += s[i];
            i += 1;
          }
          continue;
        }
        // A raw control character inside a string literal — most often a real
        // newline in a multi-line `prompt` — is illegal JSON. Escape it
        // instead of copying it through, or the repair pass fails for the
        // same reason the strict parse did.
        out += escapeJsonControlChar(c);
        if (c === '"') break;
      }
      continue;
    }
    if (ch === "'") {
      // Convert a single-quoted string to a double-quoted JSON string.
      let value = '';
      i += 1;
      while (i < n) {
        const c = s[i];
        if (c === '\\' && i + 1 < n) {
          value += s[i + 1] === "'" ? "'" : c + s[i + 1];
          i += 2;
          continue;
        }
        if (c === "'") {
          i += 1;
          break;
        }
        value += escapeJsonControlChar(c);
        i += 1;
      }
      out += `"${value.replace(/"/g, '\\"')}"`;
      continue;
    }
    // Bare identifier immediately followed by `:` (optionally spaced) outside
    // any string — quote it as a JSON object key.
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(s[j])) j += 1;
      let k = j;
      while (k < n && /\s/.test(s[k])) k += 1;
      if (s[k] === ':') {
        out += `"${s.slice(i, j)}"`;
        i = j;
        continue;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return stripTrailingCommas(out);
}

/** Drop a `,` immediately before a closing `}`/`]` (string-aware). */
function stripTrailingCommas(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = s[i];
        out += c;
        i += 1;
        if (c === '\\') {
          if (i < n) {
            out += s[i];
            i += 1;
          }
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(s[j])) j += 1;
      if (s[j] === '}' || s[j] === ']') {
        i += 1; // drop the trailing comma
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

async function resolveLlm(opts: {
  provider?: string;
  model?: string;
}): Promise<{ provider: string; model: string; apiKey: string; baseUrl: string }> {
  let active = (opts.provider?.trim() || getProviderConfig().activeProviderId) as ProviderName;
  // Precedence matches tentacle routing (`resolveKrakenPlannerModel`):
  // planner-specific env first (Desktop Settings → ZELARI_KRAKEN_PLANNER_MODEL),
  // then the forwarded lead/--model, then the persisted default. Callers such
  // as runHeadless always pass the lead model as opts.model, so env must win
  // or the Settings picker is a no-op. Planning is one structured completion
  // with no tool use — a cheap non-reasoning model is usually right even when
  // the lead is a slow reasoner.
  const parent =
    opts.model?.trim() ||
    getModelForProvider(active) ||
    process.env.ZELARI_MODEL ||
    '';
  let model = resolveKrakenPlannerModel(parent);
  // Cross-provider planner (Desktop Settings → ZELARI_KRAKEN_PLANNER_MODEL):
  // a provider-qualified ref ("glm/glm-4.7-air") plans on that provider.
  // Unknown provider (no key / no base URL) → keep the raw id (previous
  // behavior: the id goes to the lead provider unchanged).
  const ref = parseQualifiedModelRef(model);
  if (ref) {
    const crossKey = await resolveApiKeyWithMeta(ref.provider as ProviderName);
    if (crossKey?.apiKey && resolveBaseUrl(ref.provider as ProviderName)) {
      active = ref.provider as ProviderName;
    }
    if (active === ref.provider) model = ref.model;
  }
  const meta = await resolveApiKeyWithMeta(active);
  if (!meta?.apiKey) {
    throw new Error(`No API key for provider '${active}'. Save a key in Settings → Provider.`);
  }
  const baseUrl = resolveBaseUrl(active);
  if (!baseUrl) {
    throw new Error(`No base URL for provider '${active}'. Set a custom endpoint in Settings.`);
  }
  if (!model) {
    throw new Error(`No model selected for provider '${active}'`);
  }
  return { provider: active, model, apiKey: meta.apiKey, baseUrl };
}

async function createDefaultLlmClient(opts: {
  provider?: string;
  model?: string;
}): Promise<PlannerLlmClient> {
  const llm = await resolveLlm(opts);
  return {
    async complete({ system, user }) {
      const timeoutMs = resolvePlannerTimeoutMs();
      const controller = new AbortController();
      let timedOut = false;
      const t =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs)
          : undefined;
      try {
        const url = `${llm.baseUrl.replace(/\/$/, '')}/chat/completions`;
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${llm.apiKey}`,
            },
            body: JSON.stringify({
              model: llm.model,
              temperature: 0.2,
              max_tokens: resolvePlannerMaxTokens(),
              stream: false,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            }),
          });
        } catch (err) {
          // The raw AbortError ("This operation was aborted") says nothing
          // about which budget ran out or how to raise it.
          if (timedOut) {
            throw new PlannerTransportError(
              `Planner request timed out after ${Math.round(timeoutMs / 1000)}s (no response). ` +
                `Raise ZELARI_KRAKEN_PLANNER_TIMEOUT_MS, or set ZELARI_KRAKEN_PLANNER_MODEL ` +
                `to a faster non-reasoning model.`,
            );
          }
          throw new PlannerTransportError(
            `Planner request failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          throw new PlannerTransportError(
            `LLM HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
          );
        }
        const json = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string; reasoning_content?: string };
            finish_reason?: string;
          }>;
        };
        const choice = json.choices?.[0];
        const text = choice?.message?.content?.trim();
        if (text) return text;
        // Some reasoning models put chain-of-thought in `reasoning_content`
        // and can leave `content` empty if truncated (finish_reason='length')
        // before ever emitting the JSON answer. Try to salvage a JSON object
        // from the reasoning trace itself before giving up — it's often the
        // last thing the model was writing when it ran out of budget.
        const reasoning = choice?.message?.reasoning_content?.trim();
        if (reasoning && extractBalancedJsonObject(reasoning)) return reasoning;
        const reason = choice?.finish_reason;
        throw new Error(
          `Empty model response${reason ? ` (finish_reason=${reason})` : ''}` +
            (reason === 'length'
              ? ' — the model likely ran out of tokens before producing JSON;' +
                ' raise ZELARI_KRAKEN_PLANNER_MAX_TOKENS or simplify the prompt.'
              : ''),
        );
      } finally {
        if (t !== undefined) clearTimeout(t);
      }
    },
  };
}

/**
 * The project listing to plan against: an explicit override, else a summary
 * derived from `cwd`. Best-effort — a summary is an optimization, and a goal
 * that has no project yet (an empty directory) must still be plannable.
 */
function resolveWorkspaceListing(opts: PlanTaskGraphOptions): string | undefined {
  if (opts.workspace !== undefined) return opts.workspace || undefined;
  if (!opts.cwd) return undefined;
  const maxChars = resolvePlannerWorkspaceChars();
  if (maxChars <= 0) return undefined;
  try {
    return buildWorkspaceSummary(opts.cwd, { maxEntries: 24, maxChars }) || undefined;
  } catch {
    return undefined;
  }
}

export function buildPlannerUserPrompt(
  prompt: string,
  opts: { previousAttempt?: string; workspace?: string } = {},
): string {
  const parts = [`Goal:\n${prompt.trim()}`];
  if (opts.workspace?.trim()) {
    parts.push(
      '',
      '## The project this goal is about (real files on disk)',
      opts.workspace.trim(),
    );
  }
  if (opts.previousAttempt?.trim()) {
    parts.push('', opts.previousAttempt.trim());
  }
  parts.push('', 'Return ONLY the JSON object described in the system prompt.');
  return parts.join('\n');
}

function uniqueId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/** Cap on how much of the original task prompt is quoted into a verify node. */
const MAX_VERIFY_TASK_PROMPT_CHARS = 1200;

/**
 * Build the prompt for the auto-injected `verify` node.
 *
 * The verify tentacle is a fresh sub-agent that sees only this text, so a bare
 * "verify that <label> was done" gave it a three-word label and nothing else —
 * no paths, no idea what was asked — and its pass/fail verdict was worth about
 * as much. Restate the task, its scope and its acceptance criteria. What the
 * writer actually reported is injected separately at run time by the executor
 * (`buildUpstreamContext`), since it does not exist yet at planning time.
 */
function buildAutoVerifyPrompt(general: TaskNode): string {
  const taskPrompt =
    general.prompt.length > MAX_VERIFY_TASK_PROMPT_CHARS
      ? `${general.prompt.slice(0, MAX_VERIFY_TASK_PROMPT_CHARS)}\n… [truncated]`
      : general.prompt;

  const parts: string[] = [
    `Verify on disk that this work was actually completed correctly: ${general.label}.`,
    '',
    '## The task that was carried out',
    taskPrompt,
  ];
  if (general.scope && general.scope.length > 0) {
    parts.push('', '## Paths the work was scoped to', ...general.scope.map((s) => `- ${s}`));
  }
  if (general.acceptance && general.acceptance.length > 0) {
    parts.push(
      '',
      '## Acceptance criteria to check explicitly',
      ...general.acceptance.map((a) => `- ${a}`),
    );
  }
  parts.push(
    '',
    'Read the files involved rather than trusting any summary. Report the commands you ran ' +
      'and every gap you found.',
    '',
    '## How to report your verdict',
    'End your final message with a line of exactly this form, as the LAST line:',
    '',
    'VERDICT: PASS',
    '',
    'or',
    '',
    'VERDICT: FAIL',
    '',
    'This line is parsed. FAIL sends the work back to the tentacle that wrote it, together with ' +
      'everything you write above the line — so state each gap concretely enough to be acted on ' +
      '(file, what is wrong, what it should be). Only report FAIL for a real defect against the ' +
      'task or its acceptance criteria: a rework round is expensive and there is only a small ' +
      'number of them. Stylistic preferences are not a FAIL.',
  );
  return parts.join('\n');
}

/**
 * Convert LLM-planned nodes into a full `TaskGraph`, auto-injecting a
 * `verify` node after every `general` node and, once ≥2 `general` nodes
 * exist, a `merge` node depending on all their (auto-injected) verify
 * nodes — mirroring the F3 executor's sequential worktree-merge handling.
 */
export function buildGraphFromPlan(graphId: string, planned: PlannedNode[]): TaskGraph {
  const nodes: TaskNode[] = planned.map((p) => ({
    id: p.id,
    kind: p.kind,
    label: p.label,
    prompt: p.prompt,
    scope: p.scope,
    acceptance: p.acceptance,
    deps: [...p.deps],
    status: 'pending',
    retryCount: 0,
    maxRetries: DEFAULT_MAX_RETRIES[p.kind],
  }));
  const ids = new Set(nodes.map((n) => n.id));

  const generalNodes = nodes.filter((n) => n.kind === 'general');
  const verifyIdsForMerge: string[] = [];
  for (const g of generalNodes) {
    const verifyId = uniqueId(`verify-${g.id}`, ids);
    ids.add(verifyId);
    nodes.push({
      id: verifyId,
      kind: 'verify',
      label: `verify: ${g.label}`,
      prompt: buildAutoVerifyPrompt(g),
      deps: [g.id],
      status: 'pending',
      retryCount: 0,
      maxRetries: DEFAULT_MAX_RETRIES.verify,
    });
    verifyIdsForMerge.push(verifyId);
  }

  if (generalNodes.length >= 2) {
    const mergeId = uniqueId('merge', ids);
    ids.add(mergeId);
    nodes.push({
      id: mergeId,
      kind: 'merge',
      label: 'merge parallel work',
      prompt: 'Sequentially merge the parallel general tentacles once verified.',
      deps: verifyIdsForMerge,
      status: 'pending',
      retryCount: 0,
      maxRetries: DEFAULT_MAX_RETRIES.merge,
    });
  }

  return createGraph(graphId, nodes);
}

/**
 * Ask the LLM for a task DAG and return a validated, ready-to-execute
 * `TaskGraph`. Retries once with corrective feedback if the model's
 * response is malformed JSON, fails schema validation, or produces an
 * invalid graph (cycle, unknown dep, too many nodes); throws with the last
 * error after `MAX_PLAN_ATTEMPTS`. A {@link PlannerTransportError} (timeout,
 * HTTP or network failure) is rethrown on the first attempt instead — see the
 * catch block.
 */
export async function planTaskGraph(opts: PlanTaskGraphOptions): Promise<TaskGraph> {
  const client =
    opts.llmClient ?? (await createDefaultLlmClient({ provider: opts.provider, model: opts.model }));
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const graphId = opts.graphId ?? `kraken-${Date.now().toString(36)}`;
  const workspace = resolveWorkspaceListing(opts);
  const userBase = buildPlannerUserPrompt(opts.prompt, {
    ...(opts.previousAttempt ? { previousAttempt: opts.previousAttempt } : {}),
    ...(workspace ? { workspace } : {}),
  });

  let lastError: string | undefined;
  let userMessage = userBase;

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    try {
      const text = await client.complete({ system: buildPlannerSystemPrompt(), user: userMessage });
      const parsedJson = extractJsonObject(text, { requireKey: 'nodes' });
      const validated = PlannedGraphSchema.parse(parsedJson);
      // `explore` is read-only, so a plan made only of explore nodes cannot
      // change anything — yet it would run, converge, and report success.
      // Observed for real on a "continua" prompt: the model planned a single
      // "assess current workspace state" node and the graph reported 1/1 done
      // having touched nothing. Reject it here so the retry loop asks again
      // with corrective feedback.
      if (!validated.nodes.some((n) => n.kind === 'general')) {
        throw new Error(
          'the plan contains no "general" node, so it cannot change anything — ' +
            'every node is read-only "explore". Include at least one "general" node ' +
            'that performs the actual work.',
        );
      }
      const graph = buildGraphFromPlan(graphId, validated.nodes);
      const check = validateGraph(graph, { maxNodes });
      if (!check.ok) {
        throw new Error(`invalid graph: ${check.errors.join('; ')}`);
      }
      return graph;
    } catch (err) {
      // A transport failure means the model never answered — corrective
      // feedback has nothing to correct, and the retry would re-send an even
      // longer prompt into the same wall. Surface it immediately.
      if (err instanceof PlannerTransportError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      userMessage =
        `${userBase}\n\nYour previous response was invalid (${lastError}). ` +
        'Return ONLY corrected JSON matching the schema exactly — no prose, no markdown fences.';
    }
  }

  throw new Error(
    `kraken planner: failed to produce a valid task graph after ${MAX_PLAN_ATTEMPTS} attempts — ${lastError}`,
  );
}
