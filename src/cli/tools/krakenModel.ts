/**
 * krakenModel — cheap/strong model routing for Kraken tentacles (K5 + auto-pick).
 *
 * Priority per tentacle:
 *   1. Kind-specific env (ZELARI_KRAKEN_EXPLORE_MODEL / _VERIFY_ / _GENERAL_)
 *   2. Shared ZELARI_KRAKEN_SUB_MODEL (general only if GENERAL_USES_SUB=1)
 *   3. Auto-pick cheap model from discovered list (explore/verify) when enabled
 *   4. Parent model
 *
 * Graph planner (resolveKrakenPlannerModel) is the same shape:
 *   1. ZELARI_KRAKEN_PLANNER_MODEL
 *   2. Parent / lead model (opts.model, --model, persisted default)
 *
 * Auto-pick (no manual env required for cheap tentacles):
 *   - Default ON for explore/verify when no explicit model env is set
 *   - Disable with ZELARI_KRAKEN_AUTO_MODEL=0
 *   - Uses model discovery cache via getDiscoveredModelIds(provider) (async path)
 *   - Heuristic: mini|fast|flash|lite|small|haiku|air|nano|instant|...
 */

import type { TaskAgentKind } from './taskTool.js';

export interface ResolveKrakenModelOpts {
  /** Provider id for discovery cache (e.g. grok, glm, openai-compatible). */
  provider?: string;
  /** Explicit candidate model ids (tests / async loader). */
  candidates?: string[];
}

/** Heuristic: model ids that look cheaper / faster than flagship. */
const CHEAP_RE =
  /mini|fast|flash|lite|small|haiku|air|nano|instant|quick|turbo|low|3\.5|4o-mini|grok-3-mini|glm-4-flash|glm-4\.5-flash|gemini-.*-flash|claude-.*-haiku|deepseek-chat/i;

/** Flagship-ish ids we should not auto-select as "cheap". */
const FLAGSHIP_RE = /opus|ultra|reason|thinking|pro(?!-mini)|heavy|max(?!-)/i;

export function isCheapModelId(id: string): boolean {
  if (!id) return false;
  if (FLAGSHIP_RE.test(id) && !/mini|fast|flash|lite|haiku/i.test(id)) return false;
  return CHEAP_RE.test(id);
}

/**
 * Pick a cheaper model from candidates, different from parent when possible.
 * Prefers ids with mini/flash/fast; stable sort by score then name.
 */
export function pickCheapModel(
  parentModel: string,
  candidates: readonly string[],
): string | null {
  const parent = parentModel.trim();
  const uniq = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
  const cheap = uniq.filter((id) => isCheapModelId(id));
  if (cheap.length === 0) return null;

  const score = (id: string): number => {
    let s = 0;
    if (/mini/i.test(id)) s += 5;
    if (/flash/i.test(id)) s += 4;
    if (/fast/i.test(id)) s += 3;
    if (/lite|haiku|nano|air/i.test(id)) s += 3;
    if (/small|instant|quick/i.test(id)) s += 2;
    if (id === parent) s -= 10;
    s -= Math.min(id.length, 40) / 100;
    return s;
  };

  cheap.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  const notParent = cheap.find((id) => id !== parent);
  return notParent ?? cheap[0] ?? null;
}

export function isKrakenAutoModelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ZELARI_KRAKEN_AUTO_MODEL ?? '1').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

/** Resolve model id for a tentacle given the parent/active model. */
export function resolveKrakenSubModel(
  agent: TaskAgentKind,
  parentModel: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveKrakenModelOpts = {},
): string {
  const kindKey =
    agent === 'explore'
      ? 'ZELARI_KRAKEN_EXPLORE_MODEL'
      : agent === 'verify'
        ? 'ZELARI_KRAKEN_VERIFY_MODEL'
        : 'ZELARI_KRAKEN_GENERAL_MODEL';

  const specific = env[kindKey]?.trim();
  if (specific) return specific;

  const shared = env.ZELARI_KRAKEN_SUB_MODEL?.trim();
  if (shared) {
    if (agent === 'general' && !env.ZELARI_KRAKEN_GENERAL_MODEL) {
      if (env.ZELARI_KRAKEN_GENERAL_USES_SUB === '1') return shared;
      return parentModel;
    }
    return shared;
  }

  // Auto-pick cheap model for explore/verify (not general — keep strong writer).
  if (
    (agent === 'explore' || agent === 'verify') &&
    isKrakenAutoModelEnabled(env) &&
    opts.candidates &&
    opts.candidates.length > 0
  ) {
    const picked = pickCheapModel(parentModel, opts.candidates);
    if (picked) return picked;
  }

  return parentModel;
}

/**
 * Graph planner model. Desktop Settings maps the planner picker to
 * `ZELARI_KRAKEN_PLANNER_MODEL`; `runHeadless` always forwards the lead
 * `--model` as `opts.model`. The env override must therefore win — same
 * contract as tentacle kind-specific env before parent.
 */
export function resolveKrakenPlannerModel(
  parentModel: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const specific = env.ZELARI_KRAKEN_PLANNER_MODEL?.trim();
  if (specific) return specific;
  return parentModel.trim();
}

/**
 * Per-persona model resolution (Pillar 2 / Slice I). Persona kinds
 * (`spec`, `conformance`) route to the same underlying `verify` agent,
 * but the user may want a different model for them (e.g. conformance is
 * literal and benefits from a strong model; spec-reviewer is conservative
 * and works fine with a cheap one). Env vars:
 *
 *   ZELARI_KRAKEN_SPEC_MODEL          — for `kind: 'spec'`
 *   ZELARI_KRAKEN_CONFORMANCE_MODEL   — for `kind: 'conformance'`
 *   ZELARI_KRAKEN_ORACLE_MODEL        — for `kind: 'oracle'` (future)
 *
 * Unset → fall back to the per-agent resolution above (`verify` model
 * for both). This is conservative: spec and conformance get the same
 * model as `verify` unless the user explicitly opts in.
 */
export function resolvePersonaModel(
  kind: 'spec' | 'conformance' | 'oracle' | string,
  parentModel: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveKrakenModelOpts = {},
): string {
  const personaKey =
    kind === 'spec'
      ? 'ZELARI_KRAKEN_SPEC_MODEL'
      : kind === 'conformance'
        ? 'ZELARI_KRAKEN_CONFORMANCE_MODEL'
        : kind === 'oracle'
          ? 'ZELARI_KRAKEN_ORACLE_MODEL'
          : '';
  const specific = personaKey ? env[personaKey]?.trim() : undefined;
  if (specific) return specific;
  // Fall back to the `verify` resolution: all three personas are
  // reviewer-style and share the same tool budget. This means a user
  // who sets `ZELARI_KRAKEN_VERIFY_MODEL` gets the same model for all
  // three unless they override per-persona.
  return resolveKrakenSubModel('verify', parentModel, env, opts);
}

/**
 * Async resolve that loads discovery cache (ESM). Prefer this from toolRegistry.
 */
export async function resolveKrakenSubModelAsync(
  agent: TaskAgentKind,
  parentModel: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { provider?: string } = {},
): Promise<string> {
  let candidates: string[] = [];
  if (opts.provider) {
    try {
      const mod = await import('../modelDiscovery.js');
      const ids = mod.getDiscoveredModelIds(opts.provider as never);
      if (Array.isArray(ids)) candidates = ids;
    } catch {
      candidates = [];
    }
  }
  return resolveKrakenSubModel(agent, parentModel, env, {
    provider: opts.provider,
    candidates,
  });
}
