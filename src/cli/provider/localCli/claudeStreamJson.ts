/**
 * claudeStreamJson — Claude Code CLI stream-json driver (Slice B, local-CLI
 * provider; pattern from OpenMausBot `server/drivers/claude.ts`, MIT).
 *
 * Two pure, injectable halves:
 *   - `buildClaudeInputLines(messages)` — AgentHarness conversation →
 *     Claude CLI `--input-format stream-json` lines (one JSON per line).
 *   - `createClaudeStreamParser()` — incremental parser over
 *     `--output-format stream-json` events → `ProviderDelta[]`.
 *
 * v1 scope (documented in .zelari/plans): the external CLI is an autonomous
 * agent — it executes its OWN tools internally (permission prompts go through
 * the Slice A broker via `--permission-prompt-tool`). tool_use blocks are
 * therefore rendered as text notifications, NOT re-executed by zelari, and
 * the turn always finishes with reason 'stop'.
 *
 * @since v1.30.0
 */

import type { AgentMessage, ProviderDelta } from '@zelari/core/harness';

// ── Input conversion ────────────────────────────────────────────────────────

function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

/**
 * Convert the harness conversation into Claude CLI stream-json input lines.
 *
 * Mapping:
 *   system    → {type:"system", content}
 *   user      → {type:"user", message:{role:"user", content:[text]}}
 *   assistant → {type:"assistant", message:{role:"assistant",
 *               content:[text?, ...tool_use]}} (toolCalls → tool_use blocks)
 *   tool      → {type:"user", message:{role:"user",
 *               content:[{type:"tool_result", tool_use_id, content}]}}
 */
export function buildClaudeInputLines(messages: AgentMessage[]): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      lines.push(JSON.stringify({ type: 'system', content: m.content }));
      continue;
    }
    if (m.role === 'user') {
      lines.push(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [textBlock(m.content)] },
        }),
      );
      continue;
    }
    if (m.role === 'tool') {
      lines.push(
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.toolCallId ?? 'tool-result',
                content: m.content,
              },
            ],
          },
        }),
      );
      continue;
    }
    // assistant
    const content: Record<string, unknown>[] = [];
    if (m.content.length > 0) content.push(textBlock(m.content));
    for (const tc of m.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
    }
    if (content.length === 0) content.push(textBlock(''));
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content },
      }),
    );
  }
  return lines;
}

// ── Output parsing ──────────────────────────────────────────────────────────

export interface ClaudeStreamParser {
  /** Feed one output line; returns the deltas it produced. */
  push(line: string): ProviderDelta[];
  /** True after the terminal `result` event was seen. */
  readonly finished: boolean;
  /** Last stop_reason observed on an assistant message. */
  readonly stopReason: string;
}

const TOOL_USE_TEXT = (name: string, input: unknown): string =>
  `\n[CLI tool] ${name} ${JSON.stringify(input ?? {})}\n`;

/**
 * Incremental parser for `claude -p --output-format stream-json`.
 *
 * Events handled:
 *   - system/init        → ignored
 *   - stream_event       → content_block_delta text_delta → {kind:'text'}
 *   - assistant          → tool_use blocks → text notification; captures
 *                          stop_reason. Text blocks are NOT re-emitted (the
 *                          text was already streamed as deltas).
 *   - result             → usage delta + terminal {kind:'finish'} (once)
 *
 * Safety net: if a text-bearing result arrives and no text was streamed at
 * all, the result text is emitted so the user still sees an answer.
 */
export function createClaudeStreamParser(): ClaudeStreamParser {
  let finished = false;
  let stopReason = 'stop';
  let totalTextStreamed = 0;

  const push = (line: string): ProviderDelta[] => {
    if (finished) return [];
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(trimmed) as { type?: string; [k: string]: unknown };
    } catch {
      return []; // never crash on non-JSON noise
    }
    const type = msg.type;

    if (type === 'stream_event') {
      const event = msg.event as {
        type?: string;
        delta?: { type?: string; text?: unknown };
      } | null;
      if (
        event?.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        typeof event.delta.text === 'string'
      ) {
        totalTextStreamed += event.delta.text.length;
        return [{ kind: 'text', delta: event.delta.text }];
      }
      return [];
    }

    if (type === 'assistant') {
      const message = msg.message as {
        stop_reason?: string;
        content?: Array<{ type?: string; name?: string; input?: unknown }>;
      } | null;
      if (message?.stop_reason) {
        stopReason = message.stop_reason === 'end_turn' ? 'stop' : message.stop_reason;
      }
      const deltas: ProviderDelta[] = [];
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          deltas.push({ kind: 'text', delta: TOOL_USE_TEXT(block.name, block.input) });
        }
      }
      return deltas;
    }

    if (type === 'result') {
      finished = true;
      const deltas: ProviderDelta[] = [];
      // Safety net: if nothing was streamed but the result carries text,
      // surface it (covers non-streaming edge cases).
      if (totalTextStreamed === 0 && typeof msg.result === 'string' && msg.result.length > 0) {
        deltas.push({ kind: 'text', delta: msg.result });
      }
      const usage = msg.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
          }
        | null
        | undefined;
      if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
        const promptTokens = usage.input_tokens;
        const completionTokens = usage.output_tokens;
        deltas.push({
          kind: 'usage',
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            ...(typeof usage.cache_read_input_tokens === 'number'
              ? { cachedTokens: usage.cache_read_input_tokens }
              : {}),
          },
        });
      }
      deltas.push({ kind: 'finish', reason: stopReason });
      return deltas;
    }

    return [];
  };

  return {
    push,
    get finished() {
      return finished;
    },
    get stopReason() {
      return stopReason;
    },
  };
}
