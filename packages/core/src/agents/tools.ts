import type { Task, Idea, Phase, SubTask, KnowledgeDocument, Milestone } from '../types';
import type { EnhancedToolDefinition } from '../types/systemTypes';
import { VAULT_TOOL_DEFINITIONS } from './vaultTools';
import { ADVANCED_TOOL_DEFINITIONS } from './advancedTools';

export interface ToolDefinition {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>, context: ToolContext) => string | Promise<string>;
}

export interface ToolContext {
  workspaceId: string;
  addTask: (task: Omit<Task, 'id' | 'createdAt'>) => void;
  addIdea: (idea: Omit<Idea, 'id' | 'workspaceId' | 'createdAt'>) => void;
  addPhase: (phase: Omit<Phase, 'id'>) => void;
  updateMindMap: (action: string, payload: Record<string, unknown>) => void;
  addActivity: (type: string, action: string, title: string) => void;
  addDocument?: (
    draft: Omit<KnowledgeDocument, 'id' | 'createdAt' | 'updatedAt'>,
  ) => KnowledgeDocument;
  updateDocument?: (id: string, updates: Partial<KnowledgeDocument>) => void;
  searchDocuments?: (query?: string) => KnowledgeDocument[];
  linkDocuments?: (sourceId: string, targetPathOrTitle: string, alias?: string) => void;
  getDocumentBacklinks?: (id: string) => KnowledgeDocument[];
  /** RAG hybrid retrieval — returns scored chunks. */
  ragQuery?: (query: string, topK?: number) => { title: string; content: string; score: number }[];
  /** Add a single node to the active mind map. */
  createMindMapNode?: (node: { label: string; content: string }) => void;
  /** Create a project milestone. */
  createMilestone?: (milestone: Omit<Milestone, 'id' | 'completed'>) => void;
  /** Update an existing task. */
  updateTask?: (taskId: string, updates: Partial<Task>) => void;
  /** Cluster a set of ideas under a named group. */
  clusterIdeas?: (ideaIds: string[], clusterName: string, color: string) => void;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'createTask',
    description: 'Create a new task in the project planner',
    execute: (args, ctx) => {
      ctx.addTask({
        phaseId: (args['phaseId'] as string) ?? undefined,
        parentId: (args['parentId'] as string) ?? undefined,
        title: (args['title'] as string) ?? 'New Task',
        description: (args['description'] as string) ?? '',
        status: 'todo',
        priority: (args['priority'] as Task['priority']) ?? 'medium',
        tags: (args['tags'] as string[]) ?? [],
        dependsOn: [],
        subtasks: ((args['subtasks'] as string[]) ?? []).map(
          (s: string): SubTask => ({ id: crypto.randomUUID().slice(0, 8), title: s, done: false })
        ),
      });
      ctx.addActivity('task', 'created', (args['title'] as string) ?? 'New Task');
      return `Task "${args['title']}" created successfully.`;
    },
  },
  {
    name: 'addIdea',
    description: 'Add a new idea to the idea generator',
    execute: (args, ctx) => {
      ctx.addIdea({
        title: (args['title'] as string) ?? 'New Idea',
        content: (args['content'] as string) ?? '',
        tags: (args['tags'] as string[]) ?? [],
        category: (args['category'] as string) ?? 'General',
      });
      ctx.addActivity('idea', 'created', (args['title'] as string) ?? 'New Idea');
      return `Idea "${args['title']}" added successfully.`;
    },
  },
  {
    name: 'createPhase',
    description: 'Create a new project phase',
    execute: (args, ctx) => {
      ctx.addPhase({
        name: (args['name'] as string) ?? 'New Phase',
        description: (args['description'] as string) ?? '',
        order: (args['order'] as number) ?? 0,
        color: (args['color'] as string) ?? '#3b82f6',
        progress: 0,
      });
      ctx.addActivity('project', 'phase created', (args['name'] as string) ?? 'New Phase');
      return `Phase "${args['name']}" created.`;
    },
  },
  {
    name: 'buildMindMap',
    description: 'Generate or update the mind map',
    execute: (args, ctx) => {
      ctx.updateMindMap('build', args);
      ctx.addActivity('mindmap', 'generated', 'Mind map updated');
      return 'Mind map structure generated. Apply it in the Mind Map view.';
    },
  },
  {
    name: 'addNode',
    description: 'Add a node to the mind map',
    execute: (args, ctx) => {
      ctx.updateMindMap('addNode', args);
      return `Node "${args['label']}" added to mind map.`;
    },
  },
  {
    name: 'linkNodes',
    description: 'Link two nodes in the mind map',
    execute: (args, ctx) => {
      ctx.updateMindMap('link', args);
      return `Nodes linked: ${args['source']} → ${args['target']}`;
    },
  },
  {
    name: 'createDocument',
    description: 'Create a new markdown document in the knowledge vault',
    execute: (args, ctx) => {
      if (!ctx.addDocument) return 'Knowledge vault tool not available.';
      const title = (args['title'] as string) || 'New Document';
      const path = (args['path'] as string) || `notes/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const content = (args['content'] as string) || '';
      const tags = (args['tags'] as string[]) || [];

      ctx.addDocument({
        path,
        title,
        content,
        format: 'markdown',
        tags,
        frontmatter: {},
        workspaceId: ctx.workspaceId,
      });
      ctx.addActivity('vault', 'created document', title);
      return `Document "${title}" created at "${path}".`;
    },
  },
];

/**
 * Unified tool registry: core + vault + advanced tools.
 *
 * The vault version of `createDocument` (richer parameter schema) takes
 * precedence over the legacy core stub, so we dedupe by name. This single
 * registry is the source of truth for tool execution, validation and prompt
 * documentation.
 *
 * The registry is MUTABLE: `registerCustomTool` adds user-defined tools
 * (custom skills / MCP servers) at runtime. The `TOOL_BY_NAME` map is rebuilt
 * lazily after each registration.
 */

/** Core planner/mindmap tools adapted for the enhanced tool registry. */
const CORE_TOOL_DEFINITIONS: EnhancedToolDefinition[] = TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  category: 'core',
  parameters: [],
  execute: tool.execute,
}));

/** Initial builtin registry (computed once). */
function buildBuiltinRegistry(): EnhancedToolDefinition[] {
  const seen = new Set<string>();
  const merged: EnhancedToolDefinition[] = [];
  for (const tool of [...VAULT_TOOL_DEFINITIONS, ...ADVANCED_TOOL_DEFINITIONS, ...CORE_TOOL_DEFINITIONS]) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    merged.push(tool);
  }
  return merged;
}

let _allTools: EnhancedToolDefinition[] = buildBuiltinRegistry();
let _toolByName: Map<string, EnhancedToolDefinition> = new Map(_allTools.map((t) => [t.name, t]));
let _validToolNames: Set<string> = new Set(_toolByName.keys());

/** Workspace stubs registered by the CLI (Phase 4 wiring). */
let _workspaceStubs: EnhancedToolDefinition[] = [];

function rebuildIndex() {
  _toolByName = new Map([..._allTools, ..._workspaceStubs].map((t) => [t.name, t]));
  _validToolNames = new Set(_toolByName.keys());
}

/** Register workspace stubs (CLI-only). Replaces any previous set. */
export function setWorkspaceStubs(stubs: EnhancedToolDefinition[]): void {
  _workspaceStubs = stubs;
  rebuildIndex();
}

/** Read-only snapshot of the current registry (always a fresh array). */
export function getAllTools(): EnhancedToolDefinition[] {
  return [..._allTools, ..._workspaceStubs];
}

/** Register a custom tool (user-defined or MCP-discovered). If a tool with
 *  the same name already exists, it is replaced. */
export function registerCustomTool(def: EnhancedToolDefinition): void {
  const idx = _allTools.findIndex((t) => t.name === def.name);
  if (idx >= 0) _allTools[idx] = def;
  else _allTools.push(def);
  rebuildIndex();
}

/** Remove a custom tool by name. No-op if not present. */
export function unregisterCustomTool(name: string): void {
  const idx = _allTools.findIndex((t) => t.name === name);
  if (idx < 0) return;
  _allTools.splice(idx, 1);
  rebuildIndex();
}

/** Wipe ALL custom tools (used on app boot before re-registering active ones). */
export function clearCustomTools(): void {
  _allTools = buildBuiltinRegistry();
  rebuildIndex();
}

/** Backwards-compat: keeps ALL_TOOLS as a live reference for legacy imports. */
export const ALL_TOOLS: readonly EnhancedToolDefinition[] = new Proxy([], {
  get: (_target, prop) => {
    // Support `ALL_TOOLS.length`, `.filter`, `.map`, `.find` by deferring to the live array.
    return Reflect.get(_allTools, prop);
  },
}) as EnhancedToolDefinition[];

export function isValidTool(name: string): boolean {
  return _validToolNames.has(name);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<string | null> {
  const tool = _toolByName.get(name);
  if (!tool) return null;
  const safeArgs = args && typeof args === 'object' ? args : {};
  try {
    const result = tool.execute(safeArgs, context);
    return await Promise.resolve(result);
  } catch (err) {
    return `Tool "${name}" failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
}

/** Resolve a list of tool names to their definitions (skipping unknown ones). */
export function getAvailableTools(toolNames: string[]): EnhancedToolDefinition[] {
  return toolNames
    .map((name) => _toolByName.get(name))
    .filter((t): t is EnhancedToolDefinition => t !== undefined);
}
