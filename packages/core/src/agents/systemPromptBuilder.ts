import type {
  EnhancedToolDefinition,
  SkillDefinition,
  SystemPromptModule,
  SystemPromptConfig,
} from '../types/systemTypes.js';
import type { AgentRole as CoreAgentRole } from '../types/index.js';
import {
  getBasePromptModules,
  type PromptPackMode,
} from './promptModules.js';
import {
  PROPRIETARY_SECRECY_MARKER,
  PROPRIETARY_SECRECY_MODULE,
} from './secrecyPolicy.js';
import { resolveAgentSkills, getSkillById } from './skills.js';

/**
 * System Prompt Builder.
 *
 * Assembles a dynamic system prompt for an agent from:
 *   1. Base prompt modules (identity, behavior, safety, ...)
 *   2. The agent's own inline systemPrompt (from roles.ts) — kept as a role-specific block.
 *   3. The systemPromptFragment of each enabled skill for the agent.
 *   4. The documentation block for the tools available to the agent.
 *   5. Optional workspace context summary.
 *   6. User-authored custom prompt modules.
 */

/**
 * Compute the effective skills for an agent, factoring in:
 *  - the agent's declared skills (roles.ts / custom)
 *  - the global enabledSkills list from the AI config (master switch)
 *  - the agentSkillConfigs override
 */
export function computeAgentSkills(
  agent: CoreAgentRole & { skills?: string[] },
  aiConfig?: SystemPromptConfig,
  customSkills?: import('../types/index.js').CustomSkill[]
): SkillDefinition[] {
  const declared = agent.skills ?? resolveAgentSkills(agent.id).map((s) => s.id);

  // Global master switch: if defined, skills must be globally enabled to apply.
  const globalEnabled = aiConfig?.enabledSkills;

  // Per-agent override
  const override = aiConfig?.agentSkillConfigs.find((c) => c.agentId === agent.id);

  let effectiveIds: string[];
  if (override) {
    effectiveIds = override.enabledSkillIds;
  } else if (globalEnabled && globalEnabled.length > 0) {
    effectiveIds = declared.filter((id) => globalEnabled.includes(id));
  } else {
    effectiveIds = declared;
  }

  // Custom skills that auto-attach to this agent.
  const customs = customSkills ?? [];
  for (const cs of customs) {
    if (cs.enabled && cs.autoAttachTo?.includes(agent.id) && !effectiveIds.includes(cs.id)) {
      effectiveIds.push(cs.id);
    }
  }

  const builtin: SkillDefinition[] = effectiveIds
    .map((id) => getSkillById(id))
    .filter((s): s is SkillDefinition => s !== undefined);

  // Add custom skills as synthetic SkillDefinition (fragment will be injected
  // in buildSystemPrompt via the `customSkillFragments` map).
  const customDefs: SkillDefinition[] = [];
  for (const cs of customs) {
    if (!cs.enabled) continue;
    if (effectiveIds.includes(cs.id) && !builtin.find((b) => b.id === cs.id)) {
      customDefs.push({
        id: cs.id,
        name: cs.name,
        description: cs.description,
        category: cs.category,
        color: cs.color,
        enabledByDefault: cs.enabled,
        builtin: false,
        requiredTools: cs.requiredTools,
        systemPromptFragment: cs.systemPromptFragment,
      });
    }
  }

  return [...builtin, ...customDefs];
}

/**
 * Compute the effective tools for an agent: the union of the required tools
 * of its enabled skills plus its declared tools, filtered by the global
 * enabledTools master switch when present.
 */
export function computeAgentTools(
  agent: CoreAgentRole & { skills?: string[] },
  aiConfig?: SystemPromptConfig
): string[] {
  const skills = computeAgentSkills(agent, aiConfig);
  const skillTools = skills.flatMap((s) => s.requiredTools);
  const declared = agent.tools ?? [];
  const merged = Array.from(new Set([...declared, ...skillTools]));

  const globalEnabled = aiConfig?.enabledTools;
  if (globalEnabled && globalEnabled.length > 0) {
    return merged.filter((t) => globalEnabled.includes(t));
  }
  return merged;
}

/** Generate the AVAILABLE TOOLS documentation block for the given tools. */
export function getToolDescriptions(
  toolNames: string[],
  registry: Map<string, EnhancedToolDefinition>
): string {
  const lines: string[] = ['AVAILABLE TOOLS (use ONLY these exact names):'];
  // Canonical lexicographic order keeps the tool block byte-stable across
  // sessions regardless of registry insertion order (MCP/skill tools connect
  // in varying order) — critical for prompt-cache prefix hits.
  const orderedNames = [...toolNames].sort((a, b) => a.localeCompare(b));
  for (const name of orderedNames) {
    const tool = registry.get(name);
    if (!tool) continue;
    // parameters may be either ToolParameter[] (builtin) or a plain JSON
    // Schema object (custom tools). Build the param line accordingly.
    let paramList: string;
    if (Array.isArray(tool.parameters)) {
      paramList = (tool.parameters as { name: string; type: string; description?: string }[])
        .map((p) => `${p.name}:${p.type}`)
        .join(', ');
    } else {
      const obj = tool.parameters as { properties?: Record<string, { type?: string }> };
      paramList = Object.entries(obj.properties ?? {})
        .map(([k, v]) => `${k}:${v.type ?? 'any'}`)
        .join(', ');
    }
    lines.push(`- ${name}: ${tool.description} — args { ${paramList} }`);
  }
  return lines.join('\n');
}

/** Options shared by buildSystemPrompt / buildSystemPromptSplit. */
export type BuildSystemPromptOptions = {
  tools: EnhancedToolDefinition[];
  toolNames: string[];
  aiConfig?: SystemPromptConfig;
  workspaceContext?: string;
  ragContext?: string;
  mode?: PromptPackMode;
  projectInstructions?: string;
  /** Default true. Set false to avoid double-inject with separate system msgs. */
  includeWorkspaceInPrompt?: boolean;
  /**
   * Optional durable-state materialization (Palmer accumulation).
   * Always placed in the *volatile* section so it never busts the cache prefix.
   */
  durableStateContext?: string;
};

/**
 * Split system prompt for prompt-cache efficiency (AGNT Labs Cache Wars):
 * - **stable**: identity, secrecy, role, project instructions, skills, tools
 *   — byte-stable across turns when mode/tools/skills do not change
 * - **volatile**: workspace, RAG, durable state — may change every turn
 *
 * Callers should send stable first, then volatile (separate system messages
 * or concatenated stable+volatile). Never put volatile before stable.
 */
export function buildSystemPromptSplit(
  agent: CoreAgentRole & { skills?: string[] },
  options: BuildSystemPromptOptions,
): { stable: string; volatile: string } {
  const {
    tools,
    toolNames,
    aiConfig,
    workspaceContext,
    ragContext,
    mode = 'council', // 'kraken' | 'council' (| legacy 'agent')
    projectInstructions,
    includeWorkspaceInPrompt = true,
    durableStateContext,
  } = options;
  const registry = new Map(tools.map((t) => [t.name, t]));

  // 1. Base modules (filtered by conditional predicates against the agent's skills)
  const skills = computeAgentSkills(agent, aiConfig);
  const baseModules = getBasePromptModules(mode).filter(
    (m) => !m.conditional || m.conditional(skills)
  );

  // 2. Custom user modules. v0.7.2: a custom module with the SAME `type` as a
  // base module REPLACES it (override semantics), rather than being appended.
  // This makes the council identity configurable — a caller can ship a custom
  // 'base-identity' module via aiConfig.customPromptModules and it wins over
  // the builtin.
  //
  // 2026-09-24 prompt audit:
  //   - `custom` is the catch-all type shared by most base modules, so it is
  //     NEVER an override key: a delegation-policy module (type `custom`)
  //     used to drop Coding Practices, Turn Completion, Clarification,
  //     Reasoning, Tool-Use and Output Quality from the Kraken prompt.
  //   - A replacing module takes the SLOT of the module it replaces (the
  //     Kraken identity sat at +1000, after a dozen rule blocks, so the
  //     prompt opened on confidentiality instead of who the agent is).
  //   - `language-policy` keeps its declared priority (harness-pinned early).
  //   - Everything else is appended after the base pack (+1000), as before.
  const customModulesRaw = aiConfig?.customPromptModules ?? [];
  const baseByType = new Map<SystemPromptModule['type'], SystemPromptModule>();
  for (const m of baseModules) if (m.type !== 'custom' && !baseByType.has(m.type)) baseByType.set(m.type, m);
  const customTypes = new Set<SystemPromptModule['type']>(
    customModulesRaw.map((m) => m.type).filter((t) => t !== 'custom'),
  );
  const baseNotOverridden = baseModules.filter((m) => !customTypes.has(m.type));
  const customModules: SystemPromptModule[] = customModulesRaw.map((m) => {
    const replaced = m.type === 'custom' ? undefined : baseByType.get(m.type);
    const priority = replaced
      ? replaced.priority
      : m.type === 'language-policy'
        ? m.priority
        : 1000 + m.priority;
    return { ...m, priority };
  });

  const allModules = [...baseNotOverridden, ...customModules].sort((a, b) => a.priority - b.priority);

  const stableParts: string[] = [];
  for (const mod of allModules) {
    stableParts.push(mod.content);
  }

  // Non-optional IP guard: always present even if custom modules replace types.
  const assembledSoFar = stableParts.join('\n');
  if (!assembledSoFar.includes(PROPRIETARY_SECRECY_MARKER)) {
    stableParts.splice(1, 0, PROPRIETARY_SECRECY_MODULE.content);
  }

  // 3. Agent's inline role prompt (role-specific persona)
  if (agent.systemPrompt && agent.systemPrompt.trim()) {
    stableParts.push(`# Your Role\n\n${agent.systemPrompt}`);
  }

  // 3b. Project instructions (AGENTS.md / CLAUDE.md) — coding CLI baseline
  // Treated as stable for a session (file rarely mid-turn); if AGENTS.md changes
  // mid-session the stable hash will bust intentionally.
  if (projectInstructions && projectInstructions.trim()) {
    stableParts.push(`# Project Instructions\n\n${projectInstructions.trim()}`);
  }

  // 4. Skill prompt fragments
  if (skills.length > 0) {
    stableParts.push(
      `# Active Skills\n\n` +
        skills.map((s) => `## ${s.name}\n${s.systemPromptFragment}`).join('\n\n')
    );
  }

  // 5. Tool documentation
  const toolBlock = getToolDescriptions(toolNames, registry);
  if (toolNames.length > 0) {
    stableParts.push(`# Tools\n\n${toolBlock}`);
  }

  // 6. Volatile context (workspace / RAG / durable state)
  const volatileParts: string[] = [];
  if (includeWorkspaceInPrompt) {
    if (workspaceContext && workspaceContext.trim()) {
      volatileParts.push(`# Current Workspace State\n\n${workspaceContext}`);
    }
    if (ragContext && ragContext.trim()) {
      volatileParts.push(`# Retrieved Knowledge (RAG)\n\n${ragContext}`);
    }
  }
  if (durableStateContext && durableStateContext.trim()) {
    volatileParts.push(`# Durable State (verified)\n\n${durableStateContext.trim()}`);
  }

  return {
    stable: stableParts.join('\n\n---\n\n'),
    volatile: volatileParts.join('\n\n---\n\n'),
  };
}

/**
 * Build the full system prompt for an agent.
 *
 * Prefers {@link buildSystemPromptSplit} and concatenates stable + volatile
 * for backward compatibility with callers that expect a single string.
 *
 * @param options.mode - \`kraken\` (alias \`agent\`; default single-harness) uses the lean
 *   coding pack; \`council\` keeps collaboration + clarification modules.
 * @param options.projectInstructions - optional AGENTS.md / CLAUDE.md body.
 * @param options.includeWorkspaceInPrompt - when false, skip embedding
 *   workspace/RAG here (caller injects separately). Default true.
 */
export function buildSystemPrompt(
  agent: CoreAgentRole & { skills?: string[] },
  options: BuildSystemPromptOptions,
): string {
  const { stable, volatile } = buildSystemPromptSplit(agent, options);
  if (!volatile) return stable;
  if (!stable) return volatile;
  return `${stable}\n\n---\n\n${volatile}`;
}

/**
 * Layout of the volatile prompt segment (M2.1, cache-hit-rate plan).
 *
 * - `trailing` (default): the volatile segment travels as an EPHEMERAL user
 *   message AFTER the history, so a workspace/RAG/durable change busts only the
 *   request tail instead of the whole system prefix.
 * - `legacy`: pre-M2 assembly — `[stable, volatile]` system messages emitted
 *   BEFORE the history. Rollback switch, kept for one release cycle.
 */
export type PromptLayout = 'trailing' | 'legacy';

/** Env switch: `ZELARI_PROMPT_LAYOUT=legacy` opts back into the pre-M2 layout. */
export const PROMPT_LAYOUT_ENV = 'ZELARI_PROMPT_LAYOUT';

/** Opening tag of the ephemeral trailing context message. */
export const TRAILING_CONTEXT_OPEN_TAG = '<context-update>';
/** Closing tag of the ephemeral trailing context message. */
export const TRAILING_CONTEXT_CLOSE_TAG = '</context-update>';

let promptLayoutCache: PromptLayout | undefined;

/**
 * Resolve the prompt layout ONCE per process and reuse it (same freeze
 * discipline as the M3.1 session provider params): a layout flip mid-session
 * would re-shuffle the request prefix on every call and destroy the cache for
 * the rest of the session.
 */
export function resolvePromptLayout(
  env: Record<string, string | undefined> = process.env,
): PromptLayout {
  if (promptLayoutCache === undefined) {
    promptLayoutCache =
      env[PROMPT_LAYOUT_ENV]?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'trailing';
  }
  return promptLayoutCache;
}

/** Test seam: forget the memoized layout so a test can re-read the env. */
export function resetPromptLayoutCache(): void {
  promptLayoutCache = undefined;
}

/** Last (volatile → trailing body) render, so an unchanged input is reused verbatim. */
let lastTrailingRender: { volatile: string; body: string } | undefined;

/**
 * Wrap the volatile segment as the body of an ephemeral trailing message.
 * Returns '' when the volatile segment is empty (callers then add NO message).
 *
 * Pure in content; the one-entry memo only guarantees that consecutive renders
 * of an unchanged volatile segment hand back the same byte-identical string
 * (M2.3 determinism: a byte of drift here costs a cache miss on the tail).
 */
export function wrapTrailingContext(volatile: string): string {
  const body = volatile.trim();
  if (lastTrailingRender?.volatile === body) return lastTrailingRender.body;
  const wrapped = body ? `${TRAILING_CONTEXT_OPEN_TAG}\n${body}\n${TRAILING_CONTEXT_CLOSE_TAG}` : '';
  lastTrailingRender = { volatile: body, body: wrapped };
  return wrapped;
}

/** Ephemeral trailing body for a split prompt ('' when nothing is volatile). */
export function trailingContextFromSplit(split: { stable: string; volatile: string }): string {
  return wrapTrailingContext(split.volatile);
}

/**
 * True when `content` is a trailing context message built by
 * {@link wrapTrailingContext}. Callers use this to drop the ephemeral message
 * when they re-seed a follow-up pass instead of carrying it over.
 */
export function isTrailingContextContent(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith(TRAILING_CONTEXT_OPEN_TAG) && trimmed.endsWith(TRAILING_CONTEXT_CLOSE_TAG)
  );
}

/** Minimal message shape produced/consumed by the layout helpers. */
export type PromptLayoutMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

/**
 * The ephemeral trailing context message (0 or 1 message) for a split prompt.
 *
 * EPHEMERAL BY CONTRACT: it belongs to the request body only — never persist it
 * to the session spine or the rolling history, or it re-enters the next turn's
 * transcript and duplicates the volatile context on every turn.
 */
export function trailingContextMessagesFromSplit(split: {
  stable: string;
  volatile: string;
}): Array<{ role: 'user'; content: string }> {
  const body = trailingContextFromSplit(split);
  return body ? [{ role: 'user', content: body }] : [];
}

/**
 * Assemble the model-facing message list for one request (M2.1).
 *
 * - `trailing` (default): `[stable system][history][trailing context][new turn]`
 * - `legacy`:             `[stable, volatile system][history][new turn]`
 *
 * Pure and provider-agnostic: the array returned here is what the harness puts
 * on the wire, so the trailing context lives only in the HTTP body.
 */
export function assembleRequestMessages(input: {
  /** Split prompt (builder output). */
  split: { stable: string; volatile: string };
  /** Prior turns (spine-derived history). */
  history: readonly PromptLayoutMessage[];
  /** The new turn's messages (usually a single user message). */
  turn: readonly PromptLayoutMessage[];
  /** Defaults to the session-frozen {@link resolvePromptLayout}. */
  layout?: PromptLayout;
}): {
  messages: PromptLayoutMessage[];
  /** System-prefix length, for seed slicing `[..system, ...history, ..]`. */
  systemCount: number;
  /** Trailing message count (0 or 1) — part of the seed, never of the history. */
  trailingCount: number;
} {
  const layout = input.layout ?? resolvePromptLayout();
  const systemMessages = systemMessagesFromSplit(input.split, {
    includeVolatile: layout === 'legacy',
  });
  const trailingMessages =
    layout === 'legacy' ? [] : trailingContextMessagesFromSplit(input.split);
  return {
    messages: [...systemMessages, ...input.history, ...trailingMessages, ...input.turn],
    systemCount: systemMessages.length,
    trailingCount: trailingMessages.length,
  };
}

/**
 * Assemble AgentMessage system slots from a split prompt.
 * Multi-system when both parts present (stable first — required for prefix cache).
 * Set `singleSystem: true` to concatenate for providers that reject multi-system.
 *
 * M2.1 default: **stable only** — the volatile segment moves to the ephemeral
 * trailing message after the history (see {@link assembleRequestMessages}), so a
 * workspace/RAG change cannot bust the cached system prefix. Pass
 * `includeVolatile: true` for the pre-M2 shape `[stable, volatile]` (rollback
 * layout `legacy`).
 */
export function systemMessagesFromSplit(
  split: { stable: string; volatile: string },
  opts?: { singleSystem?: boolean; includeVolatile?: boolean },
): Array<{ role: 'system'; content: string }> {
  const stable = split.stable.trim();
  const volatile = opts?.includeVolatile ? split.volatile.trim() : '';
  if (!stable && !volatile) return [];
  if (opts?.singleSystem) {
    const content = [stable, volatile].filter(Boolean).join('\n\n---\n\n');
    return content ? [{ role: 'system', content }] : [];
  }
  const msgs: Array<{ role: 'system'; content: string }> = [];
  if (stable) msgs.push({ role: 'system', content: stable });
  if (volatile) msgs.push({ role: 'system', content: volatile });
  return msgs;
}
