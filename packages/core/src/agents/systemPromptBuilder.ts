import type {
  EnhancedToolDefinition,
  SkillDefinition,
  SystemPromptModule,
  SystemPromptConfig,
} from '../types/systemTypes';
import type { AgentRole as CoreAgentRole } from '../types';
import { getBasePromptModules } from './promptModules';
import { resolveAgentSkills, getSkillById } from './skills';

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
  customSkills?: import('../types').CustomSkill[]
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

/**
 * Build the full system prompt for an agent.
 */
export function buildSystemPrompt(
  agent: CoreAgentRole & { skills?: string[] },
  options: {
    tools: EnhancedToolDefinition[];
    toolNames: string[];
    aiConfig?: SystemPromptConfig;
    workspaceContext?: string;
    ragContext?: string;
  }
): string {
  const { tools, toolNames, aiConfig, workspaceContext, ragContext } = options;
  const registry = new Map(tools.map((t) => [t.name, t]));

  // 1. Base modules (filtered by conditional predicates against the agent's skills)
  const skills = computeAgentSkills(agent, aiConfig);
  const baseModules = getBasePromptModules().filter(
    (m) => !m.conditional || m.conditional(skills)
  );

  // 2. Custom user modules (always last, after base)
  const customModules: SystemPromptModule[] = (aiConfig?.customPromptModules ?? []).map((m) => ({
    ...m,
    priority: 1000 + m.priority,
  }));

  const allModules = [...baseModules, ...customModules].sort((a, b) => a.priority - b.priority);

  const parts: string[] = [];
  for (const mod of allModules) {
    parts.push(mod.content);
  }

  // 3. Agent's inline role prompt (role-specific persona)
  if (agent.systemPrompt && agent.systemPrompt.trim()) {
    parts.push(`# Your Role\n\n${agent.systemPrompt}`);
  }

  // 4. Skill prompt fragments
  if (skills.length > 0) {
    parts.push(
      `# Active Skills\n\n` +
        skills.map((s) => `## ${s.name}\n${s.systemPromptFragment}`).join('\n\n')
    );
  }

  // 5. Tool documentation
  const toolBlock = getToolDescriptions(toolNames, registry);
  if (toolNames.length > 0) {
    parts.push(`# Tools\n\n${toolBlock}`);
  }

  // 6. Context
  if (workspaceContext && workspaceContext.trim()) {
    parts.push(`# Current Workspace State\n\n${workspaceContext}`);
  }
  if (ragContext && ragContext.trim()) {
    parts.push(`# Retrieved Knowledge (RAG)\n\n${ragContext}`);
  }

  return parts.join('\n\n---\n\n');
}
