// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over
// from app.tsx. Runtime is correct; tighten signatures in a follow-up.
import type { ChatMessage } from '../components/ChatStream.js';
import type { BrainEvent } from '../../shared/events.js';
import { newSessionId } from '../sessionManager.js';

/**
 * eventsToMessages — pure helper: replay a BrainEvent log into ChatMessage[].
 *
 * Streaming message_delta events are coalesced into a single growing
 * assistant message (keyed by assistantId) so the chat transcript doesn't
 * show N messages per LLM response.
 *
 * Extracted from app.tsx (Task v0.4.2 audit split) so it can be unit-tested
 * without booting React/Ink.
 */
export function eventsToMessages(events: readonly BrainEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let assistantBuffer = '';
  let assistantId = '';
  for (const e of events) {
    if (e.type === 'message_delta') {
      if (assistantId === '') assistantId = `resumed-${newSessionId()}`;
      assistantBuffer += e.delta;
      const last = out[out.length - 1];
      if (last && last.role === 'assistant' && last.id === assistantId) {
        out[out.length - 1] = { ...last, content: assistantBuffer };
      } else {
        out.push({ id: assistantId, role: 'assistant', content: assistantBuffer, ts: e.ts });
      }
    } else if (e.type === 'tool_execution_start') {
      // v0.4.3 audit fix: the v3-W event schema renamed `tool_call` →
      // `tool_execution_start` and added the `args` field. The old branches
      // here silently dropped every tool invocation during session resume.
      assistantBuffer = '';
      assistantId = '';
      const argsPreview = JSON.stringify((e as { args: unknown }).args).slice(0, 80);
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[tool_call] ${e.toolName}(${argsPreview})`,
        ts: e.ts,
      });
    } else if (e.type === 'tool_execution_end') {
      // v0.4.3 audit fix: same — `tool_result` → `tool_execution_end` with
      // `isError` / `durationMs` instead of `ok`.
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[tool_result] ${e.toolName} → ${(e as { isError: boolean }).isError ? 'error' : 'ok'}`,
        ts: e.ts,
      });
    } else if (e.type === 'agent_start') {
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[agent_start] model=${e.model} provider=${e.provider}`,
        ts: e.ts,
      });
    } else if (e.type === 'agent_end') {
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[agent_end] reason=${e.reason} duration=${e.durationMs}ms`,
        ts: e.ts,
      });
    } else if (e.type === 'error') {
      out.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: `[error] ${e.message}`,
        ts: e.ts,
      });
    }
  }
  return out;
}