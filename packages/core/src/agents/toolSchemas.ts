/**
 * OpenAI-compatible tool schemas for native function calling.
 *
 * These describe the 13 tools to the LLM providers (GLM/Z.AI and MiniMax) so
 * the model can decide structurally — via `response.tool_calls` — when to
 * invoke a tool, rather than emitting textual markers the client must parse.
 *
 * The descriptions are kept in sync with the unified `ALL_TOOLS` registry (the
 * execution side) in `agents/tools.ts`. Names MUST match across the two
 * modules; if a tool appears in the registry but has no schema here,
 * `getProviderTools` will throw at build time (defensive).
 */

import { getAllTools, registerCustomTool } from './tools.js';

/** OpenAI-style tool descriptor accepted by both GLM and MiniMax. */
export interface ProviderTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

/** A tool call as riassemblato dal main process dallo stream SSE. */
export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * JSON Schema for each BUILTIN tool's parameters. Keyed by tool name. Custom
 * tools (registered via `registerCustomTool`) carry their own JSON Schema
 * inline (via `EnhancedToolDefinition.parameters`) and do not need an entry
 * here.
 *
 * If a builtin tool appears here but is missing from the registry, this map
 * is silently ignored. If a builtin tool appears in the registry but has no
 * entry here, `getProviderTools` warns at runtime (defensive — registration
 * ordering and missing entries used to be a build-time throw).
 */
const PARAM_SCHEMAS: Record<string, object> = {
  createPlan: {
    type: 'object',
    properties: {
      phases: {
        type: 'array',
        description: 'Ordered list of plan phases, each with its tasks nested (aim for 3 tasks per phase)',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Phase name' },
            description: { type: 'string', description: 'What this phase delivers and its exit criterion' },
            order: { type: 'number', description: 'Position of the phase in the plan (1-based)' },
            color: { type: 'string', description: 'Hex color, e.g. "#3b82f6"' },
            tasks: {
              type: 'array',
              description: 'Concrete tasks for this phase',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Concise verb-led task title' },
                  description: { type: 'string', description: '2-3 sentences of context' },
                  fileRefs: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File paths with line ranges, e.g. "src/App.tsx:L10-L40"',
                  },
                  acceptance: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Concrete, testable acceptance criteria',
                  },
                  qaScenario: { type: 'string', description: 'Step-by-step manual QA scenario' },
                  priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                },
                required: ['title'],
              },
            },
          },
          required: ['name'],
        },
      },
      milestone: {
        type: 'object',
        description: 'The milestone this plan ships (e.g. the design-complete milestone)',
        properties: {
          title: { type: 'string', description: 'Milestone title' },
          description: { type: 'string', description: 'Milestone description' },
          targetVersion: { type: 'string', description: 'Target version, e.g. "v0.1.0"' },
          dueDate: { type: 'string', description: 'Due date (ISO string)' },
        },
        required: ['title'],
      },
    },
    required: ['phases'],
  },
  createTask: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short task title' },
      description: { type: 'string', description: 'Detailed task description' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      phaseId: { type: 'string', description: 'ID of the phase this task belongs to' },
      parentId: { type: 'string', description: 'ID of the parent task, if nested' },
      fileRefs: {
        type: 'array',
        items: { type: 'string' },
        description: 'File paths with line ranges where the work lands, e.g. "src/App.tsx:L10-L40"',
      },
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete, testable acceptance criteria',
      },
      qaScenario: { type: 'string', description: 'Step-by-step manual QA scenario' },
      tags: { type: 'array', items: { type: 'string' } },
      subtasks: { type: 'array', items: { type: 'string' }, description: 'Subtask titles' },
    },
    required: ['title'],
  },
  addIdea: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string', description: 'Full idea description' },
      tags: { type: 'array', items: { type: 'string' } },
      category: { type: 'string', description: 'e.g. "Product", "Research", "General"' },
    },
    required: ['title'],
  },
  createPhase: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      order: { type: 'number', description: 'Position of the phase in the plan' },
      color: { type: 'string', description: 'Hex color, e.g. "#3b82f6"' },
    },
    required: ['name'],
  },
  buildMindMap: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Central topic of the mind map' },
      nodes: {
        type: 'array',
        description: 'Nodes to populate the map with',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['label'],
        },
      },
    },
    required: ['topic'],
  },
  addNode: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['label'],
  },
  linkNodes: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Label or id of the source node' },
      target: { type: 'string', description: 'Label or id of the target node' },
    },
    required: ['source', 'target'],
  },
  createDocument: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title of the document' },
      content: { type: 'string', description: 'Content of the document (markdown)' },
      path: { type: 'string', description: 'Optional stabilized path, e.g. "notes/my-topic"' },
      tags: { type: 'array', items: { type: 'string' } },
      category: { type: 'string', description: 'Document category' },
    },
    required: ['title', 'content'],
  },
  createNfrSpec: {
    type: 'object',
    properties: {
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files the NFR constraints apply to, e.g. ["index.html"]',
      },
      compositorOnly: {
        type: 'boolean',
        description: 'Animations must use only compositor properties (transform/opacity). Default true.',
      },
      forbidLayoutProps: {
        type: 'boolean',
        description: 'Forbid animating layout properties (width/height/top/left/grid-template-rows). Default true.',
      },
      inlineJsMaxBytes: {
        type: 'number',
        description: 'Max size in bytes for the first inline <script> block. Default 5120.',
      },
      planFeatureKeywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Feature keywords the target file must contain (plan-vs-reality check).',
      },
    },
    required: [],
  },
  updateDocument: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Document id to update' },
      content: { type: 'string', description: 'New markdown content' },
      title: { type: 'string', description: 'New title' },
      tags: { type: 'array', items: { type: 'string' }, description: 'New tag list (replaces existing)' },
      category: { type: 'string', description: 'New category' },
    },
    required: ['id'],
  },
  searchDocuments: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text search query' },
      tag: { type: 'string', description: 'Filter by tag' },
      category: { type: 'string', description: 'Filter by category' },
      limit: { type: 'number', description: 'Max results' },
    },
    required: [],
  },
  linkDocuments: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source document id' },
      targetPathOrTitle: { type: 'string', description: 'Target document path or title' },
      alias: { type: 'string', description: 'Optional display alias' },
    },
    required: ['sourceId', 'targetPathOrTitle'],
  },
  getDocumentBacklinks: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Target document id' },
    },
    required: ['id'],
  },
  searchRAG: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query' },
      topK: { type: 'number', description: 'Number of results to return' },
    },
    required: ['query'],
  },
  createMindMapNode: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'Node label' },
      content: { type: 'string', description: 'Short node content/description' },
    },
    required: ['label'],
  },
  createMilestone: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Milestone title' },
      description: { type: 'string', description: 'Milestone description' },
      targetVersion: { type: 'string', description: 'Target version this milestone ships, e.g. "v0.1.0"' },
      dueDate: { type: 'string', description: 'Due date (ISO string)' },
    },
    required: ['title'],
  },
  updateTask: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task id to update' },
      status: { type: 'string', enum: ['todo', 'in-progress', 'done', 'blocked'] },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      description: { type: 'string', description: 'New description' },
    },
    required: ['taskId'],
  },
  clusterIdeas: {
    type: 'object',
    properties: {
      ideaIds: { type: 'array', items: { type: 'string' }, description: 'Idea ids to cluster' },
      clusterName: { type: 'string', description: 'Name for the new cluster' },
      color: { type: 'string', description: 'Cluster color (hex)' },
    },
    required: ['ideaIds', 'clusterName'],
  },
};

/** Build a JSON Schema for a custom tool from its declared parameters. */
function buildCustomParameters(tool: { parameters: { type: string; properties: Record<string, { type: string; description?: string; enum?: string[] }>; required: string[] } }): object {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tool.parameters.properties)) {
    const prop: Record<string, unknown> = { type: v.type };
    if (v.description) prop['description'] = v.description;
    if (v.enum) prop['enum'] = v.enum;
    properties[k] = prop;
  }
  return {
    type: tool.parameters.type,
    properties,
    required: tool.parameters.required,
  };
}

/**
 * Builds the OpenAI-style tool list from the current tool registry (read at
 * call time, so it always reflects the latest custom registrations).
 *
 * @param toolNames Optional allow-list. When provided, only tools whose name
 *   appears in the list are returned — used to grant per-agent tool access.
 *   When omitted, all registered tools are returned.
 */
export function getProviderTools(toolNames?: string[]): ProviderTool[] {
  const all = getAllTools();
  const source = toolNames && toolNames.length > 0
    ? all.filter((t) => toolNames.includes(t.name))
    : all;

  const result: ProviderTool[] = [];
  for (const t of source) {
    const builtinSchema = PARAM_SCHEMAS[t.name];
    const customParams = (t as { parameters?: unknown }).parameters;
    const parameters =
      builtinSchema ||
      (customParams &&
      typeof customParams === "object" &&
      !Array.isArray(customParams)
        ? (customParams as object)
        : null);
    if (!parameters) {
      // Custom tool with no schema declared: skip (defensive — never reach LLM
      // with an undocumented function call).
      // eslint-disable-next-line no-console
      console.warn(`[toolSchemas] tool "${t.name}" has no JSON Schema; skipping.`);
      continue;
    }
    result.push({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters,
      },
    });
  }
  return result;
}

/** Build parameters schema from a custom tool's declared params. Exported
 *  for callers that want to register a custom tool + its schema in one go. */
export { buildCustomParameters };

/** Re-export for callers that want to register custom tools at runtime. */
export { registerCustomTool };
