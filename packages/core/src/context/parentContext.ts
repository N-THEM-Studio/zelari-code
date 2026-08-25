/**
 * Context Engine v2 — parent context for tentacles (Frontier Runtime Upgrade §51).
 *
 * A Kraken tentacle never receives the lead's full transcript. When the
 * orchestrator has parent messages available, `parentContextForRole()`
 * renders the projected summary the role's policy allows:
 *
 *   - explore / general / verify → `includeParentSummary: true` → compact
 *     deterministic digest (summary history + summary-only tool results)
 *   - lead / roles with the flag off → `null` (no block)
 *
 * The block is meant to be PREPENDED to the tentacle's user prompt. It is
 * pure: no mutation, no IO, no LLM.
 *
 * @since v2.11.0
 */
import type { AgentMessage } from '../core/AgentHarness.js';
import { contextPolicyForRole } from './ContextPolicy.js';
import { projectContext } from './ContextProjector.js';

export interface ParentContextBlock {
  /** Rendered markdown block to prepend to the tentacle user prompt. */
  block: string;
  stats: {
    /** Estimated tokens of the rendered block. */
    estimatedTokens: number;
    /** Parent messages the projection considered (non-system). */
    sourceMessages: number;
    /** Whether a digest of dropped units was included. */
    digest: boolean;
  };
}

const DEFAULT_MAX_BLOCK_CHARS = 6_000;
const TRUNCATION_TAIL = '\n[…parent context truncated to fit the role budget…]';

function renderCompact(m: AgentMessage): string | null {
  if (m.role === 'user') {
    const text = m.content.trim();
    return text ? `user — ${text}` : null;
  }
  if (m.role === 'assistant') {
    const tools = m.toolCalls?.length
      ? ` (requested: ${m.toolCalls.map((t) => t.name).join(', ')})`
      : '';
    const text = m.content.trim();
    return text ? `assistant${tools} — ${text}` : tools ? `assistant${tools}` : null;
  }
  if (m.role === 'tool') {
    const text = m.content.trim();
    return text ? `tool result — ${text}` : null;
  }
  const text = m.content.trim();
  return text ? `${m.role} — ${text}` : null;
}

/**
 * Build the parent-context block a tentacle of `role` may receive, or `null`
 * when the role's policy excludes parent summaries (lead) or there is nothing
 * to summarize. System messages are never leaked (the tentacle has its own
 * persona prompt); tool results are always summarized, never full.
 */
export function parentContextForRole(
  role: string,
  transcript: readonly AgentMessage[],
  opts?: { maxBlockChars?: number },
): ParentContextBlock | null {
  const policy = contextPolicyForRole(role);
  const body = transcript.filter((m) => m.role !== 'system');
  if (!policy.includeParentSummary || body.length === 0) return null;

  const projected = projectContext([...body], {
    ...policy,
    history: 'summary',
    toolResults: 'summary-only',
  });

  const lines: string[] = [];
  for (const m of projected.messages) {
    const line = renderCompact(m);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return null;

  const maxChars = opts?.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;
  let body_ = lines.join('\n');
  let truncated = false;
  if (body_.length > maxChars) {
    body_ = body_.slice(0, maxChars) + TRUNCATION_TAIL;
    truncated = true;
  }

  const header = truncated
    ? '[Parent agent context — projected summary, full transcript not shared]'
    : '[Parent agent context — projected summary]';

  return {
    block: `---\n${header}\n\n${body_}\n---`,
    stats: {
      estimatedTokens: Math.ceil(body_.length / 4),
      sourceMessages: body.length,
      digest: projected.stats.digest,
    },
  };
}
