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

// Mock AgentHarness + SessionJsonlWriter in a SINGLE vi.mock call (vitest uses
// the last one declared per module, so splitting them would drop the
// AgentHarness mock and the test would never receive any message_delta events).
// `FakeWriter` is hoisted via vi.hoisted so it's available inside the mock
// factory (which runs before any module-level statements).
//
// v1.6.0: the harness mock is now STATEFUL — it records the messages passed
// to the constructor, appends the assistant delta it emits, and exposes
// getMessages() so the rolling-history snapshot in dispatchPrompt can read
// the tail. `nextAssistantDelta` lets a test override what the next run()
// streams (defaults to 'hello').
const { FakeWriter, harnessState } = vi.hoisted(() => ({
  FakeWriter: class FakeWriter {
    append = (..._args: unknown[]) => Promise.resolve();
    close = (..._args: unknown[]) => Promise.resolve();
  },
  harnessState: {
    /** Messages captured from the most recent constructor call. */
    lastMessages: [] as unknown[],
    /** Delta the next run() will stream as assistant content. */
    nextAssistantDelta: 'hello' as string,
  },
}));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _FakeWriter_marker = FakeWriter; // keep reference alive for the mock below
vi.mock('@zelari/core/harness', () => ({
  AgentHarness: class {
    private messages: unknown[];
    constructor(opts: { messages?: unknown[] }) {
      // Copy so later mutation by the (mocked) run() doesn't alias the caller.
      this.messages = [...(opts.messages ?? [])];
      harnessState.lastMessages = this.messages;
    }
    getMessages() {
      return this.messages;
    }
    run = async function* (this: { messages: unknown[] }) {
      const delta = harnessState.nextAssistantDelta;
      // Simulate the real harness: append the assistant turn to the transcript
      // so getMessages() reflects what the snapshot reads post-run.
      this.messages.push({ role: 'assistant', content: delta });
      yield { type: 'message_delta', delta, ts: Date.now() };
      yield { type: 'agent_end', reason: 'stop', durationMs: 100, ts: Date.now() };
    };
    queueLength = 0;
    enqueue = vi.fn();
    cancel = vi.fn();
  },
  SessionJsonlWriter: FakeWriter,
}));

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

vi.mock('@zelari/core/skills', () => ({
  setWorkspaceStubs: vi.fn(),
  buildSystemPrompt: () => 'stub single-agent prompt',
  getAllTools: () => [],
  SINGLE_AGENT_IDENTITY_MODULE: {
    type: 'base-identity',
    title: 'Identity',
    priority: 10,
    content: 'identity',
  },
  registerCustomTool: () => {},
  cliToolToEnhanced: () => ({ name: 'x', description: 'x', category: 'core', parameters: {}, execute: () => '' }),
  // v1.7.0 (agy audit L1): language-policy helpers. The real implementation
  // reads env + runs detection. In this test we mirror the REAL output
  // shape (with `type: 'language-policy'`) so a bug where the module lands
  // in `customPromptModules` with the wrong type and silences 5 base
  // directives (the v1.7.0 critical bug) would still be caught. The
  // language argument follows the userText passed in (so a test that
  // asserts EN-detection works gets an EN directive back).
  detectResponseLanguage: vi.fn((text: string) => {
    // Cheap echo of the real detection: latin accent + function words.
    // Matches the tests' userText strings.
    if (text.toLowerCase().includes('please') || text.toLowerCase().includes('help')) return 'en';
    return 'it';
  }),
  resolveResponseLanguage: vi.fn((text: string) => text.includes('please') ? 'en' : 'it'),
  buildLanguageDirective: vi.fn((lang: string) => `# Response Language — ${lang}\nReply in ${lang}.`),
  buildLanguagePolicyModule: vi.fn((lang: string) => ({
    type: 'language-policy',
    title: `Response Language (${lang})`,
    priority: 5,
    content: `# Response Language — ${lang}\nReply in ${lang}.`,
  })),
  buildLanguagePolicyModuleFor: vi.fn((text: string) => {
    const lang = text.toLowerCase().includes('please') ? 'en' : 'it';
    return {
      type: 'language-policy',
      title: `Response Language (${lang})`,
      priority: 5,
      content: `# Response Language — ${lang}\nReply in ${lang}.`,
    };
  }),
}));

// Mock the workspace summary builders so dispatchPrompt doesn't scan the
// real repo cwd during tests (and so the plan-driven updateTask registration
// path below is deterministic).
vi.mock('../../src/cli/workspace/workspaceSummary.js', () => ({
  buildWorkspaceSummary: vi.fn(() => 'ws-summary'),
  buildPlanSummary: vi.fn(() => null),
  buildZelariReadHint: vi.fn(() => ''),
  EPISTEMIC_BANNER: '# EPISTEMIC RULES',
}));

vi.mock('../../src/cli/workspace/composeContext.js', () => ({
  composeProjectContext: vi.fn(() => ({
    projectInstructions: '',
    workspaceContext: 'ws-composed',
    ragContext: '',
    warnings: [],
  })),
}));

vi.mock('../../src/cli/workspace/planDetect.js', () => ({
  hasWorkspacePlan: vi.fn(() => false),
}));

vi.mock('../../src/cli/workspace/postCouncilHook.js', () => ({
  runPostCouncilHook: vi.fn(async () => ({ ran: false, changed: false })),
}));

vi.mock('../../src/cli/councilFeedback.js', () => ({
  FeedbackStore: class {
    record = vi.fn();
  },
}));

// NOTE: the second vi.mock for '@zelari/core/harness' (originally here to
// add the SessionJsonlWriter mock) was removed — see the consolidated mock
// at the top of this file. vitest uses the last mock declared per module,
// so splitting them silently dropped the AgentHarness mock.

import { useChatTurn } from '../../src/cli/hooks/useChatTurn.js';
import type { ChatMessage } from '../../src/cli/components/ChatStream.js';

function makeWrapper() {
  const messages: ChatMessage[] = [];
  const setMessages = (updater: React.SetStateAction<ChatMessage[]>) => {
    if (typeof updater === 'function') {
      const next = (updater as (prev: ChatMessage[]) => ChatMessage[])(messages);
      // If the updater returns the same array ref (no-op), do not wipe it —
      // `messages.length = 0; push(...sameRef)` would empty the chat.
      if (next === messages) return;
      messages.length = 0;
      messages.push(...next);
    } else {
      messages.length = 0;
      messages.push(...updater);
    }
  };
  // Streaming path is throttled in production; in this test we apply it
  // synchronously (same as setMessages) so we can assert on final content
  // without fake timers. The throttle is covered in cli-useBatchedMessages.test.
  const commitStreaming = setMessages;
  const flushStreaming = () => {};
  const setSessionStats = vi.fn();
  const setBusy = vi.fn();
  const setSessionActive = vi.fn();
  const writerRef = { current: new FakeWriter() } as React.MutableRefObject<any>;
  return {
    messages,
    setMessages,
    commitStreaming,
    flushStreaming,
    setSessionStats,
    setBusy,
    setSessionActive,
    writerRef,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // dispatchPrompt registers real MCP tools via registerMcpTools (lazy
  // singleton). Spawning the developer's MCP servers makes the first test
  // take ~9s and blow the default 5s vitest timeout, cascading into
  // result.current === null for every subsequent test. Keep unit tests hermetic.
  process.env['ZELARI_MCP'] = '0';
});

describe('useChatTurn (v0.4.3 audit coverage)', () => {
  it('dispatchPrompt: appends message_delta events as assistant content', async () => {
    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'test-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
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
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
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
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
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
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
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

  it('dispatchPrompt: registers the workspace updateTask tool when a plan exists (v0.7.4)', async () => {
    // v0.7.4: the single agent implements the council's tasks and must be
    // able to advance their status through updateTask (mutex + atomic
    // plan.json write) instead of hand-editing the JSON.
    const { hasWorkspacePlan } = await import('../../src/cli/workspace/planDetect.js');
    vi.mocked(hasWorkspacePlan).mockReturnValueOnce(true);
    const fakeUpdateTask = {
      name: 'updateTask',
      description: 'update a task status',
      permissions: [],
      inputSchema: {},
      execute: vi.fn(),
    };
    const { createWorkspaceToolRegistry } = await import('../../src/cli/workspace/toolRegistry.js');
    vi.mocked(createWorkspaceToolRegistry).mockReturnValueOnce({
      list: () => ['updateTask'],
      get: (name: string) => (name === 'updateTask' ? fakeUpdateTask : undefined),
    } as never);
    const { createBuiltinToolRegistry } = await import('../../src/cli/toolRegistry.js');
    const register = vi.fn();
    vi.mocked(createBuiltinToolRegistry).mockReturnValueOnce({
      registry: { toOpenAITools: () => [], register },
    } as never);

    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'plan-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    await act(async () => {
      await result.current.dispatchPrompt('implement the next task');
    });

    expect(register).toHaveBeenCalledWith(fakeUpdateTask);
    // No [dispatch error] — the registration path must not break the turn.
    expect(w.messages.some((m) => m.content.includes('[dispatch error]'))).toBe(false);
  });

  it('dispatchPrompt: does NOT wire workspace tools when there is no plan', async () => {
    const { createWorkspaceToolRegistry } = await import('../../src/cli/workspace/toolRegistry.js');
    vi.mocked(createWorkspaceToolRegistry).mockClear();

    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'no-plan-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    await act(async () => {
      await result.current.dispatchPrompt('just a question');
    });

    // buildPlanSummary (default mock) returns null → no workspace registry.
    expect(createWorkspaceToolRegistry).not.toHaveBeenCalled();
  });
});

// ─── v1.6.0: rolling conversation history ──────────────────────────────
// The single-agent loop was stateless across turns (rebuilt
// [system, user] each turn). The fix carries prior turns forward so the
// model sees its own question when the user answers briefly.
describe('useChatTurn — rolling history (v1.6.0)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset the harness mock's delta between sub-tests.
    harnessState.nextAssistantDelta = 'hello';
    harnessState.lastMessages = [];
    // v1.8.0: history is module-global — isolate tests.
    const { _resetConversationContextForTests } = await import(
      '../../src/cli/hooks/conversationContext.js'
    );
    _resetConversationContextForTests();
  });

  it('carries the prior turn forward: turn 2 sees [system, <assistant turn1>, user turn2]', async () => {
    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'history-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    // Turn 1: assistant says "hello".
    harnessState.nextAssistantDelta = 'turn1-answer';
    await act(async () => {
      await result.current.dispatchPrompt('turn1-question');
    });

    // Turn 2: the harness must be seeded with turn 1's assistant output.
    harnessState.nextAssistantDelta = 'turn2-answer';
    await act(async () => {
      await result.current.dispatchPrompt('turn2-question');
    });

    // harnessState.lastMessages = what the constructor got on turn 2:
    // [system, <assistant "turn1-answer">, user "turn2-question"]
    const msgs = harnessState.lastMessages as Array<{ role: string; content: string }>;
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs[0].role).toBe('system');
    // The carried assistant turn must be present.
    const carriedAssistant = msgs.find(
      (m) => m.role === 'assistant' && m.content === 'turn1-answer',
    );
    expect(carriedAssistant).toBeDefined();
    // The current user prompt must be present.
    const currentUser = msgs.find(
      (m) => m.role === 'user' && m.content === 'turn2-question',
    );
    expect(currentUser).toBeDefined();
  });

  it('binds a short answer to a prior clarifying question via carried history', async () => {
    // Simulates the reported bug: agent asks a question with choices
    // [Minimal, Standard, Full, Scaffold]; user answers "full". With rolling
    // history, turn 2's seed must include turn 1's question text so the model
    // can bind "full" to the Full choice.
    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'clarify-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    // Turn 1: assistant poses a clarifying question (the ---QUESTION--- block
    // is part of the streamed assistant content).
    harnessState.nextAssistantDelta =
      'Which scope?\n---QUESTION---\n{"question":"scope?","choices":["Minimal","Standard","Full","Scaffold"]}\n---END---';
    await act(async () => {
      await result.current.dispatchPrompt('modernize the UI');
    });

    // Turn 2: user answers "full".
    harnessState.nextAssistantDelta = 'applying Full scope';
    await act(async () => {
      await result.current.dispatchPrompt('full');
    });

    // The seed for turn 2 must contain the prior assistant turn (with the
    // question) so the model can bind "full" → Full. v1.8.0 also rewrites the
    // short user message into an anchored form that re-states the question.
    const msgs = harnessState.lastMessages as Array<{ role: string; content: string }>;
    const priorQuestion = msgs.find(
      (m) => m.role === 'assistant' && m.content.includes('---QUESTION---'),
    );
    expect(priorQuestion).toBeDefined();
    const answer = msgs.find(
      (m) =>
        m.role === 'user' &&
        (m.content === 'full' ||
          (m.content.includes('User\'s answer') && m.content.toLowerCase().includes('full'))),
    );
    expect(answer).toBeDefined();
  });

  it('does not pollute history when a turn errors (failed turn snapshot skipped)', async () => {
    const { providerFromEnv } = await import(
      '../../src/cli/provider/openai-compatible.js'
    );
    const w = makeWrapper();
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'err-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
      }),
    );

    // Turn 1 succeeds.
    harnessState.nextAssistantDelta = 'good-answer';
    await act(async () => {
      await result.current.dispatchPrompt('q1');
    });

    // Turn 2 fails at provider resolution (before the harness runs).
    vi.mocked(providerFromEnv).mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.dispatchPrompt('q2');
    });

    // Turn 3 succeeds — its seed must NOT contain a phantom turn-2 assistant
    // message (the failed turn must not have snapshotted anything).
    harnessState.nextAssistantDelta = 'q3-answer';
    await act(async () => {
      await result.current.dispatchPrompt('q3');
    });

    const msgs = harnessState.lastMessages as Array<{ role: string; content: string }>;
    // The seed for turn 3 = [system, <assistant "good-answer"> (carried from
    // turn 1), user "q3", <assistant "q3-answer"> (appended by this run)].
    // Crucially, there must be NO assistant message from the failed turn 2 —
    // the snapshot was skipped, so turn 2's "would-be" output is absent.
    const assistantContents = msgs
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);
    expect(assistantContents).toContain('good-answer');
    expect(assistantContents).toContain('q3-answer');
    // Exactly two assistants: turn 1's (carried) + turn 3's (current). No
    // phantom turn-2 output.
    expect(assistantContents.length).toBe(2);
  });

  it('opens the clarification picker when the agent emits a ---QUESTION--- block', async () => {
    // v1.6.0: when the assistant's turn ends with a clarifying question
    // (---QUESTION--- {json} ---END---), dispatchPrompt must parse it and
    // call setPicker with kind 'clarification' + the offered choices.
    const w = makeWrapper();
    const pickerCalls: unknown[] = [];
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'picker-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
        setPicker: (req: unknown) => pickerCalls.push(req),
      }),
    );

    harnessState.nextAssistantDelta =
      'Which scope do you want?\n---QUESTION---\n{"question":"What scope?","choices":["Minimal","Standard","Full"],"context":"pick one"}\n---END---';
    await act(async () => {
      await result.current.dispatchPrompt('modernize the UI');
    });

    expect(pickerCalls.length).toBe(1);
    const req = pickerCalls[0] as {
      kind: string;
      title: string;
      items: { value: string; label: string }[];
      onAnswer?: (v: string) => void;
    };
    expect(req.kind).toBe('clarification');
    expect(req.title).toBe('What scope?');
    expect(req.items.map((i) => i.value)).toEqual(['Minimal', 'Standard', 'Full']);
    expect(typeof req.onAnswer).toBe('function');
  });

  it('does NOT open the picker when the assistant asks a question with <2 choices', async () => {
    // The protocol allows 2-4 choices. A block with only 1 choice (or none)
    // is malformed and should not trigger the picker — the user just types.
    const w = makeWrapper();
    const pickerCalls: unknown[] = [];
    const { result } = renderHook(() =>
      useChatTurn({
        sessionId: 'no-picker-session',
        writerRef: w.writerRef,
        setMessages: w.setMessages,
        commitStreaming: w.commitStreaming,
        flushStreaming: w.flushStreaming,
        setBusy: w.setBusy,
        setSessionActive: w.setSessionActive,
        setSessionStats: w.setSessionStats,
        setPicker: (req: unknown) => pickerCalls.push(req),
      }),
    );

    harnessState.nextAssistantDelta =
      'hmm\n---QUESTION---\n{"question":"only one?","choices":["lonely"]}\n---END---';
    await act(async () => {
      await result.current.dispatchPrompt('test');
    });

    expect(pickerCalls.length).toBe(0);
  });
});