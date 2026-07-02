import type { EnhancedToolDefinition, ToolParameter } from '../types/systemTypes.js';
import type { Task } from '../types/index.js';

/** Helper to build a ToolParameter concisely. */
function p(
  name: string,
  type: ToolParameter['type'],
  description: string,
  required: boolean,
  extra?: Partial<ToolParameter>
): ToolParameter {
  return { name, type, description, required, ...extra };
}

/**
 * Advanced tools: RAG search, mind-map node creation, milestones, task updates
 * and idea clustering.
 */
export const ADVANCED_TOOL_DEFINITIONS: EnhancedToolDefinition[] = [
  {
    name: 'searchRAG',
    description: 'Query the hybrid RAG knowledge base and return the most relevant chunks.',
    category: 'analysis',
    parameters: [
      p('query', 'string', 'Natural-language query', true),
      p('topK', 'number', 'Number of results to return', false, { default: 6 }),
    ],
    execute: (args, ctx) => {
      if (!ctx.ragQuery) return 'RAG search not available in this context.';
      const query = (args['query'] as string) ?? '';
      const topK = (args['topK'] as number) ?? 6;
      const results = ctx.ragQuery(query, topK);
      if (results.length === 0) return 'No relevant knowledge found in RAG index.';
      return results
        .map((r, i) => `${i + 1}. ${r.title} (score: ${r.score.toFixed(2)})\n   ${r.content.slice(0, 160)}`)
        .join('\n');
    },
  },
  {
    name: 'createMindMapNode',
    description: 'Add a single node to the current mind map.',
    category: 'mindmap',
    parameters: [
      p('label', 'string', 'Node label', true),
      p('content', 'string', 'Short node content/description', false),
    ],
    execute: (args, ctx) => {
      if (!ctx.createMindMapNode) return 'Mind map not available in this context.';
      ctx.createMindMapNode({
        label: (args['label'] as string) ?? 'Node',
        content: (args['content'] as string) ?? '',
      });
      return `Mind map node "${args['label']}" added.`;
    },
  },
  {
    name: 'createMilestone',
    description: 'Create a milestone in the active project.',
    category: 'project',
    parameters: [
      p('title', 'string', 'Milestone title', true),
      p('description', 'string', 'Milestone description', false),
      p('dueDate', 'string', 'Due date (ISO string)', false),
    ],
    execute: (args, ctx) => {
      if (!ctx.createMilestone) return 'Project milestones not available in this context.';
      ctx.createMilestone({
        title: (args['title'] as string) ?? 'Milestone',
        description: (args['description'] as string) ?? '',
        dueDate: args['dueDate'] as string | undefined,
      });
      ctx.addActivity('project', 'milestone created', (args['title'] as string) ?? 'Milestone');
      return `Milestone "${args['title']}" created.`;
    },
  },
  {
    name: 'updateTask',
    description: 'Update an existing task (status, priority, description).',
    category: 'project',
    parameters: [
      p('taskId', 'string', 'Task id to update', true),
      p('status', 'string', 'New status', false, { enum: ['todo', 'in-progress', 'done', 'blocked'] }),
      p('priority', 'string', 'New priority', false, { enum: ['low', 'medium', 'high', 'critical'] }),
      p('description', 'string', 'New description', false),
    ],
    execute: (args, ctx) => {
      if (!ctx.updateTask) return 'Task updates not available in this context.';
      const taskId = (args['taskId'] as string) ?? '';
      const updates: Record<string, unknown> = {};
      if (args['status'] !== undefined) updates.status = args['status'];
      if (args['priority'] !== undefined) updates.priority = args['priority'];
      if (args['description'] !== undefined) updates.description = args['description'];
      ctx.updateTask(taskId, updates as Partial<Task>);
      return `Task ${taskId} updated.`;
    },
  },
  {
    name: 'clusterIdeas',
    description: 'Group ideas by similarity into a named cluster.',
    category: 'ideas',
    parameters: [
      p('ideaIds', 'string[]', 'Idea ids to cluster', true),
      p('clusterName', 'string', 'Name for the new cluster', true),
      p('color', 'string', 'Cluster color (hex)', false, { default: '#3b82f6' }),
    ],
    execute: (args, ctx) => {
      if (!ctx.clusterIdeas) return 'Idea clustering not available in this context.';
      const ideaIds = (args['ideaIds'] as string[]) ?? [];
      const clusterName = (args['clusterName'] as string) ?? 'Cluster';
      const color = (args['color'] as string) ?? '#3b82f6';
      ctx.clusterIdeas(ideaIds, clusterName, color);
      return `Clustered ${ideaIds.length} ideas into "${clusterName}".`;
    },
  },
];
