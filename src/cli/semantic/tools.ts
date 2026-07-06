/**
 * semantic/tools — the `semantic_search` agent tool.
 *
 * Concept-level code search: "where is retry/backoff handled?" finds the
 * relevant chunks even when they share no literal keyword with the query —
 * where grep can't. Requires a prior index (`/index`). Read-only.
 *
 * The EmbedFn is injectable so the tool is testable without hitting a real
 * embeddings endpoint; in production it's bound to the active provider.
 */

import path from 'node:path';
import { z } from 'zod';
import { typedOk, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import { semanticSearch, loadIndex, type EmbedFn } from './index.js';
import { buildProviderEmbedFn } from './provider.js';

export interface SemanticToolDeps {
  /** Project root the index is keyed by. */
  root: string;
  /** Build the embed fn (defaults to the active provider). Null = unavailable. */
  buildEmbedFn?: () => Promise<EmbedFn | null>;
}

export function createSemanticTool(deps: SemanticToolDeps): ToolDefinition {
  const buildEmbedFn = deps.buildEmbedFn ?? buildProviderEmbedFn;
  return {
    name: 'semantic_search',
    description:
      'Concept-level search over the indexed codebase: describe what you are ' +
      'looking for in plain language ("where is rate-limit backoff handled?") and ' +
      'get the most relevant code chunks (file:line + snippet), even when they ' +
      'share no exact keyword with your query. Requires an index — if none exists, ' +
      'ask the user to run /index. Complements grep_content (exact matches).',
    permissions: ['read'],
    inputSchema: z.object({
      query: z.string().min(1).describe('Natural-language description of the code you want.'),
      k: z.number().int().positive().max(25).optional().describe('Max results (default 8).'),
    }),
    execute: async (args) => {
      const { query, k } = args as { query: string; k?: number };
      if (!loadIndex(deps.root)) {
        return typedOk({ results: [], note: 'no semantic index yet — run /index to build one, then retry' });
      }
      const embed = await buildEmbedFn();
      if (!embed) {
        return typedOk({ results: [], note: 'no provider/API key configured for embeddings' });
      }
      const res = await semanticSearch(deps.root, query, embed, k ?? 8);
      if ('error' in res) {
        return typedOk({ results: [], note: `semantic search unavailable: ${res.error}` });
      }
      return typedOk({
        count: res.hits.length,
        results: res.hits.map((h) => ({
          location: `${path.relative(deps.root, h.file) || h.file}:${h.startLine}-${h.endLine}`,
          score: Number(h.score.toFixed(3)),
          preview: h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text,
        })),
      });
    },
  };
}
