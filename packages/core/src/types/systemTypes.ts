/**
 * Types & interfaces for the AI System Prompt Framework, Skills and Tools system.
 *
 * These types support:
 *  - Modular system prompt assembly (SystemPromptModule)
 *  - Skills (packages of capability) assignable to agents (SkillDefinition)
 *  - Enhanced tools with typed parameters (EnhancedToolDefinition / ToolParameter)
 *  - Persistable AI configuration (SystemPromptConfig / AgentSkillConfig)
 *
 * NOTE: The authoritative `ToolContext` lives in `src/agents/tools.ts`. We import
 * it here as a type-only import to avoid a runtime circular dependency (type
 * imports are erased at compile time).
 */
import type { ToolContext } from '../agents/tools.js';

/** High-level category a skill belongs to. */
export type SkillCategory =
  | 'vault'
  | 'project'
  | 'ideas'
  | 'search'
  | 'analysis'
  | 'mindmap'
  | 'writing'
  | 'custom';

/** A single typed parameter for an enhanced tool. */
export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'object';
  description: string;
  required: boolean;
  default?: unknown;
  /** enum of allowed values, when applicable */
  enum?: string[];
}

/**
 * Enhanced tool definition: a superset of the legacy ToolDefinition that adds
 * typed parameters, a category, and a confirmation flag.
 */
export interface EnhancedToolDefinition {
  name: string;
  description: string;
  /** human readable category, mirrors SkillCategory where relevant */
  category: SkillCategory | 'core' | 'custom' | 'mcp';
  /** typed parameter schema, used to build the prompt and to validate args */
  parameters: ToolParameter[] | { type: 'object'; properties: Record<string, unknown>; required: string[] };
  /** whether executing this tool requires user confirmation */
  requiresConfirmation?: boolean;
  /** Returns a string (sync) or a Promise<string> (async). Callers await the
   *  result via `executeTool` which is itself async. */
  execute: (
    args: Record<string, unknown>,
    context: ToolContext
  ) => string | Promise<string>;
}

/** Module type for the modular system prompt framework. */
export type PromptModuleType =
  | 'base-identity'
  | 'behavior-rules'
  | 'safety-guardrails'
  | 'context-sharing-rules'
  | 'output-formatting'
  | 'tool-usage-guidelines'
  | 'custom';

/** A modular fragment of the system prompt. */
export interface SystemPromptModule {
  type: PromptModuleType;
  /** human readable title shown in the UI */
  title: string;
  content: string;
  /** lower number = earlier in the assembled prompt */
  priority: number;
  /** optional: only include this module for agents whose skills match the predicate */
  conditional?: (skills: SkillDefinition[]) => boolean;
}

/** A skill (package of capability) assignable to one or more agents. */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  /** text injected into the agent's system prompt when the skill is enabled */
  systemPromptFragment: string;
  /** tool names this skill requires to function */
  requiredTools: string[];
  /** whether the skill is enabled by default for new agents */
  enabledByDefault: boolean;
  /** accent color for UI badges */
  color?: string;
  /** builtin skills cannot be deleted, only disabled */
  builtin?: boolean;
}

/**
 * Per-agent skill configuration: which skills an agent has enabled.
 * Stored as part of the AI configuration.
 */
export interface AgentSkillConfig {
  agentId: string;
  /** skill IDs explicitly enabled for this agent (overrides defaults) */
  enabledSkillIds: string[];
}

/**
 * The full persistable configuration of the AI system.
 */
export interface SystemPromptConfig {
  /** skill IDs enabled globally (acts as a master switch per skill) */
  enabledSkills: string[];
  /** tool IDs enabled globally (acts as a master switch per tool) */
  enabledTools: string[];
  /** custom prompt modules authored by the user */
  customPromptModules: SystemPromptModule[];
  /** per-agent skill overrides */
  agentSkillConfigs: AgentSkillConfig[];
  /** user-defined skills (prompt fragments + required tools) */
  customSkills?: Array<{
    id: string;
    name: string;
    description: string;
    systemPromptFragment: string;
    requiredTools: string[];
    enabled: boolean;
    autoAttachTo?: string[];
  }>;
}

/** Default empty AI configuration. */
export function createDefaultSystemPromptConfig(): SystemPromptConfig {
  return {
    enabledSkills: [],
    enabledTools: [],
    customPromptModules: [],
    agentSkillConfigs: [],
  };
}

// Re-export the authoritative ToolContext so consumers can import it
// alongside the other system types.
export type { ToolContext };

