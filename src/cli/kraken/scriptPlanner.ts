/**
 * Kraken script planner — emits `.ts` plans instead of JSON DAGs.
 *
 * Companion to `planner.ts` (the JSON-DAG path). Same LLM plumbing, same
 * model selection, same workspace summary — different system prompt and
 * different output (TypeScript source, not a parsed JSON object).
 *
 * The script planner is opt-in: the JSON path stays the default for small
 * goals. Select via `ZELARI_KRAKEN_PLAN_FORMAT=script`. The `auto` mode
 * (future) picks the script path when the goal suggests > 4 nodes.
 *
 * On parse / compile failure, retry once with corrective feedback; on
 * second failure, surface the error so the caller can fall back to the
 * JSON-DAG path.
 *
 * @since Kraken v1.30.x — workflow script runtime (F1.2)
 */

import { promises as fs } from 'node:fs';
import { build } from 'esbuild';
import path from 'node:path';
import { z } from 'zod';
import { buildWorkspaceSummary } from '../workspace/workspaceSummary.js';
import { resolveApiKeyWithMeta, type ProviderName } from '../keyStore.js';
import { resolveBaseUrl } from '../provider/openai-compatible.js';
import { getModelForProvider, getProviderConfig } from '../providerConfig.js';
import { PlannerTransportError, type PlannerLlmClient } from './planner.js';
import { resolveKrakenPlannerModel } from '../tools/krakenModel.js';

const MAX_PLAN_ATTEMPTS = 2;

const ScriptPlannerOptionsSchema = z.object({
  prompt: z.string().min(1),
  graphId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  previousAttempt: z.string().optional(),
  cwd: z.string().optional(),
  workspace: z.string().optional(),
  llmClient: z.custom<PlannerLlmClient>().optional(),
});

export type PlanScriptOptions = z.infer<typeof ScriptPlannerOptionsSchema>;

export interface PlanScriptResult {
  /** Where the `.ts` plan was written. */
  planPath: string;
  /** The plan source as the LLM emitted it (post-fence-strip). */
  source: string;
  /** Bytes the LLM produced. */
  bytes: number;
  /** Number of LLM calls made (1 or 2 with retry). */
  attempts: number;
  /** Always `true` when the function returns: compilation must succeed. */
  compiled: true;
}

/** SDK surface the script can import. Mirrored in the system prompt. */
const SDK_SURFACE_DOC = `\
- \`tentacle({ kind, label, prompt, scope?, acceptance?, deps?, maxRetries?, maxRuntimeMs? })\`
  Returns a \`TentacleRef { id, kind, label, status, findings, verdict?, scope? }\`.
  - \`kind\`: "explore" | "general" | "verify" | "fix" | "merge".
  - \`prompt\`: self-contained instruction handed to the sub-agent.
  - \`scope\`: path/glob allowlist (required for parallel writers).
  - \`acceptance\`: checkable checklist (enforced by verify tentacles).
- \`merge([refs], { strategy?, message?, cleanup? })\` — ONE-SHOT per plan.
- \`barrier([t1, t2, t3])\` — typed wait over N parallel tentacles.
- \`race([t1, t2])\` — first-completed wins; losers are skipped.
- \`while_(cond, body, maxIter)\` / \`until(cond, body, maxIter)\` — bounded loops.
- \`checkpoint(label?)\` — persist the current plan state to disk.
- \`log(msg, data?)\` / \`emit({ kind, detail? })\` — radio + workbench events.
- \`getContext()\` — read-only { graphId, goal, parentCwd, maxTentacles, planTimeoutMs }.`;

export const KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT = [
  'You are the SCRIPT PLANNER for Kraken, a multi-agent graph executor.',
  '',
  'You write a TypeScript module that imports capabilities from',
  "'@zelari/kraken-runtime' and calls them to drive a multi-agent run.",
  '',
  'Return ONLY the TypeScript source — no markdown fence, no prose, no',
  "explanation. The whole response is parsed as code, so even one extra",
  "character outside the source breaks the run.",
  '',
  '# SDK',
  '',
  '```ts',
  "import { tentacle, merge, barrier, race, while_, until, checkpoint, log, emit, getContext } from '@zelari/kraken-runtime';",
  '```',
  '',
  SDK_SURFACE_DOC,
  '',
  '# Constraints',
  '',
  '- The plan is a script, NOT a graph: call `tentacle()` in the order you',
  '  want, with whatever control flow makes sense. Sequential calls are',
  '  sequential; `Promise.all([...])` is parallel.',
  '- You do NOT need to declare deps explicitly. The script awaits each',
  "  `tentacle()` in turn; whatever has already run is in scope by id.",
  '- You can only `merge()` ONCE. If you need to merge at two stages, split',
  '  into two plans (run them sequentially) or use checkpoint + follow-up.',
  '- Use `while_` / `until` for the Gauntlet Loop pattern: a writer runs,',
  '  a verify judges it, and on FAIL the body retries with the verify',
  "  findings as context. Cap `maxIter` — the wall-clock budget cuts past it.",
  '- Reach for `Promise.all` to fan out independent writers in parallel.',
  '  When you do, give each a `scope` of paths it may touch; the executor',
  '  refuses to run two parallel writers with overlapping scopes.',
  '- End with either `merge(...)` or no merge and a final `log(...)`. Both',
  '  are valid convergence shapes.',
  '',
  '# Style',
  '',
  '- Top-level `await` is fine. Write the plan as a sequence of',
  '  `const x = await ...`.',
  '- No `import` other than the SDK. The plan is single-file.',
  '- No `process`, `require`, `Buffer`, `eval`, or `new Function` — the',
  '  sandbox will reject the bundle.',
  '- Keep it under ~200 lines. The plan is a sketch of intent, not full code.',
  '',
  '# Default shape (most goals fit this)',
  '',
  '1. `const ctx = await tentacle({ kind: "explore", label: "map", prompt: "..." })`',
  '2. `const [a, b, c] = await Promise.all([tentacle({ kind: "general", scope: [...] }), ...])`',
  '3. `const verify = await tentacle({ kind: "verify", label: "judge", deps: [a, b, c] })`',
  '4. `if (verify.verdict === "fail") { ... rework via while_ ... }`',
  '5. `await merge([a, b, c])`',
  '',
  '# Reviewer personas (Pillar 2)',
  '',
  'Three reviewer kinds exist, all using the same trailer format:',
  '',
  '- `kind: "verify"` — checks `acceptance[]` on disk. Default after every writer.',
  '- `kind: "spec"` — compares the writer\'s output against a written spec,',
  '  per requirement. System prompt is the spec-reviewer persona (conservative).',
  '  Use when the task has a written spec / plan you can paste into the prompt.',
  '- `kind: "conformance"` — compares the writer\'s output against the user\'s',
  '  ORIGINAL VERBATIM PROMPT. System prompt is the conformance-reviewer persona',
  '  (literal). Use as the LAST reviewer before `merge()` on goal-aligned tasks.',
  '',
  'All three return `{ kind, status, findings, verdict }`. The trailer is',
  '`VERDICT: PASS|FAIL`; the per-requirement table (when present) is a JSON',
  'code block before the trailer. Failure rewrites the work via the existing',
  '`while_` pattern.',
  '',
  'Example with all three personas:',
  '',
  '```ts',
  'const writer = await tentacle({ kind: "general", label: "do it", prompt: "...", scope: ["src/x"] });',
  'const verify = await tentacle({ kind: "verify", label: "acceptance", deps: [writer] });',
  'const spec = await tentacle({ kind: "spec", label: "spec review", deps: [writer], prompt: "<paste spec here>" });',
  'const conf = await tentacle({ kind: "conformance", label: "conformance", deps: [writer], prompt: "<paste user prompt here>" });',
  'if (verify.verdict === "fail" || spec.verdict === "fail" || conf.verdict === "fail") {',
  '  // rework via while_',
  '}',
  'await merge([writer]);',
  '```',
].join('\n');

/**
 * Plan a script: ask the LLM for a `.ts` source, strip any markdown fence,
 * compile it (esbuild) to validate syntax, write to
 * `.zelari/kraken/runs/<graphId>/plan.ts`, return the path. On any failure,
 * retry once with corrective feedback; on second failure, throw.
 *
 * NOTE: the resolver / `createDefaultLlmClient` is duplicated from
 * `planner.ts` to keep this slice's diff small. A future slice will
 * extract both into `plannerHelpers.ts`.
 */
export async function planScript(opts: PlanScriptOptions): Promise<PlanScriptResult> {
  // Empty-prompt check before Zod so the error message is friendlier.
  if (!opts.prompt || !opts.prompt.trim()) {
    throw new Error('planScript: prompt is required');
  }
  const parsed = ScriptPlannerOptionsSchema.parse(opts);
  const client =
    parsed.llmClient ?? (await createScriptPlannerLlmClient({ provider: parsed.provider, model: parsed.model }));
  const graphId = parsed.graphId ?? `kraken-script-${Date.now().toString(36)}`;
  const workspace = await resolveWorkspaceListing(parsed);
  const baseUser = buildUserPrompt(parsed.prompt, workspace, parsed.previousAttempt);

  const runDir = parsed.cwd
    ? path.join(parsed.cwd, '.zelari', 'kraken', 'runs', graphId)
    : path.join('.zelari', 'kraken', 'runs', graphId);
  const planPath = path.join(runDir, 'plan.ts');

  let lastError: string | undefined;
  let userMessage = baseUser;
  let source = '';
  let bytes = 0;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    attempts = attempt;
    let text: string;
    try {
      text = await client.complete({ system: KRAKEN_SCRIPT_PLANNER_SYSTEM_PROMPT, user: userMessage });
    } catch (err) {
      throw new PlannerTransportError(err instanceof Error ? err.message : String(err));
    }
    bytes = text.length;
    source = extractCodeBlock(text, 'ts');
    if (!source.trim()) {
      lastError = 'response was empty or not a code block';
      userMessage = `${baseUser}\n\n---\n\nYour last reply was empty or not a TypeScript code block. Return ONLY TypeScript source — no markdown fence.`;
      continue;
    }
    try {
      await build({
        stdin: { contents: source, resolveDir: parsed.cwd ?? process.cwd(), loader: 'ts' },
        bundle: false,
        write: false,
        logLevel: 'silent',
      });
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(planPath, source, 'utf8');
      return { planPath, source, bytes, attempts, compiled: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      userMessage = `${baseUser}\n\n---\n\nYour last script failed to compile with esbuild. The error was:\n\n${lastError}\n\nFix the error and return ONLY the corrected TypeScript source.`;
    }
  }

  throw new Error(
    `kraken script planner: failed to produce a compilable plan after ${MAX_PLAN_ATTEMPTS} attempts — ${lastError ?? 'unknown'}`,
  );
}

/** Build the workspace listing handed to the planner. Reuses the JSON
 *  planner's summary so the two paths see the same project context. */
async function resolveWorkspaceListing(opts: { cwd?: string; workspace?: string }): Promise<string> {
  if (opts.workspace) return opts.workspace;
  if (!opts.cwd) return '(no project listing — no cwd provided)';
  const budget = Number.parseInt(process.env.ZELARI_KRAKEN_PLANNER_WORKSPACE_CHARS ?? '3000', 10);
  const maxChars = Number.isFinite(budget) && budget > 0 ? budget : 3000;
  return buildWorkspaceSummary(opts.cwd, { maxChars });
}

function buildUserPrompt(prompt: string, workspace: string, previousAttempt?: string): string {
  return [
    '## Goal',
    prompt.trim(),
    '',
    '## Project listing (real paths on disk; build `scope` from these)',
    workspace,
    '',
    previousAttempt ? `## Previous unfinished graph in this project\n${previousAttempt}\n` : '',
    'Write the plan now. Return ONLY TypeScript source — no markdown fence.',
  ].join('\n');
}

/**
 * Strip a markdown ```ts / ```typescript / ``` fence from a model reply, if
 * present. Returns the inner text or the original if no fence is found.
 *
 * Mirrors the JSON planner's `bodyOf` for the `.ts` language.
 */
export function extractCodeBlock(text: string, language: 'ts' | 'js' | string): string {
  const trimmed = text.trim();
  const re = new RegExp('^```(?:' + language + '|typescript|javascript)?\\s*([\\s\\S]*?)```\\s*$', 'i');
  const m = re.exec(trimmed);
  if (m) return m[1]!.trim();
  // Unfenced: assume the whole reply is code (most common shape for
  // models that follow the "no fence" instruction).
  return trimmed;
}

/** Local LLM client builder, duplicated from `planner.ts` to keep the diff
 *  small. Will be unified in a follow-up slice. */
async function createScriptPlannerLlmClient(opts: {
  provider?: string;
  model?: string;
}): Promise<PlannerLlmClient> {
  const active = (opts.provider?.trim() || getProviderConfig().activeProviderId) as ProviderName;
  const meta = await resolveApiKeyWithMeta(active);
  if (!meta?.apiKey) {
    throw new Error(`No API key for provider '${active}'. Save a key in Settings → Provider.`);
  }
  const baseUrl = resolveBaseUrl(active);
  if (!baseUrl) {
    throw new Error(`No base URL for provider '${active}'. Set a custom endpoint in Settings.`);
  }
  const parent =
    opts.model?.trim() ||
    getModelForProvider(active) ||
    'grok-4.5';
  const model = resolveKrakenPlannerModel(parent);
  // We just need the `complete` function. The metadata is unused past this
  // point; the planner only needs to call the LLM.
  return {
    async complete({ system, user }: { system: string; user: string }): Promise<string> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(meta.apiKey ? { authorization: `Bearer ${meta.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          temperature: 0.2,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('LLM returned no content');
      return content;
    },
  };
}
