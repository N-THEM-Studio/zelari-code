import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../core/AgentHarness.js';
import {
  DEFAULT_CONTEXT_POLICY,
  KRAKEN_EXPLORE_POLICY,
  KRAKEN_LEAD_POLICY,
  contextPolicyForRole,
} from './ContextPolicy.js';
import { projectContext, renderHistoryDigest } from './ContextProjector.js';

function user(content: string): AgentMessage {
  return { role: 'user', content };
}
function assistant(content: string): AgentMessage {
  return { role: 'assistant', content };
}
function assistantWithTools(id: string, names: string[]): AgentMessage {
  return {
    role: 'assistant',
    content: 'thinking',
    toolCalls: names.map((name, i) => ({ id: `${id}-${i}`, name, args: {} })),
  };
}
function tool(id: string, content: string): AgentMessage {
  return { role: 'tool', toolCallId: id, content };
}

/** system + 3 user/assistant pairs (with tools) + current instruction. */
function sampleTranscript(): AgentMessage[] {
  return [
    { role: 'system', content: 'You are Kraken.' },
    user('first task'),
    assistantWithTools('a', ['read_file']),
    tool('a-0', 'file contents here'),
    assistant('done with first'),
    user('second task'),
    assistantWithTools('b', ['bash', 'grep_content']),
    tool('b-0', 'exit 0'),
    tool('b-1', 'matches found'),
    user('current instruction'),
  ] as AgentMessage[];
}

describe('contextPolicyForRole', () => {
  it('maps kraken roles to their §51 policies', () => {
    expect(contextPolicyForRole('lead')).toBe(KRAKEN_LEAD_POLICY);
    expect(contextPolicyForRole('explore')).toBe(KRAKEN_EXPLORE_POLICY);
    expect(contextPolicyForRole('verify').history).toBe('summary');
    expect(contextPolicyForRole('general').includeGraphState).toBe(true);
  });

  it('falls back to the neutral default for unknown roles', () => {
    expect(contextPolicyForRole('planner')).toBe(DEFAULT_CONTEXT_POLICY);
  });
});

describe('projectContext — invariants', () => {
  it('always keeps system messages and the current instruction (none mode)', () => {
    const out = projectContext(sampleTranscript(), {
      ...DEFAULT_CONTEXT_POLICY,
      history: 'none',
    });
    expect(out.messages[0]).toMatchObject({ role: 'system' });
    expect(out.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'current instruction',
    });
    expect(out.messages).toHaveLength(2);
    expect(out.stats.omittedMessages).toBeGreaterThan(0);
  });

  it('never separates an assistant toolCalls from its tool results (recent window)', () => {
    const out = projectContext(sampleTranscript(), {
      ...DEFAULT_CONTEXT_POLICY,
      maxHistoryTurns: 2,
    });
    // Whatever is included must be pair-complete.
    const seenCallIds = new Set<string>();
    for (const m of out.messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) seenCallIds.add(tc.id);
      }
      if (m.role === 'tool') expect(seenCallIds.has(m.toolCallId!)).toBe(true);
    }
    // The oldest assistant (a) is dropped with its result.
    const ids = new Set(
      out.messages.flatMap((m) => m.toolCalls?.map((t) => t.id) ?? []),
    );
    expect(ids.has('a-0')).toBe(false);
  });

  it('full mode is the identity on message count', () => {
    const t = sampleTranscript();
    const out = projectContext(t, { ...DEFAULT_CONTEXT_POLICY, history: 'full', toolResults: 'full' });
    expect(out.messages).toHaveLength(t.length);
    expect(out.stats.truncatedToolResults).toBe(0);
  });

  it('does not mutate the input transcript', () => {
    const t = sampleTranscript();
    const snapshot = JSON.stringify(t);
    projectContext(t, { ...DEFAULT_CONTEXT_POLICY, toolResults: 'summary-only' });
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

describe('projectContext — summary mode', () => {
  it('produces a deterministic digest message plus a small recent window', () => {
    const out = projectContext(sampleTranscript(), KRAKEN_EXPLORE_POLICY);
    expect(out.stats.digest).toBe(true);
    const digestMsg = out.messages.find((m) =>
      m.content.startsWith('[Context digest'),
    );
    expect(digestMsg).toBeDefined();
    expect(digestMsg!.content).toContain('user: first task');
    expect(digestMsg!.content).toContain('assistant (tools: read_file)');
  });

  it('renderHistoryDigest is stable for the same units', () => {
    const t = sampleTranscript();
    const a = renderHistoryDigest([
      { messages: [user('x')], kind: 'user' },
      {
        messages: [assistantWithTools('z', ['bash']), tool('z-0', 'ok')],
        kind: 'assistant',
      },
    ]);
    const b = renderHistoryDigest([
      { messages: [user('x')], kind: 'user' },
      {
        messages: [assistantWithTools('z', ['bash']), tool('z-0', 'ok')],
        kind: 'assistant',
      },
    ]);
    expect(a).toBe(b);
    expect(a).toContain('- assistant (tools: bash)');
  });
});

describe('projectContext — tool result projection', () => {
  it('truncates oversized results head+tail with a marker', () => {
    const big = 'x'.repeat(50_000);
    const t: AgentMessage[] = [
      { role: 'system', content: 's' },
      user('go'),
      assistantWithTools('t', ['bash']),
      tool('t-0', big),
      user('now'),
    ];
    const out = projectContext(t, { ...DEFAULT_CONTEXT_POLICY, maxToolResultChars: 1_000 });
    const toolMsg = out.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('[…tool output truncated by context projection…]');
    expect(toolMsg.content.length).toBeLessThan(1_400);
    expect(toolMsg.content.startsWith('xxx')).toBe(true);
    expect(toolMsg.content.endsWith('xxx')).toBe(true);
    expect(out.stats.truncatedToolResults).toBe(1);
  });

  it('summary-only keeps just the first line + char count', () => {
    const t: AgentMessage[] = [
      { role: 'system', content: 's' },
      user('go'),
      assistantWithTools('t', ['bash']),
      tool('t-0', 'first line of output\nsecond line\nthird'),
      user('now'),
    ];
    const out = projectContext(t, {
      ...DEFAULT_CONTEXT_POLICY,
      toolResults: 'summary-only',
    });
    const toolMsg = out.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toBe(
      '[tool result — 38 chars, first line] first line of output',
    );
    expect(toolMsg.content).not.toContain('second line');
  });

  it('counts estimated tokens and reports stats', () => {
    const out = projectContext(sampleTranscript(), DEFAULT_CONTEXT_POLICY);
    expect(out.stats.estimatedTokens).toBeGreaterThan(0);
    expect(out.stats.includedMessages).toBe(out.messages.length);
  });
});
