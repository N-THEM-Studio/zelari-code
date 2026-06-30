import type { AgentMessage, AgentToolSpec, ProviderStreamFn, ProviderDelta } from './AgentHarness.js';

/**
 * Adapter that wraps a legacy LlmChatParams-based streaming call
 * (streamMiniMax / streamGlm / streamGrok / streamCustom in llm.ts)
 * into the new AgentHarness provider-stream interface.
 *
 * The adapter converts SSE chunks into ProviderDelta events:
 *   text chunks → { kind: 'text', delta }
 *   finish chunks → { kind: 'finish', reason }
 *   errors → { kind: 'error', message } (or thrown)
 */

export interface LegacyStreamFn {
  (params: {
    apiKey: string;
    model: string;
    provider: string;
    messages: { role: string; content: string }[];
    tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }>;
    temperature?: number;
    stream: true;
    customBaseUrl?: string;
    customAuthStyle?: 'openai' | 'anthropic';
    onChunk: (chunk: string) => void;
    onRequestId?: (requestId: string) => void;
    signal?: AbortSignal;
  }): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> }>;
}

/**
 * Convert AgentHarness AgentMessage[] → legacy {role, content}[].
 * Tool messages pass through their content (renderer fills these).
 */
function toLegacyMessages(messages: AgentMessage[]): { role: string; content: string }[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Convert AgentHarness AgentToolSpec[] → legacy OpenAI-shaped tool descriptors.
 */
function toLegacyTools(tools: AgentToolSpec[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters as object },
  }));
}

/**
 * Wrap a legacy stream function into a ProviderStreamFn that yields
 * provider-neutral deltas. Text chunks are forwarded; finish/end is detected
 * by the legacy function's resolved result (content length is the sum of deltas).
 *
 * NOTE: This adapter does NOT yield tool_call deltas yet — it treats tool calls
 * as a single 'finish' + tools-in-result pattern. Full tool-call streaming lands
 * in a later task.
 */
export function wrapLegacyStream(
  legacyStream: LegacyStreamFn,
  params: {
    apiKey: string;
    model: string;
    provider: string;
    customBaseUrl?: string;
    customAuthStyle?: 'openai' | 'anthropic';
  },
  _messages: AgentMessage[],
  _tools: AgentToolSpec[],
): ProviderStreamFn {
  return async function* (providerParams): AsyncIterable<ProviderDelta> {
    const accumulatedChunks: string[] = [];
    const legacyParams = {
      apiKey: params.apiKey,
      model: providerParams.model,
      provider: providerParams.provider,
      messages: toLegacyMessages(providerParams.messages),
      tools: toLegacyTools(providerParams.tools),
      temperature: 0.7,
      stream: true as const,
      customBaseUrl: params.customBaseUrl,
      customAuthStyle: params.customAuthStyle,
      onChunk: (chunk: string) => {
        accumulatedChunks.push(chunk);
      },
      onRequestId: undefined,
      signal: providerParams.signal,
    };
    // Fire the legacy stream and yield chunks as they arrive.
    // We can't await the whole result before yielding — we need to yield
    // chunks incrementally. Use a small async queue.
    const queue: ProviderDelta[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    let error: unknown = null;

    const promise = legacyStream(legacyParams)
      .then((result) => {
        // After legacy stream completes, emit a tool_call event for each tool
        // it returned (AgentHarness will then schedule tool execution in 12.6).
        for (const tc of result.toolCalls) {
          queue.push({ kind: 'tool_call', toolCallId: tc.id, toolName: tc.name, args: tc.args });
        }
        queue.push({ kind: 'finish', reason: 'stop' });
      })
      .catch((err) => {
        error = err;
      })
      .finally(() => {
        done = true;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      });

    // Pump chunks from accumulatedChunks every microtask
    let lastEmittedIndex = 0;
    while (!done || queue.length > 0 || lastEmittedIndex < accumulatedChunks.length) {
      // Emit any new chunks
      while (lastEmittedIndex < accumulatedChunks.length) {
        yield { kind: 'text', delta: accumulatedChunks[lastEmittedIndex] };
        lastEmittedIndex++;
      }
      // Emit any queued deltas
      while (queue.length > 0) {
        const d = queue.shift()!;
        yield d;
      }
      // If error, throw
      if (error) {
        throw error;
      }
      // If done but nothing left, exit
      if (done) break;
      // Wait for next microtask
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
    await promise; // Ensure the legacy promise resolves (catches final errors)
  };
}
