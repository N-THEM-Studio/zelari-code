/**
 * session/agentAdapter.ts — the single adapter from the session projection
 * to the AgentHarness message list (Exit-1 E1.1).
 *
 * `deriveMessages()` is the only model-history path (ADR-0016/0021); this
 * adapter is the only way those `DerivedMessage`s become the `AgentMessage[]`
 * fed to the harness. Hosts (CLI headless, TUI, Desktop) must not build model
 * history any other way — model-visible ⟺ logged.
 *
 * Field mapping (lossy by design, log keeps the full truth):
 * - `seq` is copied as optional provenance so hosts can persist compact
 *   ranges; providers never put it on the wire.
 * - `toolName` / `isError` on tool results have no AgentMessage slot; the
 *   output text is already in `content`, the semantics stay in the log.
 * - tool calls derived with `includeToolCalls: true` are JSON-encoded
 *   assistant messages (see deriveMessages); providers that need structured
 *   `tool_calls` blocks rebuild them from `pairToolCalls()` — this adapter
 *   deliberately does NOT parse the JSON back into `AgentMessage.toolCalls`:
 *   one derived message → one agent message, nothing invented.
 * - `images` / `reasoningContent` are runtime-only concepts; they never come
 *   from the spine.
 */

import type { AgentMessage } from '../core/AgentHarness.js';
import type { DerivedMessage } from './modelSurface.js';

/**
 * Map session-derived messages onto the AgentHarness input format.
 * Deterministic and side-effect free: the input is never mutated and the
 * output shares no object references with it (roles/content are copied).
 */
export function derivedToAgentMessages(
  messages: readonly DerivedMessage[],
): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of messages) {
    const agent: AgentMessage = { role: m.role, content: m.content };
    if (m.toolCallId !== undefined) agent.toolCallId = m.toolCallId;
    if (m.seq !== undefined) agent.seq = m.seq;
    if (m.compactedFromSeq !== undefined) agent.compactedFromSeq = m.compactedFromSeq;
    if (m.compactedToSeq !== undefined) agent.compactedToSeq = m.compactedToSeq;
    if (m.sourceEventSeqs !== undefined) agent.sourceEventSeqs = [...m.sourceEventSeqs];
    out.push(agent);
  }
  return out;
}
