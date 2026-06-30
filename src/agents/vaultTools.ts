import type { EnhancedToolDefinition, ToolParameter } from '../types/systemTypes';
import type { KnowledgeDocument } from '../types';

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

type KnowledgeFormat = 'markdown' | 'text' | 'json' | 'yaml' | 'html' | 'csv' | 'other';

/**
 * Knowledge Vault tools.
 *
 * These tools operate on KnowledgeDocuments via the ToolContext callbacks
 * (which are wired to the Zustand store).
 */
export const VAULT_TOOL_DEFINITIONS: EnhancedToolDefinition[] = [
  {
    name: 'createDocument',
    description: 'Create a new markdown document in the Knowledge Vault.',
    category: 'vault',
    parameters: [
      p('path', 'string', 'Document path (e.g. "notes/architecture"). Must be unique.', true),
      p('title', 'string', 'Document title', true),
      p('content', 'string', 'Markdown content. Use [[wikilinks]] and #hashtags.', false, { default: '' }),
      p('tags', 'string[]', 'Tag list', false, { default: [] }),
      p('category', 'string', 'Document category', false),
      p('format', 'string', 'Document format', false, { default: 'markdown', enum: ['markdown', 'text', 'json', 'yaml', 'html', 'csv'] }),
    ],
    execute: (args, ctx) => {
      if (!ctx.addDocument) return 'Vault not available in this context.';
      const doc = ctx.addDocument({
        path: (args['path'] as string) ?? '',
        title: (args['title'] as string) ?? 'Untitled',
        content: (args['content'] as string) ?? '',
        format: ((args['format'] as KnowledgeFormat) ?? 'markdown'),
        tags: (args['tags'] as string[]) ?? [],
        frontmatter: {},
        category: (args['category'] as string) ?? undefined,
        workspaceId: ctx.workspaceId,
      });
      ctx.addActivity('task', 'document created', doc.title);
      return `Document "${doc.title}" created at path "${doc.path}".`;
    },
  },
  {
    name: 'updateDocument',
    description: 'Update an existing Knowledge Vault document (by id).',
    category: 'vault',
    parameters: [
      p('id', 'string', 'Document id to update', true),
      p('content', 'string', 'New markdown content', false),
      p('title', 'string', 'New title', false),
      p('tags', 'string[]', 'New tag list (replaces existing)', false),
      p('category', 'string', 'New category', false),
    ],
    execute: (args, ctx) => {
      if (!ctx.updateDocument) return 'Vault not available in this context.';
      const id = (args['id'] as string) ?? '';
      const updates: Partial<KnowledgeDocument> = {};
      if (args['content'] !== undefined) updates.content = args['content'] as string;
      if (args['title'] !== undefined) updates.title = args['title'] as string;
      if (args['tags'] !== undefined) updates.tags = args['tags'] as string[];
      if (args['category'] !== undefined) updates.category = args['category'] as string;
      ctx.updateDocument(id, updates);
      return `Document ${id} updated.`;
    },
  },
  {
    name: 'searchDocuments',
    description: 'Search Knowledge Vault documents by free-text query, tag, or category.',
    category: 'vault',
    parameters: [
      p('query', 'string', 'Free-text search query', false),
      p('tag', 'string', 'Filter by tag', false),
      p('category', 'string', 'Filter by category', false),
      p('limit', 'number', 'Max results', false, { default: 10 }),
    ],
    execute: (args, ctx) => {
      if (!ctx.searchDocuments) return 'Vault search not available in this context.';
      const query = (args['query'] as string) ?? '';
      const tag = args['tag'] as string | undefined;
      const category = args['category'] as string | undefined;
      const limit = (args['limit'] as number) ?? 10;

      let results: KnowledgeDocument[] = ctx.searchDocuments(query);
      if (tag) results = results.filter((d) => (d.tags ?? []).includes(tag));
      if (category) results = results.filter((d) => d.category === category);
      results = results.slice(0, limit);

      if (results.length === 0) return 'No matching documents found.';
      return results
        .map((d) => `- ${d.title} (${d.path}) [${(d.tags ?? []).join(', ')}]`)
        .join('\n');
    },
  },
  {
    name: 'linkDocuments',
    description: 'Create a bidirectional wikilink between two documents by inserting [[target]] into the source.',
    category: 'vault',
    parameters: [
      p('sourceId', 'string', 'Source document id', true),
      p('targetPathOrTitle', 'string', 'Target document path or title', true),
      p('alias', 'string', 'Optional display alias', false),
    ],
    execute: (args, ctx) => {
      if (!ctx.linkDocuments) return 'Vault linking not available in this context.';
      const sourceId = (args['sourceId'] as string) ?? '';
      const target = (args['targetPathOrTitle'] as string) ?? '';
      const alias = args['alias'] as string | undefined;
      ctx.linkDocuments(sourceId, target, alias);
      return `Linked document ${sourceId} → ${target}${alias ? ` (alias: ${alias})` : ''}.`;
    },
  },
  {
    name: 'getDocumentBacklinks',
    description: 'Retrieve documents that link to a given document.',
    category: 'vault',
    parameters: [p('id', 'string', 'Target document id', true)],
    execute: (args, ctx) => {
      if (!ctx.getDocumentBacklinks) return 'Backlinks not available in this context.';
      const id = (args['id'] as string) ?? '';
      const backlinks = ctx.getDocumentBacklinks(id);
      if (backlinks.length === 0) return 'No backlinks found.';
      return backlinks.map((d) => `- ${d.title} (${d.path})`).join('\n');
    },
  },
];
