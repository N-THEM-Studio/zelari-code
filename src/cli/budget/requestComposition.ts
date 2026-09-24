/**
 * requestComposition — what each LLM request is made of, by source.
 *
 * `kind: 'message'` rows (messageUsage.ts) carry what the provider billed:
 * prompt, cached and completion tokens. They cannot say WHERE the prompt
 * tokens came from. This module measures the request as it is handed to the
 * provider stream — the exact `messages` + `tools` the wire body is built
 * from — so each row can split its cost by source:
 *
 *   system        system-role messages (stable prompt + per-call tail notes)
 *   tools / mcp   tool schemas as sent (mcp_* named ones counted separately)
 *   trailing      the ephemeral `<context-update>` block (workspace, RAG)
 *   user          user messages other than the trailing block
 *   assistant     assistant text and tool-call arguments
 *   toolResults   tool outputs, with the largest producers by tool name
 *
 * Sizes are CHARACTERS of the serialized payload — exact and tokenizer-free.
 * The row's provider `promptTokens` converts them: tokens(source) ≈
 * promptTokens × chars(source) / totalChars.
 */
import type { AgentMessage, AgentToolSpec, ProviderStreamFn } from '@zelari/core/harness';

export interface RequestComposition {
  totalChars: number;
  systemChars: number;
  toolsCount: number;
  toolsChars: number;
  mcpToolsCount: number;
  mcpToolsChars: number;
  trailingChars: number;
  userChars: number;
  assistantChars: number;
  toolResultChars: number;
  /** Largest tool-result producers (chars), at most {@link TOP_TOOLS}. */
  toolResultsByTool: Record<string, number>;
}

const TOP_TOOLS = 8;
const TRAILING_OPEN = '<context-update>';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return JSON.stringify(content);
}

export function measureRequest(params: {
  messages: readonly AgentMessage[];
  tools?: readonly AgentToolSpec[];
}): RequestComposition {
  const c: RequestComposition = {
    totalChars: 0,
    systemChars: 0,
    toolsCount: 0,
    toolsChars: 0,
    mcpToolsCount: 0,
    mcpToolsChars: 0,
    trailingChars: 0,
    userChars: 0,
    assistantChars: 0,
    toolResultChars: 0,
    toolResultsByTool: {},
  };
  for (const tool of params.tools ?? []) {
    const chars = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }).length;
    c.toolsCount += 1;
    c.toolsChars += chars;
    if (tool.name.startsWith('mcp_')) {
      c.mcpToolsCount += 1;
      c.mcpToolsChars += chars;
    }
  }
  const callName = new Map<string, string>();
  const byTool = new Map<string, number>();
  for (const m of params.messages) {
    const text = textOf(m.content);
    if (m.role === 'system') {
      c.systemChars += text.length;
    } else if (m.role === 'user') {
      if (text.startsWith(TRAILING_OPEN)) c.trailingChars += text.length;
      else c.userChars += text.length;
    } else if (m.role === 'assistant') {
      c.assistantChars += text.length;
      for (const call of m.toolCalls ?? []) {
        callName.set(call.id, call.name);
        c.assistantChars += JSON.stringify(call.args ?? {}).length;
      }
    } else if (m.role === 'tool') {
      c.toolResultChars += text.length;
      const name = (m.toolCallId && callName.get(m.toolCallId)) || 'unknown';
      byTool.set(name, (byTool.get(name) ?? 0) + text.length);
    }
  }
  c.toolResultsByTool = Object.fromEntries(
    [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_TOOLS),
  );
  c.totalChars =
    c.systemChars + c.toolsChars + c.trailingChars + c.userChars + c.assistantChars + c.toolResultChars;
  return c;
}

/**
 * Wrap a provider stream so every request it serves is measured first.
 * `onRequest` runs synchronously before the first chunk; a throwing callback
 * is swallowed — telemetry never breaks a request.
 */
export function withRequestComposition(
  stream: ProviderStreamFn,
  onRequest: (composition: RequestComposition) => void,
): ProviderStreamFn {
  return (params) => {
    try {
      onRequest(measureRequest(params));
    } catch {
      /* telemetry is best-effort */
    }
    return stream(params);
  };
}
