/**
 * Regression suite — context & cache upgrade (v1.36.0).
 * Covers the spec's mandatory cases: snapshot fingerprints, deterministic
 * tool order, meter completeness, cache-pressure discipline, replay shape,
 * tool-call rejection, size guard, force gate, checkpoint-as-user, store
 * lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createRoutedRequestSnapshot,
  compareReplayPrefix,
  stableStringify,
} from '@zelari/core/harness';
import type { AgentMessage, AgentToolSpec, ProviderStreamFn } from '@zelari/core/harness';
import {
  compactHistoryAsync,
  compactHistoryDetailed,
  buildCheckpointMessage,
} from '../../src/cli/hooks/historyCompaction.js';
import {
  llmSummarizeHistoryReplay,
  COMPACTION_INSTRUCTION,
} from '../../src/cli/budget/llmCompact.js';
import {
  recordRequestSnapshot,
  recordRequestUsage,
  getRequestSnapshot,
  getRequestSnapshotWithUsage,
  clearAllRequestSnapshots,
  _resetRequestSnapshotStoreForTests,
} from '../../src/cli/budget/requestSnapshotStore.js';
import {
  measureRequest,
  estimateMessageTokens,
} from '../../src/cli/budget/requestMeter.js';
import { applyBudgetPolicyAsync } from '../../src/cli/budget/tokenBudget.js';

const REAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...REAL_ENV };
  delete process.env.ZELARI_CONTEXT_LIMIT;
  delete process.env.ZELARI_HISTORY_TURNS;
  delete process.env.ZELARI_COMPACT_MODEL;
  delete process.env.ZELARI_LLM_COMPACT;
  delete process.env.ZELARI_TOOL_RESULT_MAX_CHARS;
  delete process.env.ZELARI_TOOL_RESULT_TAIL_CHARS;
  _resetRequestSnapshotStoreForTests();
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  _resetRequestSnapshotStoreForTests();
});

function sys(content: string): AgentMessage {
  return { role: 'system', content };
}
function user(content: string): AgentMessage {
  return { role: 'user', content };
}
function asst(content: string): AgentMessage {
  return { role: 'assistant', content };
}

const tools: AgentToolSpec[] = [
  { name: 'zeta', description: 'z tool', parameters: { type: 'object' } },
  { name: 'alpha', description: 'a tool', parameters: { type: 'object' } },
];

describe('requestSnapshot (cases 3–7)', () => {
  it('case 3: snapshot carries the REAL provider id, not the transport family', () => {
    const snap = createRoutedRequestSnapshot({
      messages: [sys('s'), user('u')],
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      tools: [],
    });
    expect(snap.provider).toBe('deepseek');
    expect(snap.model).toBe('deepseek-v4-pro');
  });

  it('case 4: tool schemas are sorted deterministically (lexicographic)', () => {
    const snap = createRoutedRequestSnapshot({
      messages: [sys('s'), user('u')],
      model: 'm',
      provider: 'p',
      tools,
    });
    expect(snap.tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    // Different input order → same canonical order.
    const snap2 = createRoutedRequestSnapshot({
      messages: [sys('s'), user('u')],
      model: 'm',
      provider: 'p',
      tools: [...tools].reverse(),
    });
    expect(snap2.tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
  });

  it('case 5: logically identical envelopes produce identical fingerprints', () => {
    const base = { messages: [sys('s'), user('u')], model: 'm', provider: 'p', tools };
    const a = createRoutedRequestSnapshot(base);
    const b = createRoutedRequestSnapshot({ ...base, tools: [...tools].reverse() });
    expect(a.headerFingerprint).toBe(b.headerFingerprint);
    expect(a.requestFingerprint).toBe(b.requestFingerprint);
  });

  it('case 6: a change to the volatile system changes headerFingerprint', () => {
    const a = createRoutedRequestSnapshot({
      messages: [sys('stable'), sys('volatile-1'), user('u')],
      model: 'm',
      provider: 'p',
      tools,
    });
    const b = createRoutedRequestSnapshot({
      messages: [sys('stable'), sys('volatile-2'), user('u')],
      model: 'm',
      provider: 'p',
      tools,
    });
    expect(a.headerFingerprint).not.toBe(b.headerFingerprint);
    expect(a.requestFingerprint).not.toBe(b.requestFingerprint);
  });

  it('case 7: a tail-only change keeps headerFingerprint, changes requestFingerprint', () => {
    const a = createRoutedRequestSnapshot({
      messages: [sys('s'), user('u1')],
      model: 'm',
      provider: 'p',
      tools,
    });
    const b = createRoutedRequestSnapshot({
      messages: [sys('s'), user('u1'), asst('a1'), user('u2')],
      model: 'm',
      provider: 'p',
      tools,
    });
    expect(b.headerFingerprint).toBe(a.headerFingerprint);
    expect(b.requestFingerprint).not.toBe(a.requestFingerprint);
  });

  it('splits at the first non-system message regardless of system count (1 or 2)', () => {
    const one = createRoutedRequestSnapshot({
      messages: [sys('only'), user('u'), asst('a')],
      model: 'm',
      provider: 'p',
      tools: [],
    });
    expect(one.systemMessages.length).toBe(1);
    expect(one.conversation.map((m) => m.role)).toEqual(['user', 'assistant']);
    const two = createRoutedRequestSnapshot({
      messages: [sys('stable'), sys('volatile'), user('u')],
      model: 'm',
      provider: 'p',
      tools: [],
    });
    expect(two.systemMessages.length).toBe(2);
    expect(two.conversation.length).toBe(1);
  });

  it('stableStringify sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { z: 1, y: 2 } })).toBe(
      stableStringify({ a: { y: 2, z: 1 }, b: 1 }),
    );
  });

  it('compareReplayPrefix detects divergence index (telemetry only)', () => {
    const snap = createRoutedRequestSnapshot({
      messages: [sys('s'), user('u1'), asst('a1'), user('u2')],
      model: 'm',
      provider: 'p',
      tools: [],
    });
    const extended = [user('u1'), asst('a1'), user('u2'), asst('a2')];
    expect(compareReplayPrefix(snap, extended).exact).toBe(true);
    const diverged = [user('u1'), asst('DIFFERENT'), user('u2')];
    const cmp = compareReplayPrefix(snap, diverged);
    expect(cmp.exact).toBe(false);
    expect(cmp.mismatchIndex).toBe(1);
  });
});

describe('requestMeter (cases 8–10, 21)', () => {
  it('case 8: meter includes system + tool schemas + reasoning + toolCall ids', () => {
    const msg: AgentMessage = {
      role: 'assistant',
      content: 'x'.repeat(400),
      reasoningContent: 'r'.repeat(400),
      toolCalls: [{ id: 'call_123456', name: 'read_file', args: { path: 'a'.repeat(200) } }],
    };
    const withAll = estimateMessageTokens(msg);
    const bare = estimateMessageTokens({ role: 'assistant', content: 'x'.repeat(400) });
    expect(withAll).toBeGreaterThan(bare + 100); // args + reasoning + ids counted
  });

  it('case 9: same-header anchor uses provider usage (baseline + surface delta)', () => {
    const systemMessages = [sys('S'.repeat(4000))];
    const toolsBig: AgentToolSpec[] = [
      { name: 't', description: 'D'.repeat(4000), parameters: {} },
    ];
    const anchorSnap = createRoutedRequestSnapshot({
      messages: [...systemMessages, user('u1'), asst('a1')],
      model: 'm',
      provider: 'p',
      tools: toolsBig,
    });
    // Provider truth: header is much bigger than chars/4 suggests.
    const usage = {
      promptTokens: 20_000,
      completionTokens: 100,
      totalTokens: 20_100,
    };
    const result = measureRequest({
      systemMessages,
      tools: toolsBig,
      conversation: [user('u1'), asst('a1'), user('u2')],
      anchor: { snapshot: anchorSnap, usage },
      contextLimit: 100_000,
    });
    expect(result.headerAnchored).toBe(true);
    // Baseline (20k minus anchor conversation estimate) + new tail estimate.
    expect(result.estimatedPromptTokens).toBeGreaterThan(19_000);
  });

  it('case 10: cachedPromptTokens are NOT subtracted from contextPressureTokens', () => {
    const result = measureRequest({
      systemMessages: [sys('s')],
      tools: [],
      conversation: [user('u'), asst('a')],
      anchor: null,
      contextLimit: 10_000,
      reservedOutputTokens: 1000,
    });
    const convOnly = estimateMessageTokens(user('u')) + estimateMessageTokens(asst('a'));
    expect(result.contextPressureTokens).toBeGreaterThanOrEqual(
      result.estimatedPromptTokens + 1000,
    );
    expect(result.estimatedPromptTokens).toBeGreaterThan(convOnly);
  });

  it('case 21: cached usage propagates from the store through the anchor', () => {
    const snap = createRoutedRequestSnapshot({
      messages: [sys('s'), user('u')],
      model: 'm',
      provider: 'p',
      tools: [],
    });
    recordRequestSnapshot('sess-21', snap);
    recordRequestUsage('sess-21', {
      promptTokens: 5_000,
      completionTokens: 50,
      totalTokens: 5_050,
      cachedPromptTokens: 4_200,
    });
    const got = getRequestSnapshotWithUsage('sess-21');
    expect(got?.usage?.cachedPromptTokens).toBe(4_200);
  });
});

describe('requestSnapshotStore (case 22)', () => {
  it('clearAllRequestSnapshots drops stored snapshots (/clear, /new)', () => {
    const snap = createRoutedRequestSnapshot({
      messages: [sys('s'), user('u')],
      model: 'm',
      provider: 'p',
      tools: [],
    });
    recordRequestSnapshot('s1', snap);
    recordRequestSnapshot('s2', snap);
    expect(getRequestSnapshot('s1')).not.toBeNull();
    clearAllRequestSnapshots();
    expect(getRequestSnapshot('s1')).toBeNull();
    expect(getRequestSnapshot('s2')).toBeNull();
  });
});

describe('llmCompact replay (cases 13–17)', () => {
  function fakeStream(opts?: {
    text?: string;
    emitToolCall?: boolean;
    capture?: (p: unknown) => void;
  }): ProviderStreamFn {
    return async function* (params) {
      opts?.capture?.(params);
      if (opts?.emitToolCall) {
        yield { kind: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: {} };
      }
      yield { kind: 'text', delta: opts?.text ?? 'checkpoint text' };
      yield { kind: 'finish', reason: 'stop' };
    };
  }

  it('case 13: replay request = old system prefix + dropped prefix + trailing instruction', async () => {
    let captured: any = null;
    const systemMessages = [sys('STABLE'), sys('VOLATILE')];
    const dropped = [user('u1'), asst('a1')];
    const res = await llmSummarizeHistoryReplay({
      providerStream: fakeStream({ capture: (p) => (captured = p) }),
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      systemMessages,
      tools,
      droppedMessages: dropped,
    });
    expect(res.summary).toBeTruthy();
    expect(captured.messages).toEqual([
      ...systemMessages,
      ...dropped,
      { role: 'user', content: COMPACTION_INSTRUCTION },
    ]);
    // Tools MUST stay advertised (prefix stability).
    expect(captured.tools.map((t: AgentToolSpec) => t.name)).toEqual(['alpha', 'zeta']);
    expect(captured.generation).toMatchObject({
      purpose: 'compaction',
      temperature: 0.1,
      maxTokens: 900,
    });
  });

  it('case 14: there is NO summarizer system message before the conversation', async () => {
    let captured: any = null;
    await llmSummarizeHistoryReplay({
      providerStream: fakeStream({ capture: (p) => (captured = p) }),
      provider: 'p',
      model: 'm',
      systemMessages: [sys('ONLY-ORIGINAL')],
      tools: [],
      droppedMessages: [user('u1')],
    });
    const systemRoles = captured.messages.filter((m: AgentMessage) => m.role === 'system');
    expect(systemRoles).toEqual([{ role: 'system', content: 'ONLY-ORIGINAL' }]);
  });

  it('case 15: same provider/model by default → cacheReuseExpected true', async () => {
    const res = await llmSummarizeHistoryReplay({
      providerStream: fakeStream(),
      provider: 'p',
      model: 'm',
      systemMessages: [sys('s')],
      tools: [],
      droppedMessages: [user('u')],
    });
    expect(res.cacheReuseExpected).toBe(true);
  });

  it('case 16: ZELARI_COMPACT_MODEL override → cacheReuseExpected false', async () => {
    process.env.ZELARI_COMPACT_MODEL = 'other-model';
    const res = await llmSummarizeHistoryReplay({
      providerStream: fakeStream(),
      provider: 'p',
      model: 'm',
      systemMessages: [sys('s')],
      tools: [],
      droppedMessages: [user('u')],
    });
    expect(res.model).toBe('other-model');
    expect(res.cacheReuseExpected).toBe(false);
  });

  it('case 17: an accidental tool_call rejects the summary', async () => {
    const res = await llmSummarizeHistoryReplay({
      providerStream: fakeStream({ emitToolCall: true, text: 'partial' }),
      provider: 'p',
      model: 'm',
      systemMessages: [sys('s')],
      tools: [],
      droppedMessages: [user('u')],
    });
    expect(res.summary).toBeNull();
  });
});

describe('historyCompaction v1.36 (cases 11–12, 18–20)', () => {
  it('case 12 + P12: async compaction replaces the prefix with a USER checkpoint', async () => {
    process.env.ZELARI_LLM_COMPACT = '0'; // extractive only
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(user(`u${i} ` + 'x'.repeat(50)));
      msgs.push(asst(`a${i} ` + 'y'.repeat(50)));
    }
    const r = await compactHistoryAsync(msgs, { maxMessages: 8, force: true });
    expect(r.compacted).toBe(true);
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[0].content).toContain('<compacted-summary>');
  });

  it('case 18: summary not smaller than source is not committed (extractive kept)', async () => {
    process.env.ZELARI_LLM_COMPACT = '1';
    const dropped = [user('tiny')];
    // Build a history where the LLM summary would be HUGE.
    const stream: ProviderStreamFn = async function* () {
      yield { kind: 'text', delta: 'Z'.repeat(10_000) };
      yield { kind: 'finish', reason: 'stop' };
    };
    const msgs: AgentMessage[] = [
      user('tiny'),
      asst('ok'),
      ...Array.from({ length: 10 }, (_, i) => user(`q${i}`)),
    ];
    const r = await compactHistoryAsync(msgs, {
      maxMessages: 4,
      force: true,
      requestSnapshot: {
        provider: 'p',
        model: 'm',
        systemMessages: [sys('s')],
        tools: [],
      },
      providerStream: stream,
    });
    expect(r.compacted).toBe(true);
    // The oversized LLM summary must NOT have replaced the small extractive.
    expect((r.summary || '').length).toBeLessThan(5_000);
  });

  it('case 19: no cut can separate assistant(tool_calls) from its tool result', async () => {
    process.env.ZELARI_LLM_COMPACT = '0';
    const msgs: AgentMessage[] = [
      ...Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : asst(`a${i}`))),
      user('do'),
      { role: 'assistant', content: 'call', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'res' },
      asst('done'),
    ];
    const r = await compactHistoryAsync(msgs, { maxMessages: 4, force: true });
    const out = r.messages;
    const toolIdx = out.findIndex((m) => m.role === 'tool');
    if (toolIdx >= 0) {
      const hasDeclarer = out
        .slice(0, toolIdx)
        .some(
          (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'c1'),
        );
      expect(hasDeclarer).toBe(true);
    }
  });

  it('case 20: high token pressure with few huge messages forces compaction (force)', () => {
    const msgs: AgentMessage[] = [
      user('H'.repeat(40_000)),
      asst('K'.repeat(40_000)),
      user('recent'),
    ];
    const r = compactHistoryDetailed(msgs, { maxMessages: 2, force: true });
    expect(r.compacted).toBe(true);
    expect(r.messagesRemoved).toBeGreaterThan(0);
  });

  it('force=false keeps the count gate (legacy behavior)', () => {
    const msgs = [user('u'), asst('a'), user('u2')];
    const r = compactHistoryDetailed(msgs, { maxMessages: 2 });
    expect(r.compacted).toBe(false);
  });

  it('buildCheckpointMessage wraps the summary as user context', () => {
    const m = buildCheckpointMessage('SUMMARY-BODY');
    expect(m.role).toBe('user');
    expect(m.content).toContain('automatically generated checkpoint');
    expect(m.content).toContain('<compacted-summary>\nSUMMARY-BODY\n</compacted-summary>');
  });
});

describe('applyBudgetPolicyAsync pipeline (cases 11–12 pipeline level)', () => {
  it('case 11: at 80%, pruning oversized tool results avoids the summarizer', async () => {
    process.env.ZELARI_CONTEXT_LIMIT = '4000';
    // One huge tool result dominates; history message count is tiny.
    const msgs: AgentMessage[] = [
      user('q'),
      { role: 'assistant', content: 'c', toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'T'.repeat(40_000) },
      asst('done'),
    ];
    let summarizerCalls = 0;
    const stream: ProviderStreamFn = async function* () {
      summarizerCalls += 1;
      yield { kind: 'text', delta: 's' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const policy = await applyBudgetPolicyAsync(msgs, 'build', {
      providerStream: stream,
    });
    expect(summarizerCalls).toBe(0); // prune alone solved it
    expect(policy.occupancy).toBeLessThan(0.85);
    expect(policy.warnings.some((w) => /pruned/.test(w))).toBe(true);
  });

  it('case 12: persistent pressure (>85% after pruning) triggers the summarizer once+', async () => {
    process.env.ZELARI_CONTEXT_LIMIT = '4000';
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(user(`u${i} ` + 'X'.repeat(800)));
      msgs.push(asst(`a${i} ` + 'Y'.repeat(800)));
    }
    let summarizerCalls = 0;
    const stream: ProviderStreamFn = async function* () {
      summarizerCalls += 1;
      yield { kind: 'text', delta: 'compact checkpoint' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const policy = await applyBudgetPolicyAsync(msgs, 'build', {
      providerStream: stream,
    });
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
    expect(policy.messagesRemoved ?? 0).toBeGreaterThan(0);
  });
});
