/**
 * Context Engine v2 — pure projection (Frontier Runtime Upgrade §52–53).
 *
 * SCOPE (ADR 015): tentacle parent-context ONLY — the sole production
 * consumer is taskTool.ts. The canonical turn-context compiler is the CLI
 * budget pipeline (src/cli/budget/, buildModelContext); this projector must
 * NOT be extended to the main loop (ADR 015: absorb it into the budget
 * pipeline as a strategy if it is ever needed there — never the reverse).
 *
 * projectContext() derives the message list an agent sends to its provider
 * from the full transcript, according to an AgentContextPolicy. It NEVER
 * mutates the input and performs no IO — enforcement budgets live in the CLI
 * layer; this module only selects and shapes.
 *
 * Core invariant: an assistant message carrying `toolCalls` is always emitted
 * together with its tool results (whole turn units are kept or dropped), so
 * providers never see an orphaned tool message (HTTP 400 on DeepSeek/GLM).
 *
 * 'summary' history mode here is a deterministic digest (no LLM): durable
 * LLM compaction remains the CLI's llmCompact path.
 *
 * @since v2.11.0
 */
import type { AgentMessage } from '../core/AgentHarness.js';
import type { AgentContextPolicy } from './ContextPolicy.js';

export interface ProjectedContext {
  messages: AgentMessage[];
  stats: {
    estimatedTokens: number;
    includedMessages: number;
    omittedMessages: number;
    truncatedToolResults: number;
    digest: boolean;
  };
}

/** A turn unit: one assistant(+toolCalls) with its tool results, or one standalone message. */
interface TurnUnit {
  messages: AgentMessage[];
  kind: 'user' | 'assistant' | 'orphan-tool' | 'other';
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_MAX_HISTORY_TURNS = 20;
const TRUNCATION_MARKER = '\n[…tool output truncated by context projection…]\n';
const HEAD_TAIL_MIN = 200;

function groupTurnUnits(history: AgentMessage[]): TurnUnit[] {
  const units: TurnUnit[] = [];
  let i = 0;
  while (i < history.length) {
    const msg = history[i]!;
    if (msg.role === 'assistant') {
      const unit: AgentMessage[] = [msg];
      i++;
      // Attach following tool results (and continuation assistants of same turn).
      while (i < history.length && history[i]!.role === 'tool') {
        unit.push(history[i]!);
        i++;
      }
      units.push({ messages: unit, kind: 'assistant' });
    } else if (msg.role === 'tool') {
      // Orphan tool result (assistant already dropped): keep as its own unit.
      units.push({ messages: [msg], kind: 'orphan-tool' });
      i++;
    } else {
      units.push({ messages: [msg], kind: msg.role === 'user' ? 'user' : 'other' });
      i++;
    }
  }
  return units;
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Deterministic one-line-per-unit digest of history units (no LLM). */
export function renderHistoryDigest(units: TurnUnit[]): string {
  const lines = units.map((unit) => {
    const head = unit.messages[0]!;
    if (unit.kind === 'user') return `- user: ${firstLine(head.content, 120)}`;
    if (unit.kind === 'assistant') {
      const tools = head.toolCalls?.map((t) => t.name).join(', ');
      return tools
        ? `- assistant (tools: ${tools})`
        : `- assistant: ${firstLine(head.content, 120)}`;
    }
    if (unit.kind === 'orphan-tool') return `- tool result ${head.toolCallId ?? '?'}: omitted`;
    return `- ${head.role}: ${firstLine(head.content, 120)}`;
  });
  return `[Context digest — earlier turns omitted]\n${lines.join('\n')}`;
}

function truncateProjected(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const markerLen = TRUNCATION_MARKER.length;
  const budget = Math.max(maxChars - markerLen, HEAD_TAIL_MIN * 2);
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  return `${content.slice(0, head)}${TRUNCATION_MARKER}${content.slice(-tail)}`;
}

function summarizeToolResult(content: string): string {
  const line = firstLine(content, 200);
  return `[tool result — ${content.length} chars, first line] ${line}`;
}

function applyToolResultPolicy(
  messages: AgentMessage[],
  policy: AgentContextPolicy,
): { messages: AgentMessage[]; truncated: number } {
  if (policy.toolResults === 'full') return { messages, truncated: 0 };
  const maxChars = policy.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  let truncated = 0;
  const out = messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    if (policy.toolResults === 'summary-only') {
      truncated++;
      return { ...msg, content: summarizeToolResult(msg.content) };
    }
    if (msg.content.length > maxChars) truncated++;
    return { ...msg, content: truncateProjected(msg.content, maxChars) };
  });
  return { messages: out, truncated };
}

function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
    if (m.reasoningContent) chars += m.reasoningContent.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Project a full transcript into the context a single agent should see.
 * System messages and the current user instruction (plus anything after it)
 * are always preserved verbatim.
 */
export function projectContext(
  transcript: AgentMessage[],
  policy: AgentContextPolicy,
): ProjectedContext {
  const system = transcript.filter((m) => m.role === 'system');
  const body = transcript.filter((m) => m.role !== 'system');

  // Current instruction = last user message + everything after it.
  let lastUserIdx = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const history = lastUserIdx >= 0 ? body.slice(0, lastUserIdx) : body.slice();
  const tail = lastUserIdx >= 0 ? body.slice(lastUserIdx) : [];

  const units = groupTurnUnits(history);
  const maxTurns = policy.maxHistoryTurns ?? DEFAULT_MAX_HISTORY_TURNS;

  let selected: AgentMessage[] = [];
  let digest = false;
  let includedUnits = 0;

  if (policy.history === 'full') {
    selected = history.slice();
    includedUnits = units.length;
  } else if (policy.history === 'recent') {
    const keep = units.slice(-maxTurns);
    includedUnits = keep.length;
    selected = keep.flatMap((u) => u.messages);
  } else if (policy.history === 'summary') {
    // Deterministic digest of everything + a small recent window.
    const recentUnits = units.slice(-2);
    includedUnits = recentUnits.length;
    selected = recentUnits.flatMap((u) => u.messages);
    if (units.length > recentUnits.length) {
      digest = true;
      selected.unshift({
        role: 'user',
        content: renderHistoryDigest(units.slice(0, units.length - recentUnits.length)),
      });
    }
  }
  // 'none': no history units at all.

  const includedMessages = selected.length + tail.length + system.length;

  const assembled = [...system, ...selected, ...tail];
  const { messages, truncated } = applyToolResultPolicy(assembled, policy);

  return {
    messages,
    stats: {
      estimatedTokens: estimateTokens(messages),
      includedMessages,
      omittedMessages: Math.max(0, history.length - selected.length - (digest ? 1 : 0)),
      truncatedToolResults: truncated,
      digest,
    },
  };
}
