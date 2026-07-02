// @vitest-environment jsdom
/**
 * cli-toolDisplay.test.ts — v0.6.2 UI fixes (flicker + tool/action rendering).
 *
 * Covers:
 *  1. messageHelpers: appendToolStart now emits a `role: 'tool'` message
 *     (rendered via CollapsibleToolOutput) instead of a loose system line;
 *     updateToolMessageEnd stores the (truncated) result as the expandable
 *     body; finalizeStreamingAssistant seals the trailing streaming bubble.
 *  2. useChatTurn.dispatchPrompt: streamed text is NOT duplicated across
 *     message boundaries (the old code re-rendered the full accumulated turn
 *     content into the post-tool-call bubble), tool invocations surface as a
 *     single in-place-updated 'tool' message, and metrics receive the real
 *     toolName (tool_execution_end doesn't carry one).
 *  3. eventsToMessages: session resume renders tools as 'tool' messages and
 *     no longer prints "[tool_result] undefined → ok".
 *  4. pickVisibleMessages: height estimation accounts for wrapping of long
 *     tool summary lines (under-estimation made the transcript taller than
 *     the terminal, forcing Ink into full-screen repaints — flicker).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { FakeWriter } = vi.hoisted(() => ({
  FakeWriter: class FakeWriter {
    append = (..._args: unknown[]) => Promise.resolve();
    close = (..._args: unknown[]) => Promise.resolve();
  },
}));

vi.mock('@zelari/core/harness', () => ({
  AgentHarness: class {
    // Mirrors the real event order: message_start → deltas + tool events →
    // message_end, then a second provider turn for the post-tool text.
    run = async function* () {
      yield { type: 'message_start', messageId: 'm1', ts: 1 };
      yield { type: 'message_delta', delta: 'Let me check.', ts: 2 };
      yield { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' }, ts: 3 };
      yield { type: 'tool_execution_end', toolCallId: 'tc-1', result: 'file-a\nfile-b', isError: false, durationMs: 42, ts: 4 };
      yield { type: 'message_end', messageId: 'm1', ts: 5 };
      yield { type: 'message_start', messageId: 'm2', ts: 6 };
      yield { type: 'message_delta', delta: 'Done.', ts: 7 };
      yield { type: 'message_end', messageId: 'm2', ts: 8 };
      yield { type: 'agent_end', reason: 'stop', durationMs: 100, ts: 9 };
    };
    queueLength = 0;
    enqueue = vi.fn();
    cancel = vi.fn();
    constructor(_opts: unknown) {}
  },
  SessionJsonlWriter: FakeWriter,
}));

vi.mock('../../src/cli/provider/openai-compatible.js', () => ({
  openaiCompatibleProvider: vi.fn(() => async function* () {}),
  providerFromEnv: vi.fn(async () => ({
    apiKey: 'fake',
    model: 'fake-model',
    providerId: 'fake',
    baseUrl: 'http://localhost',
  })),
  providerConfigFor: vi.fn(),
}));

vi.mock('../../src/cli/crossProviderFailover.js', () => ({
  resolveFailoverStream: vi.fn(async () => ({
    primary: async function* () {},
    fallbackLabel: null,
    fallback: async function* () {},
  })),
}));

vi.mock('../../src/cli/providerFailover.js', () => ({
  providerFailover: vi.fn(({ primary, fallback }) => primary ?? fallback),
}));

vi.mock('../../src/cli/toolRegistry.js', () => ({
  createBuiltinToolRegistry: vi.fn(() => ({
    registry: { toOpenAITools: () => [] },
  })),
}));

const { recordSpy } = vi.hoisted(() => ({ recordSpy: vi.fn() }));
vi.mock('../../src/cli/metrics.js', () => ({
  getMetricsLogger: vi.fn(() => ({ record: recordSpy })),
}));

vi.mock('../../src/cli/modelPricing.js', () => ({
  calculateCost: vi.fn(() => 0.0001),
}));

import { useChatTurn } from '../../src/cli/hooks/useChatTurn.js';
import {
  appendToolStart,
  updateToolMessageEnd,
  finalizeStreamingAssistant,
  TOOL_RESULT_PREVIEW_CHARS,
} from '../../src/cli/hooks/messageHelpers.js';
import { eventsToMessages } from '../../src/cli/hooks/eventsToMessages.js';
import { pickVisibleMessages, type ChatMessage } from '../../src/cli/components/ChatStream.js';
import type { BrainEvent } from '@zelari/core/events';

function makeStore() {
  const messages: ChatMessage[] = [];
  const setMessages = (updater: React.SetStateAction<ChatMessage[]>) => {
    const next = typeof updater === 'function'
      ? (updater as (prev: ChatMessage[]) => ChatMessage[])([...messages])
      : updater;
    messages.length = 0;
    messages.push(...next);
  };
  return { messages, setMessages };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('messageHelpers — tool messages (v0.6.2)', () => {
  it('appendToolStart emits a role:tool message with toolCallId + args preview', () => {
    const { messages, setMessages } = makeStore();
    appendToolStart(setMessages, 'read_file', 'tc-9', { path: '/tmp/x' }, 123);
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.role).toBe('tool');
    expect(m.toolName).toBe('read_file');
    expect(m.toolCallId).toBe('tc-9');
    expect(m.content).toBe('{"path":"/tmp/x"}');
    expect(m.toolOk).toBeUndefined();
  });

  it('updateToolMessageEnd stores truncated result as toolResult and keeps the summary', () => {
    const { messages, setMessages } = makeStore();
    appendToolStart(setMessages, 'bash', 'tc-1', { command: 'ls' }, 1);
    const longResult = 'x'.repeat(TOOL_RESULT_PREVIEW_CHARS + 50);
    updateToolMessageEnd(setMessages, 'tc-1', false, 42, longResult);
    const m = messages[0];
    expect(m.toolOk).toBe(true);
    expect(m.toolDurationMs).toBe(42);
    expect(m.content).toBe('{"command":"ls"}'); // summary preserved
    expect(m.toolResult).toHaveLength(TOOL_RESULT_PREVIEW_CHARS + 1); // + ellipsis
    expect(m.toolResult!.endsWith('…')).toBe(true);
  });

  it('finalizeStreamingAssistant seals the trailing streaming bubble', () => {
    const { messages, setMessages } = makeStore();
    setMessages([
      { id: 'streaming-abc', role: 'assistant', content: 'hi', ts: 1 },
    ]);
    finalizeStreamingAssistant(setMessages);
    expect(messages[0].id).toBe('abc');
    // Idempotent / no-op when the last message isn't streaming.
    finalizeStreamingAssistant(setMessages);
    expect(messages[0].id).toBe('abc');
  });
});

describe('useChatTurn.dispatchPrompt — tool + streaming rendering (v0.6.2)', () => {
  function renderTurn(store: ReturnType<typeof makeStore>) {
    return renderHook(() =>
      useChatTurn({
        sessionId: 's',
        writerRef: { current: new FakeWriter() } as React.MutableRefObject<any>,
        setMessages: store.setMessages,
        commitStreaming: store.setMessages, // apply synchronously in tests
        flushStreaming: () => {},
        setBusy: vi.fn(),
        setSessionActive: vi.fn(),
        setSessionStats: vi.fn(),
      }),
    );
  }

  it('does NOT duplicate pre-tool text into the post-tool message', async () => {
    const store = makeStore();
    const { result } = renderTurn(store);
    await act(async () => {
      await result.current.dispatchPrompt('list files');
    });
    const assistants = store.messages.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.content)).toEqual(['Let me check.', 'Done.']);
    // Both bubbles are finalized (no streaming- ids survive the turn).
    expect(assistants.every((m) => !m.id.startsWith('streaming-'))).toBe(true);
  });

  it('renders one role:tool message per invocation, updated in place, with no legacy system lines', async () => {
    const store = makeStore();
    const { result } = renderTurn(store);
    await act(async () => {
      await result.current.dispatchPrompt('list files');
    });
    const tools = store.messages.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe('bash');
    expect(tools[0].toolOk).toBe(true);
    expect(tools[0].toolDurationMs).toBe(42);
    expect(tools[0].toolResult).toBe('file-a\nfile-b');
    // The old rendering emitted up to 4 system lines per tool call.
    const legacy = store.messages.filter(
      (m) => m.role === 'system' && /\[tool_call\]|\[tool_result\]|^▶|^[✓✗] /.test(m.content),
    );
    expect(legacy).toHaveLength(0);
  });

  it('records metrics with the toolName from the start event (end event has none)', async () => {
    const store = makeStore();
    const { result } = renderTurn(store);
    await act(async () => {
      await result.current.dispatchPrompt('list files');
    });
    const toolRecord = recordSpy.mock.calls.map((c) => c[0]).find((r) => r.kind === 'tool');
    expect(toolRecord).toBeDefined();
    expect(toolRecord.toolName).toBe('bash');
    expect(toolRecord.toolCallId).toBe('tc-1');
  });
});

describe('eventsToMessages — session resume tool rendering (v0.6.2)', () => {
  it('replays tool events as a single role:tool message with end status', () => {
    const events = [
      { type: 'message_delta', delta: 'Checking.', ts: 1 },
      { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' }, ts: 2 },
      { type: 'tool_execution_end', toolCallId: 'tc-1', result: 'ok!', isError: false, durationMs: 7, ts: 3 },
      { type: 'message_end', messageId: 'm1', ts: 4 },
      { type: 'message_delta', delta: 'Done.', ts: 5 },
    ] as unknown as BrainEvent[];
    const out = eventsToMessages(events);
    const tools = out.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe('bash');
    expect(tools[0].toolOk).toBe(true);
    expect(tools[0].toolDurationMs).toBe(7);
    expect(tools[0].toolResult).toBe('ok!');
    // No "[tool_result] undefined" system lines.
    expect(out.some((m) => m.content.includes('undefined'))).toBe(false);
    // Deltas before/after the boundary land in separate assistant bubbles.
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.content)).toEqual(['Checking.', 'Done.']);
  });
});

describe('pickVisibleMessages — wrapped tool summaries (v0.6.2)', () => {
  const mkTool = (id: string, content: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    role: 'tool',
    content,
    ts: 0,
    toolName: 'bash',
    ...overrides,
  });

  it('counts wrapping of long tool summary lines instead of assuming 1 row', () => {
    // width 30 → summary of 100 chars wraps to ~5 rows; with height 3 the
    // message cannot fit (the old fixed height=1 estimate would keep both,
    // overflowing the terminal and forcing full-screen repaints).
    const msgs = [mkTool('1', 'a'.repeat(100)), mkTool('2', 'b'.repeat(100))];
    expect(pickVisibleMessages(msgs, 3, 30)).toHaveLength(0);
    // Short summaries still fit as single rows.
    const short = [mkTool('3', 'ls'), mkTool('4', 'pwd')];
    expect(pickVisibleMessages(short, 3, 30)).toHaveLength(2);
  });

  it('accounts for the auto-expanded body of failed tools', () => {
    const failed = mkTool('1', 'boom', {
      toolOk: false,
      toolResult: 'line1\nline2\nline3',
    });
    // summary 1 + border 2 + 3 body lines = 6 rows at width 80.
    // Regression HIGH-1: must NOT return empty (which would blank the
    // transcript). Collapse the body to just the summary when there's
    // not enough height for the expanded view.
    const noSpace = pickVisibleMessages([failed], 5, 80);
    expect(noSpace).toHaveLength(1);
    expect(noSpace[0].toolResult).toBeUndefined();
    expect(noSpace[0].content).toBe('boom');
    expect(pickVisibleMessages([failed], 10, 80)).toHaveLength(1);
  });

  it('Regression HIGH-1: tool message that does not fit must NOT blank the transcript', () => {
    // A failed tool with a 50-line body at a small terminal should
    // show the collapsed summary, not disappear.
    const hugeFailed = mkTool('1', 'boom', {
      toolOk: false,
      toolResult: Array(50).fill('error line').join('\n'),
    });
    const out = pickVisibleMessages([hugeFailed], 3, 80);
    expect(out).toHaveLength(1);
    // The body must have been collapsed (auto-expand suppressed) to fit.
    expect(out[0].toolResult).toBeUndefined();
  });
});
