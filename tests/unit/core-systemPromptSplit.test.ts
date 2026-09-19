import { describe, it, expect } from 'vitest';
import {
  buildSystemPromptSplit,
  systemMessagesFromSplit,
  buildSystemPrompt,
  assembleRequestMessages,
  trailingContextFromSplit,
  trailingContextMessagesFromSplit,
  wrapTrailingContext,
  isTrailingContextContent,
  resolvePromptLayout,
  resetPromptLayoutCache,
} from '../../packages/core/src/agents/systemPromptBuilder.js';
import type { EnhancedToolDefinition } from '../../packages/core/src/types/systemTypes.js';
import { SINGLE_AGENT_IDENTITY_MODULE } from '../../packages/core/src/agents/promptModules.js';

const agent = {
  id: 'single',
  name: 'Zelari',
  codename: 'zelari',
  role: 'coder',
  color: '#000',
  avatar: 'x',
  tools: [] as string[],
  systemPrompt: 'You are stable role text.',
};

const tools: EnhancedToolDefinition[] = [];

describe('buildSystemPromptSplit', () => {
  it('keeps workspace/RAG/durable state out of stable', () => {
    const split = buildSystemPromptSplit(agent, {
      tools,
      toolNames: [],
      mode: 'kraken',
      aiConfig: {
        enabledSkills: [],
        enabledTools: [],
        customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
        agentSkillConfigs: [],
      },
      workspaceContext: 'PLAN OPS volatile-plan-xyz',
      ragContext: 'memory hit volatile-rag-abc',
      durableStateContext: 'commit deadbeef verified',
    });

    expect(split.stable).toContain('stable role text');
    expect(split.stable).not.toContain('volatile-plan-xyz');
    expect(split.stable).not.toContain('volatile-rag-abc');
    expect(split.stable).not.toContain('deadbeef');

    expect(split.volatile).toContain('volatile-plan-xyz');
    expect(split.volatile).toContain('volatile-rag-abc');
    expect(split.volatile).toContain('deadbeef');
  });

  it('stable is unchanged when only volatile inputs change', () => {
    const baseOpts = {
      tools,
      toolNames: [] as string[],
      mode: 'kraken' as const,
      aiConfig: {
        enabledSkills: [] as string[],
        enabledTools: [] as string[],
        customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
        agentSkillConfigs: [],
      },
    };
    const a = buildSystemPromptSplit(agent, {
      ...baseOpts,
      workspaceContext: 'ws-1',
    });
    const b = buildSystemPromptSplit(agent, {
      ...baseOpts,
      workspaceContext: 'ws-2-totally-different',
      durableStateContext: 'new state',
    });
    expect(a.stable).toBe(b.stable);
    expect(a.volatile).not.toBe(b.volatile);
  });

  it('systemMessagesFromSplit defaults to stable-only (M2.1 cache-first layout)', () => {
    const msgs = systemMessagesFromSplit({
      stable: 'STABLE_PART',
      volatile: 'VOLATILE_PART',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('STABLE_PART');
  });

  it('systemMessagesFromSplit keeps the pre-M2 [stable, volatile] shape with includeVolatile', () => {
    const msgs = systemMessagesFromSplit(
      { stable: 'STABLE_PART', volatile: 'VOLATILE_PART' },
      { includeVolatile: true },
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('STABLE_PART');
    expect(msgs[1].content).toBe('VOLATILE_PART');
  });

  it('systemMessagesFromSplit keeps single-system concatenation for both parts', () => {
    const msgs = systemMessagesFromSplit(
      { stable: 'STABLE_PART', volatile: 'VOLATILE_PART' },
      { singleSystem: true, includeVolatile: true },
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('STABLE_PART\n\n---\n\nVOLATILE_PART');
  });

  it('buildSystemPrompt concatenates with stable first', () => {
    const full = buildSystemPrompt(agent, {
      tools,
      toolNames: [],
      mode: 'kraken',
      workspaceContext: 'VOL_WS',
      aiConfig: {
        enabledSkills: [],
        enabledTools: [],
        customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
        agentSkillConfigs: [],
      },
    });
    const stableIdx = full.indexOf('stable role text');
    const volIdx = full.indexOf('VOL_WS');
    expect(stableIdx).toBeGreaterThanOrEqual(0);
    expect(volIdx).toBeGreaterThan(stableIdx);
  });
});

/**
 * M2.1 (cache-hit-rate plan) — request layout contract.
 * The volatile segment must travel AFTER the history so a workspace / plan /
 * RAG change busts only the request tail, never the cached system prefix.
 */
describe('assembleRequestMessages — cache-first layout (M2.1)', () => {
  const split = { stable: 'STABLE_PROMPT', volatile: 'VOLATILE_WORKSPACE' };
  const history = [
    { role: 'user' as const, content: 'turn-1 question' },
    { role: 'assistant' as const, content: 'turn-1 answer' },
  ];
  const turn = [{ role: 'user' as const, content: 'turn-2 question' }];

  it('default (trailing) = [stable system][history][trailing][new turn]', () => {
    const { messages, systemCount, trailingCount } = assembleRequestMessages({
      split,
      history,
      turn,
      layout: 'trailing',
    });
    expect(systemCount).toBe(1);
    expect(trailingCount).toBe(1);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect(messages[0].content).toBe('STABLE_PROMPT');
    expect(messages[1].content).toBe('turn-1 question');
    expect(messages[2].content).toBe('turn-1 answer');
    expect(messages[3].content).toBe(
      '<context-update>\nVOLATILE_WORKSPACE\n</context-update>',
    );
    expect(messages[4].content).toBe('turn-2 question');
    // The volatile text is byte-identical to the builder output — only its
    // POSITION changed. No instruction text is added by the wrapper.
    expect(messages.some((m) => m.content === 'VOLATILE_WORKSPACE')).toBe(false);
  });

  it('legacy = [stable, volatile system][history][new turn] (pre-M2 rollback)', () => {
    const { messages, systemCount, trailingCount } = assembleRequestMessages({
      split,
      history,
      turn,
      layout: 'legacy',
    });
    expect(systemCount).toBe(2);
    expect(trailingCount).toBe(0);
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'user']);
    expect(messages[0].content).toBe('STABLE_PROMPT');
    expect(messages[1].content).toBe('VOLATILE_WORKSPACE');
    expect(messages[4].content).toBe('turn-2 question');
  });

  it('adds no trailing message when the volatile segment is empty', () => {
    const { messages, trailingCount } = assembleRequestMessages({
      split: { stable: 'STABLE_PROMPT', volatile: '   ' },
      history,
      turn,
      layout: 'trailing',
    });
    expect(trailingCount).toBe(0);
    expect(messages).toHaveLength(4);
  });

  it('trailing render is byte-identical for identical inputs (M2.3 determinism)', () => {
    const first = assembleRequestMessages({ split, history, turn, layout: 'trailing' });
    const second = assembleRequestMessages({ split, history, turn, layout: 'trailing' });
    const trailingOf = (ms: Array<{ content: string }>): string =>
      ms[ms.length - 2].content;
    expect(trailingOf(first.messages)).toBe(trailingOf(second.messages));
    // No unquantized clock/random source leaks into the volatile segment.
    expect(trailingOf(first.messages)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('ZELARI_PROMPT_LAYOUT=legacy flips the layout read (frozen once per process)', () => {
    resetPromptLayoutCache();
    try {
      process.env.ZELARI_PROMPT_LAYOUT = 'legacy';
      expect(resolvePromptLayout()).toBe('legacy');
      // Frozen: a later env change must NOT flip the layout mid-session.
      process.env.ZELARI_PROMPT_LAYOUT = 'trailing';
      expect(resolvePromptLayout()).toBe('legacy');
    } finally {
      delete process.env.ZELARI_PROMPT_LAYOUT;
      resetPromptLayoutCache();
    }
    expect(resolvePromptLayout()).toBe('trailing');
    expect(resolvePromptLayout({ ZELARI_PROMPT_LAYOUT: 'anything-else' })).toBe('trailing');
  });

  it('recognises the ephemeral trailing message by its stable tag', () => {
    const trailing = trailingContextMessagesFromSplit(split);
    expect(trailing).toHaveLength(1);
    expect(isTrailingContextContent(trailing[0].content)).toBe(true);
    expect(isTrailingContextContent('plain user turn')).toBe(false);
    expect(isTrailingContextContent('')).toBe(false);
    // A user turn merely mentioning the tag is not mistaken for one.
    expect(isTrailingContextContent('see the <context-update> block')).toBe(false);
  });
});

/**
 * M2.3 (cache-hit-rate plan) — trailing determinism audit.
 *
 * Same inputs ⇒ byte-identical trailing body, so a warm prefix stays warm.
 * The volatile segment is composed by the CALLERS (workspace / plan / RAG /
 * durable state) and reaches this module as an opaque string: the render is
 * pure plus a one-entry memo, and the allowlist below fails the test if a
 * caller ever starts leaking an unquantized clock or a random id.
 *
 * Audit evidence (grep of the composers, 2026-09-19):
 *   - buildPlanSummary renders `[status/priority] name → path` only — plan task
 *     timestamps (`updatedAt` / `completedAt` / `[task-guard <ISO>]` notes) live
 *     in .zelari/plan.json but never reach the prompt.
 *   - buildWorkspaceSummary / composeContext.ts contain no Date.now / new Date /
 *     randomUUID / Math.random at all.
 *   - worldModel.ts writes ISO timestamps, but only to .zelari/world/* artifacts
 *     (never to the volatile prompt segment).
 */
describe('trailing context determinism (M2.3)', () => {
  const split = { stable: 'STABLE_PROMPT', volatile: 'VOLATILE_WORKSPACE_V1' };
  const baseOpts = {
    tools,
    toolNames: [] as string[],
    mode: 'kraken' as const,
    aiConfig: {
      enabledSkills: [] as string[],
      enabledTools: [] as string[],
      customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
      agentSkillConfigs: [],
    },
  };

  it('two renders of identical inputs are byte-identical', () => {
    const a = buildSystemPromptSplit(agent, { ...baseOpts, workspaceContext: 'ws-1' });
    const b = buildSystemPromptSplit(agent, { ...baseOpts, workspaceContext: 'ws-1' });
    expect(a.volatile).toBe(b.volatile);
    expect(trailingContextFromSplit(a)).toBe(trailingContextFromSplit(b));
    // The memo seam is not required for correctness (the render is pure), but it
    // must never hand back a mutated string either.
    expect(wrapTrailingContext('ws-1')).toBe(wrapTrailingContext('ws-1'));
  });

  it('volatile carries no unquantized clock / random id (explicit allowlist)', () => {
    const rendered = buildSystemPromptSplit(agent, {
      ...baseOpts,
      workspaceContext: 'ws-1',
      ragContext: 'memory hit',
      durableStateContext: 'commit deadbeef verified',
    });
    // ALLOWED: day-quantized dates (YYYY-MM-DD) — none today.
    // FORBIDDEN: any time-of-day precision (minute/second ISO, epoch ms).
    expect(rendered.volatile).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(rendered.volatile).not.toMatch(/\b1[6-9]\d{11}\b/);
    expect(rendered.volatile).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });

  it('the trailing body is exactly the volatile text (position-only change)', () => {
    const rendered = buildSystemPromptSplit(agent, { ...baseOpts, workspaceContext: 'ws-1' });
    const trailing = wrapTrailingContext(rendered.volatile);
    const inner = trailing
      .replace('<context-update>\n', '')
      .replace('\n</context-update>', '');
    expect(inner).toBe(rendered.volatile.trim());
  });

  it('emulating 3 turns: the trailing never accumulates in the carried history', () => {
    // Mirror of the useChatTurn / headless seed slicing: systemCount + carried
    // history + trailingCount + the current user turn are dropped before the
    // assistant reply is appended to the rolling history.
    type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };
    let history: Msg[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      const assembled = assembleRequestMessages({
        split,
        history,
        turn: [{ role: 'user', content: `q${turn}` }],
        layout: 'trailing',
      });
      const seeded: Msg[] = [
        ...(assembled.messages as Msg[]),
        { role: 'assistant', content: `a${turn}` },
      ];
      const seedLen = assembled.systemCount + history.length + assembled.trailingCount + 1;
      history = [...history, ...seeded.slice(seedLen)];
      // Invariant: no trailing context survives into the next turn's history.
      expect(history.some((m) => isTrailingContextContent(m.content))).toBe(false);
    }
    // 3 turns ⇒ exactly 3 carried assistant turns, zero volatile copies.
    expect(history.map((m) => m.content)).toEqual(['a1', 'a2', 'a3']);
  });
});
