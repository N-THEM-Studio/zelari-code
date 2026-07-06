import {
  collectSourceFiles,
  buildIndex,
  saveIndex,
  loadIndex,
  getIndexPath,
} from '../semantic/index.js';
import { buildProviderEmbedFn, embedModel } from '../semantic/provider.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

/**
 * `/index` — build (or rebuild) the semantic code index for `semantic_search`.
 * Walks the project's source files, embeds them via the active provider, and
 * persists the vectors. Best-effort: reports a clear error if no provider is
 * configured or the provider has no embeddings endpoint.
 */
export interface SemanticSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  cwd: string;
}

export async function handleIndexBuild(ctx: SemanticSlashContext): Promise<void> {
  const embed = await buildProviderEmbedFn();
  if (!embed) {
    appendSystem(ctx.setMessages, '[index] no provider/API key configured — run /login first.');
    return;
  }
  appendSystem(
    ctx.setMessages,
    `[index] scanning source files and embedding with "${embedModel()}"… (this can take a moment)`,
  );
  const files = await collectSourceFiles(ctx.cwd);
  if (files.length === 0) {
    appendSystem(ctx.setMessages, '[index] no source files found to index.');
    return;
  }
  const result = await buildIndex(files, embed, { model: embedModel() });
  if (result.error || !result.data) {
    appendSystem(
      ctx.setMessages,
      `[index] ✗ ${result.error ?? 'build failed'}` +
        (result.error?.includes('HTTP') || result.error?.includes('shape')
          ? '\n  (does this provider expose /embeddings? set ZELARI_EMBED_MODEL or switch provider.)'
          : ''),
    );
    return;
  }
  await saveIndex(ctx.cwd, result.data);
  appendSystem(
    ctx.setMessages,
    `[index] ✓ indexed ${result.chunksIndexed} chunks from ${result.filesIndexed} files ` +
      `(dim ${result.data.dim}). Use semantic_search now. Saved to ${getIndexPath(ctx.cwd)}`,
  );
}

export function handleIndexStatus(ctx: SemanticSlashContext): void {
  const data = loadIndex(ctx.cwd);
  if (!data) {
    appendSystem(ctx.setMessages, '[index] no semantic index yet — run /index to build one.');
    return;
  }
  const ageMin = Math.round((Date.now() - data.builtAt) / 60_000);
  appendSystem(
    ctx.setMessages,
    `[index] ${data.chunks.length} chunks, model "${data.model}", dim ${data.dim}, built ${ageMin}m ago.`,
  );
}
