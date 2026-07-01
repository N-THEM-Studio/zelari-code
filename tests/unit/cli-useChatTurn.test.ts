// @vitest-environment jsdom
/**
 * cli-useChatTurn.test.ts — Task v0.4.3 audit
 *
 * Direct unit tests for useChatTurn. The v0.4.2 split moved dispatchPrompt
 * + dispatchCouncilPrompt into this hook but did NOT add direct coverage.
 * The agy audit (v0.4.3) found that `dispatchCouncilPrompt` was being
 * returned as the raw `dispatchCouncilPromptImpl(text, deps)` — which
 * crashes when called with one argument as the router does.
 *
 * These tests render the hook via @testing-library/react's renderHook
 * (added in RT 18+) and exercise both dispatch paths end-to-end with
 * mocked AgentHarness / dispatchCouncil.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';

// ─── Mocks ─────────────────────────────────────────────────────────────

// Mock AgentHarness so dispatchPrompt can run without an LLM.
vi.mock('../../src/main/core/AgentHarness.js', () => {
  return {
    AgentHarness: class {
      run = async function* () {
        yield { type: 'message_delta', delta: 'hello', ts: Date.now() };
        yield { type: 'agent_end', reason: 'stop', durationMs: 100, ts: Date.now() };
      };
      queueLength = 0;
      enqueue = vi.fn();
      cancel = vi.fn();
      constructor(_opts: unknown) {}
    },
  };
});

// Mock provider/env so dispatchPrompt doesn't try to read OPENAI_API_KEY.
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
  // The real `createBuiltinToolRegistry()` returns { registry, ... } — the
  // dispatch code destructures `registry` off the result. Match that shape.
  createBuiltinToolRegistry: vi.fn(() => ({
    registry: { toOpenAITools: () => [] },
  })),
}));

vi.mock('../../src/cli/metrics.js', () => ({
  getMetricsLogger: vi.fn(() => ({
    record: vi.fn(),
  })),
}));

vi.mock('../../src/cli/modelPricing.js', () => ({
  calculateCost: vi.fn(() => 0.0001),
}));

// Mock the council dispatcher — we just want to verify it's called with
// the right argument and that dispatchCouncilPrompt returns cleanly.
vi.mock('../../src/cli/councilDispatcher.js', () => ({
  dispatchCouncil: vi.fn(async function* () {
    yield { type: 'agent_end', reason: 'stop', durationMs: 50, ts: Date.now() };
  }),
}));

vi.mock('../../src/cli/workspace/stubs.js', () => ({
  createWorkspaceContext: vi.fn(() => ({})),
  createWorkspaceStubs: vi.fn(() => ({})),
}));

vi.mock('../../src/cli/workspace/toolRegistry.js', () => ({
  createWorkspaceToolRegistry: vi.fn(() => ({
    list: () => [],
    get: () => undefined,
  })),
}));

vi.mock('../../src/agents/tools.js', () => ({
  setWorkspaceStubs: vi.fn(),
}));

vi.mock('../../src/cli/workspace/postCouncilHook.js', () => ({
  runPostCouncilHook: vi.fn(async () => ({ ran: false, changed: false })),
}));

vi.mock('../../src/cli/councilFeedback.js', () => ({
  FeedbackStore: class {
    record = vi.fn();
  },
}));

// Mock the session writer so we don't touch real files.
class FakeWriter {
  append = vi.fn(async () => {});
  close = vi.fn(async () => {});
}
vi.mock('../../src/main/core/sessionJsonl.js', () => ({
  SessionJsonlWriter: FakeWriter,
}));

import { useChatTurn } from '../../src/cli/hooks/useChatTurn.js';
import type { ChatMessage } from '../../src/cli/components/ChatStream.js';

function makeWrapper() {
  const messages: ChatMessage[] = [];
  const setMessages = (updater: React.SetStateAction<ChatMessage[]>) => {
    if (typeof updater === 'function') {
      const next = (updater as (prev: ChatMessage[]) => ChatMessage[])(messages);
      messages.length = 0;
      messages.push(...next);
    } else {
      messages.length = 0;
      messages.push(...updater);
    }
  };
  const setSessionStats = vi.fn();
  const setBusy = vi.fn();
  const setSessionActive = vi.fn();
  const writerRef = { current: new FakeWriter() } as React.MutableRefObject<any>;
  return { messages, setMessages, setSessionStats, setBusy, setSessionActive, writerRef };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useChatTurn (v0.4.3 audit coverage)', () => {
  it('dispatchPrompt: appends message_delta events as assistant content', async () => {
    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'test-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    await act(async () => {
      await result.current.dispatchPrompt('hello world');
    });

    // The FakeHarness emits one 'message_delta' with content 'hello'.
    const assistantMessages = w.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThan(0);
    expect(assistantMessages.some((m) => m.content === 'hello')).toBe(true);
  });

  it('dispatchCouncilPrompt: accepts a single argument (does NOT crash with TypeError on undefined deps)', async () => {
    // v0.4.3 regression test: before the fix, dispatchCouncilPrompt was the
    // raw impl which required (text, deps). Calling it with one arg crashed
    // with "Cannot destructure property 'sessionId' of 'undefined'".
    const { dispatchCouncil } = await import('../../src/cli/councilDispatcher.js');
    vi.mocked(dispatchCouncil).mockImplementation(async function* () {
      yield { type: 'agent_end', reason: 'stop', durationMs: 50, ts: Date.now() };
    } as never);

    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'council-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    // Should NOT throw.
    await act(async () => {
      await result.current.dispatchCouncilPrompt('plan a refactor');
    });

    // dispatchCouncil was called with the user's text.
    expect(dispatchCouncil).toHaveBeenCalledOnce();
    const call = vi.mocked(dispatchCouncil).mock.calls[0];
    expect(call[0]).toBe('plan a refactor');
  });

  it('returns harnessRef, queueCount, setQueueCount, dispatchPrompt, dispatchCouncilPrompt', () => {
    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 's',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    expect(typeof result.current.dispatchPrompt).toBe('function');
    expect(typeof result.current.dispatchCouncilPrompt).toBe('function');
    expect(typeof result.current.setQueueCount).toBe('function');
    expect(result.current.harnessRef).toBeDefined();
    expect(result.current.queueCount).toBe(0);
  });

  it('dispatchPrompt: surfaces setup errors to chat instead of throwing unhandled (v0.4.3 fix)', async () => {
    // v0.4.3 regression test: providerFromEnv throwing used to escape the
    // function unhandled. Now it should be caught and surfaced as a system
    // message + busy reset to false.
    const { providerFromEnv } = await import('../../src/cli/provider/openai-compatible.js');
    vi.mocked(providerFromEnv).mockRejectedValueOnce(new Error('provider config blew up'));

    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 's',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    // Should NOT throw.
    await act(async () => {
      await result.current.dispatchPrompt('trigger setup failure');
    });

    // Chat should have a [dispatch error] message.
    expect(w.messages.some((m) => m.content.includes('[dispatch error]'))).toBe(true);
    // Busy should have been reset to false.
    expect(w.setBusy).toHaveBeenCalledWith(false);
  });
});