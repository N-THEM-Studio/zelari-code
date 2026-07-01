import type { SkillDefinition, SkillCategory } from '../types/systemTypes';

/** Extended skill definition with optional metadata for the new registry. */
export interface SkillMetadata extends SkillDefinition {
  /** Semver version (defaults to '1.0.0' for existing skills). */
  version?: string;
  /** Tags for discovery (e.g. 'coding', 'debug', 'refactor'). */
  tags?: string[];
  /** Related skill IDs (for cross-references in docs/cookbook). */
  relatedSkills?: string[];
}

/** Coding-oriented skill categories. Distinct from knowledge-worker categories
 *  (vault, project, ideas, etc.). Used by /skill <name> autocomplete and the
 *  skill cookbook docs. */
export type CodingCategory =
  | 'planning'   // architect-feature, ADR, scope-check, migrate-stack
  | 'refactor'   // monolith split, extract reusable, simplify conditionals
  | 'debug'      // debug-with-rag, reproduce-bug, root-cause-5-whys
  | 'review'     // code-review, security, performance, test-coverage
  | 'test'       // unit-tests, integration-tests, regression-test
  | 'docs'       // README, TSDoc, changelog
  | 'ops'        // commit-message, PR-description, CI-pipeline
  | 'git'        // git status/diff/log/commit (deferred to Task 12.6+)
  | 'db'         // schema-migration, query-optimization (deferred)
  | 'maint';     // tech-debt-audit, dead-code-removal (deferred)

export const CODING_CATEGORY = {
  PLANNING: 'planning',
  REFACTOR: 'refactor',
  DEBUG: 'debug',
  REVIEW: 'review',
  TEST: 'test',
  DOCS: 'docs',
  OPS: 'ops',
  GIT: 'git',
  DB: 'db',
  MAINT: 'maint',
} as const;

/** Cost estimate for invoking a skill — drives budget awareness. */
export type SkillCost = 'low' | 'medium' | 'high';

/**
 * Senior-grade skill definition for coding-oriented skills. ALL fields below
 * are REQUIRED (no `?`). This is the discipline: every coding skill must
 * declare triggers, antiPatterns, examples, etc.
 *
 * Skills on the simpler SkillMetadata shape (the 6 knowledge-worker skills)
 * stay on the old shape. CodingSkillDefinition is reserved for the 23
 * coding skills being added in Task 13.4.
 */
export interface CodingSkillDefinition extends Omit<SkillMetadata, 'category'> {
  /** Strict semver (e.g. '1.0.0', '1.2.3'). */
  version: string;
  /** Coding category (drives taxonomy + autocomplete). */
  category: CodingCategory;
  /** Other skill IDs this skill depends on (composition). */
  requires: string[];
  /** Concrete I/O examples for clarity (at least 1 recommended). */
  examples: Array<{
    input: string;
    output: unknown;
  }>;
  /** Task patterns where this skill is naturally invoked. */
  triggers: string[];
  /** Task patterns where this skill should NOT be invoked. */
  antiPatterns: string[];
  /** Council member IDs required to run this skill. */
  requiredRoles: string[];
  /** Budget estimate. 'high' = 2-5x single-LLM API cost (council-driven). */
  estimatedCost: SkillCost;
  /** Output schema as TS type signature (e.g. '{ goal: string; alternatives: Array<...> }'). */
  outputSchema: string;
  /** Related skill IDs (cross-references for discovery in cookbook). */
  relatedSkills: string[];
  /** Tags for search/discovery (e.g. ['code-review', 'multi-role']). */
  tags: string[];
}

/**
 * Skill catalog — packages of capability assignable to agents.
 *
 * Each skill injects a systemPromptFragment into the agent's prompt and
 * declares the tools it requires.
 */
export const SKILL_CATALOG: SkillMetadata[] = [
  {
    id: 'vault-manager',
    version: '1.0.0',
    tags: ['knowledge', 'vault', 'notes'],
    relatedSkills: ['document-writer'],
    name: 'Vault Manager',
    description: 'Create, edit, search and link markdown documents in the Knowledge Vault using [[wikilinks]], #tags and YAML frontmatter.',
    category: 'vault',
    color: '#3b82f6',
    enabledByDefault: true,
    builtin: true,
    requiredTools: ['createDocument', 'updateDocument', 'searchDocuments', 'linkDocuments'],
    systemPromptFragment: `You can manage the Knowledge Vault directly.
- Documents are markdown files with a path (e.g. "notes/architecture"), title, content, tags, and optional category.
- Connect documents with [[wikilinks]]: write [[target]] or [[target|alias]] inside the content.
- Add #hashtags anywhere in the content to tag a document.
- Optional YAML frontmatter may precede the body (key: value lines wrapped in ---).
- Prefer creating durable notes over answering in chat when the information is reusable.`,
  },
  {
    id: 'project-planner',
    version: '1.0.0',
    tags: ['planning', 'project', 'tasks'],
    relatedSkills: [],
    name: 'Project Planner',
    description: 'Structured project planning with phases, tasks, subtasks, dependencies and milestones.',
    category: 'project',
    color: '#10b981',
    enabledByDefault: true,
    builtin: true,
    requiredTools: ['createTask', 'createPhase', 'createMilestone', 'updateTask'],
    systemPromptFragment: `You plan projects hierarchically.
- Decompose work into phases, then tasks within phases.
- For each task include: title, description, priority (low|medium|high|critical), and optional tags/subtasks.
- Define milestones to mark key deliverables.
- When relevant, reference file paths and acceptance criteria.`,
  },
  {
    id: 'idea-synthesizer',
    version: '1.0.0',
    tags: ['ideation', 'creativity'],
    relatedSkills: [],
    name: 'Idea Synthesizer',
    description: 'Generate, cluster and evaluate creative ideas using divergent thinking.',
    category: 'ideas',
    color: '#f59e0b',
    enabledByDefault: true,
    builtin: true,
    requiredTools: ['addIdea', 'clusterIdeas'],
    systemPromptFragment: `You generate and organize ideas.
- Produce a diverse set of ideas, then cluster related ones.
- Tag ideas consistently and assign a category.
- Evaluate feasibility and novelty briefly.`,
  },
  {
    id: 'mind-mapper',
    version: '1.0.0',
    tags: ['knowledge', 'graph', 'visualization'],
    relatedSkills: [],
    name: 'Mind Mapper',
    description: 'Build structured mind maps (root → branches → leaves) and connect them to vault documents.',
    category: 'mindmap',
    color: '#06b6d4',
    enabledByDefault: false,
    builtin: true,
    requiredTools: ['buildMindMap', 'addNode', 'linkNodes', 'createMindMapNode'],
    systemPromptFragment: `You build mind maps as JSON structures.
- Root → branches → leaves.
- Each node has a label and short content.
- Use semantic colors and connect nodes that relate to vault documents.`,
  },
  {
    id: 'research-analyst',
    version: '1.0.0',
    tags: ['research', 'rag', 'analysis'],
    relatedSkills: [],
    name: 'Research Analyst',
    description: 'Query the RAG knowledge base, synthesize findings and cite sources.',
    category: 'analysis',
    color: '#a855f7',
    enabledByDefault: true,
    builtin: true,
    requiredTools: ['searchRAG', 'searchDocuments'],
    systemPromptFragment: `You research using the retrieval system.
- Use searchRAG / searchDocuments to find relevant prior knowledge before answering.
- Cite sources by title when you rely on retrieved content.
- Structure analyses with clear sections and a conclusion.`,
  },
  {
    id: 'document-writer',
    version: '1.0.0',
    tags: ['writing', 'documentation'],
    relatedSkills: [],
    name: 'Document Writer',
    description: 'Write high-quality technical or narrative documents into the vault.',
    category: 'writing',
    color: '#ec4899',
    enabledByDefault: false,
    builtin: true,
    requiredTools: ['createDocument', 'updateDocument'],
    systemPromptFragment: `You write polished documents.
- Choose an appropriate structure (guide, spec, reference, narrative).
- Maintain a consistent tone and voice.
- Use headings, lists, and code blocks where helpful; link related notes with [[wikilinks]].`,
  },
];

/** Default skill assignments per agent id. */
const DEFAULT_AGENT_SKILLS: Record<string, string[]> = {
  sisyphus: ['project-planner', 'research-analyst'],
  prometheus: ['project-planner', 'vault-manager'],
  hephaestus: ['idea-synthesizer', 'mind-mapper', 'document-writer'],
  atlas: ['mind-mapper', 'research-analyst'],
  oracle: ['research-analyst'],
  chairman: ['vault-manager', 'project-planner', 'idea-synthesizer'],
};

/** Get all skills in a given category. */
export function getSkillsByCategory(cat: SkillCategory): SkillDefinition[] {
  return SKILL_CATALOG.filter((s) => s.category === cat);
}

/** Get a skill by id. */
export function getSkillById(id: string): SkillDefinition | undefined {
  return SKILL_CATALOG.find((s) => s.id === id);
}

/**
 * Resolve the default skills for an agent.
 * Custom/user-defined agents default to an empty set (configured via UI).
 */
export function resolveAgentSkills(agentId: string): SkillDefinition[] {
  const ids = DEFAULT_AGENT_SKILLS[agentId] ?? [];
  return ids
    .map((id) => getSkillById(id))
    .filter((s): s is SkillDefinition => s !== undefined);
}

/** All builtin skill ids (useful for the settings UI). */
export function getBuiltinSkillIds(): string[] {
  return SKILL_CATALOG.filter((s) => s.builtin).map((s) => s.id);
}

/**
 * List all skills (built-in + custom). Returns a fresh array — safe to mutate.
 * Uses SkillMetadata type.
 */
export function listSkills(): SkillMetadata[] {
  return [...SKILL_CATALOG];
}

/**
 * Get a skill by ID, returned as SkillMetadata.
 * Returns undefined if not found.
 */
export function getSkillMetadata(id: string): SkillMetadata | undefined {
  return SKILL_CATALOG.find((s) => s.id === id);
}

/**
 * Register a custom skill (user-defined or MCP-discovered). If a skill
 * with the same id already exists, it is replaced.
 */
export function registerSkill(skill: SkillMetadata): void {
  const idx = SKILL_CATALOG.findIndex((s) => s.id === skill.id);
  if (idx >= 0) {
    SKILL_CATALOG[idx] = skill;
  } else {
    SKILL_CATALOG.push(skill);
  }
}

/**
 * Remove a skill by ID. Returns true if removed, false if not found.
 * Built-in skills (skill.builtin === true) cannot be removed.
 */
export function unregisterSkill(id: string): boolean {
  const skill = SKILL_CATALOG.find((s) => s.id === id);
  if (!skill) return false;
  if (skill.builtin) return false;
  const idx = SKILL_CATALOG.indexOf(skill);
  SKILL_CATALOG.splice(idx, 1);
  return true;
}

/**
 * Find all skills matching a tag (exact match).
 */
export function findSkillsByTag(tag: string): SkillMetadata[] {
  return SKILL_CATALOG.filter((s) => s.tags?.includes(tag));
}

/**
 * Find all skills matching any of the given IDs.
 * Unknown IDs are silently skipped.
 */
export function findSkillsByIds(ids: string[]): SkillMetadata[] {
  const idSet = new Set(ids);
  return SKILL_CATALOG.filter((s) => idSet.has(s.id));
}

/**
 * Resolve skill dependencies in topological order. Returns empty array
 * if a dependency is missing (caller should handle gracefully).
 */
export function resolveSkillDependencies(id: string): SkillMetadata[] {
  const start = SKILL_CATALOG.find((s) => s.id === id);
  if (!start) return [];
  // Skills currently have no 'requires' field, so topological sort is trivial.
  return [start];
}

/** Empty catalog of coding skills — populated by Task 13.4. */
export const CODING_SKILL_CATALOG: CodingSkillDefinition[] = [];

/** List all coding skills (fresh array). */
export function listCodingSkills(): CodingSkillDefinition[] {
  return [...CODING_SKILL_CATALOG];
}

/** Get a coding skill by id. */
export function getCodingSkillById(id: string): CodingSkillDefinition | undefined {
  return CODING_SKILL_CATALOG.find((s) => s.id === id);
}

/** Find all coding skills in a category. */
export function findCodingSkillsByCategory(category: CodingCategory): CodingSkillDefinition[] {
  return CODING_SKILL_CATALOG.filter((s) => s.category === category);
}

/** Find all coding skills matching a tag. */
export function findCodingSkillsByTag(tag: string): CodingSkillDefinition[] {
  return CODING_SKILL_CATALOG.filter((s) => s.tags.includes(tag));
}

/**
 * Validate that all `requires` references point to existing skill IDs.
 * Returns an array of error messages (empty = valid).
 *
 * Note: This is a runtime check. Compile-time validation requires the
 * TypeScript type to express the cross-reference; we use a manual
 * registration API that throws on invalid requires.
 */
export function validateCodingSkillRequires(skill: CodingSkillDefinition): string[] {
  const errors: string[] = [];
  for (const reqId of skill.requires) {
    if (!CODING_SKILL_CATALOG.some((s) => s.id === reqId)) {
      errors.push(`Skill "${skill.id}" requires unknown skill "${reqId}"`);
    }
  }
  return errors;
}

/** Register a coding skill (called by Task 13.4 when populating the catalog). */
export function registerCodingSkill(skill: CodingSkillDefinition): void {
  const errors = validateCodingSkillRequires(skill);
  if (errors.length > 0) {
    throw new Error(`Cannot register coding skill: ${errors.join('; ')}`);
  }
  const idx = CODING_SKILL_CATALOG.findIndex((s) => s.id === skill.id);
  if (idx >= 0) {
    CODING_SKILL_CATALOG[idx] = skill;
  } else {
    CODING_SKILL_CATALOG.push(skill);
  }
}



