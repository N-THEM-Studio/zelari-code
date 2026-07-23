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
  for (const name of toolNames) {
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
  // the builtin. Backward-compatible: today no caller ships a duplicate type,
  // so existing append behavior is preserved for non-colliding types.
  const customModulesRaw = aiConfig?.customPromptModules ?? [];
  const customTypes = new Set(customModulesRaw.map((m) => m.type));
  const baseNotOverridden = baseModules.filter((m) => !customTypes.has(m.type));
  const customModules: SystemPromptModule[] = customModulesRaw.map((m) => ({
    ...m,
    priority: 1000 + m.priority,
  }));

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
 * Assemble AgentMessage system slots from a split prompt.
 * Multi-system when both parts present (stable first — required for prefix cache).
 * Set `singleSystem: true` to concatenate for providers that reject multi-system.
 */
export function systemMessagesFromSplit(
  split: { stable: string; volatile: string },
  opts?: { singleSystem?: boolean },
): Array<{ role: 'system'; content: string }> {
  const stable = split.stable.trim();
  const volatile = split.volatile.trim();
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
