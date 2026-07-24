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

const LLM_TIMEOUT_MS = 90_000;
const MAX_PLAN_ATTEMPTS = 2;

/** Default retry budget per auto-generated/planned node kind. */
const DEFAULT_MAX_RETRIES: Record<TaskNodeKind, number> = {
  explore: 0,
  general: 1,
  verify: 1,
  fix: 0,
  merge: 0,
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
  '- Do NOT emit "verify", "fix", or "merge" nodes — the executor adds those automatically.',
  '- "id" must be short, unique, kebab-case (e.g. "e1", "g-auth", "g-ui").',
  '- "prompt" must be fully self-contained: the sub-agent sees ONLY this prompt, not this conversation.',
  '- "deps" lists ids of nodes that must finish first (topological order); [] if none.',
  '- When two "general" nodes touch disjoint parts of the codebase, give each a "scope" ' +
    '(path/glob allowlist) so they can run in parallel safely. If scopes might overlap, ' +
    'either omit scope (forces sequential execution) or add a dep between them.',
  '- Prefer one "explore" node feeding several parallel "general" nodes over one giant node.',
  '- Keep the graph small: most goals need 3-8 nodes total.',
  '- "acceptance" (optional) lists concrete, checkable criteria for a "general" node.',
].join('\n');

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
}

/**
 * Strip ```json fences, extract the first balanced `{...}` object (tolerating
 * trailing text), and parse it — falling back to {@link repairLooseJson} when
 * a strict parse fails. Some models emit JS-object-literal-ish output
 * (unquoted keys, single-quoted strings, trailing commas) despite explicit
 * "valid JSON only" instructions; repairing once here is cheaper and more
 * reliable than relying solely on the retry-with-feedback loop for a mistake
 * a model tends to repeat identically.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  const balanced = extractBalancedJsonObject(body);
  const candidate = balanced ?? body;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    try {
      return JSON.parse(repairLooseJson(candidate));
    } catch {
      throw err instanceof Error ? err : new Error(String(err));
    }
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
 * style), unquoted/bareword object keys (JS-object-literal style), and
 * trailing commas before `}`/`]`. Deliberately permissive — this is a
 * fallback tried only after a strict `JSON.parse` has already failed, not a
 * general JSON5 parser.
 */
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
        value += c;
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
  const active = (opts.provider?.trim() || getProviderConfig().activeProviderId) as ProviderName;
  const meta = await resolveApiKeyWithMeta(active);
  if (!meta?.apiKey) {
    throw new Error(`No API key for provider '${active}'. Save a key in Settings → Provider.`);
  }
  const baseUrl = resolveBaseUrl(active);
  if (!baseUrl) {
    throw new Error(`No base URL for provider '${active}'. Set a custom endpoint in Settings.`);
  }
  const model =
    opts.model?.trim() || getModelForProvider(active) || process.env.ZELARI_MODEL || '';
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
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          throw new Error(`LLM HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = json.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('Empty model response');
        return text;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

function buildPlannerUserPrompt(prompt: string): string {
  return `Goal:\n${prompt.trim()}\n\nReturn ONLY the JSON object described in the system prompt.`;
}

function uniqueId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function buildAutoVerifyPrompt(general: TaskNode): string {
  const acc =
    general.acceptance && general.acceptance.length > 0
      ? `\n\nAcceptance criteria to check:\n${general.acceptance.map((a) => `- ${a}`).join('\n')}`
      : '';
  return `Verify the following work was completed correctly on disk: ${general.label}.${acc}`;
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
 * error after `MAX_PLAN_ATTEMPTS`.
 */
export async function planTaskGraph(opts: PlanTaskGraphOptions): Promise<TaskGraph> {
  const client =
    opts.llmClient ?? (await createDefaultLlmClient({ provider: opts.provider, model: opts.model }));
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const graphId = opts.graphId ?? `kraken-${Date.now().toString(36)}`;
  const userBase = buildPlannerUserPrompt(opts.prompt);

  let lastError: string | undefined;
  let userMessage = userBase;

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    try {
      const text = await client.complete({ system: KRAKEN_PLANNER_SYSTEM_PROMPT, user: userMessage });
      const parsedJson = extractJsonObject(text);
      const validated = PlannedGraphSchema.parse(parsedJson);
      const graph = buildGraphFromPlan(graphId, validated.nodes);
      const check = validateGraph(graph, { maxNodes });
      if (!check.ok) {
        throw new Error(`invalid graph: ${check.errors.join('; ')}`);
      }
      return graph;
    } catch (err) {
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
