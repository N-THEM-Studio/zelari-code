import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const planTaskGraphMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/cli/kraken/planner.js', async (importOriginal) => {
  // K3.4: only the planner CALL is stubbed — the fallback gate/digest stay the
  // real implementations, so the env contract under test is production's.
  const actual = await importOriginal<typeof import('../../src/cli/kraken/planner.js')>();
  return { ...actual, planTaskGraph: (...args: unknown[]) => planTaskGraphMock(...args) };
});

vi.mock('../../src/cli/kraken/executor.js', () => ({
  isKrakenGraphEnabled: () => process.env.ZELARI_KRAKEN_GRAPH !== '0',
  KrakenGraphExecutor: class {
    execute(...args: unknown[]) {
      return executeMock(...args);
    }
  },
}));

vi.mock('../../src/cli/toolRegistry.js', () => ({
  createKrakenSubAgentContextFactory: () => async () => null,
}));

vi.mock('../../src/cli/safety/auditLogger.js', () => ({
  AuditLogger: class {},
}));

import {
  handleKrakenGraph,
  type KrakenGraphSlashContext,
} from '../../src/cli/slashHandlers/krakenGraph.js';

function fakeSetMessages() {
  const messages: string[] = [];
  const setMessages = (updater: unknown) => {
    if (typeof updater === 'function') {
      const next = (updater as (prev: unknown[]) => Array<{ content: string }>)([]);
      messages.push(...next.map((m) => m.content));
    }
  };
  return { setMessages, messages };
}

describe('handleKrakenGraph', () => {
  beforeEach(() => {
    planTaskGraphMock.mockReset();
    executeMock.mockReset();
    delete process.env.ZELARI_KRAKEN_GRAPH;
    delete process.env.ZELARI_KRAKEN_PLANNER_FALLBACK;
  });
  afterEach(() => {
    delete process.env.ZELARI_KRAKEN_GRAPH;
    delete process.env.ZELARI_KRAKEN_PLANNER_FALLBACK;
  });

  it('prints usage and does nothing for an empty prompt', async () => {
    const { setMessages, messages } = fakeSetMessages();
    await handleKrakenGraph({ setMessages, cwd: '/tmp/repo', sessionId: 's1' }, '   ');
    expect(planTaskGraphMock).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes('Usage: /kraken graph'))).toBe(true);
  });

  it('refuses to run when ZELARI_KRAKEN_GRAPH=0', async () => {
    process.env.ZELARI_KRAKEN_GRAPH = '0';
    const { setMessages, messages } = fakeSetMessages();
    await handleKrakenGraph({ setMessages, cwd: '/tmp/repo', sessionId: 's1' }, 'do the thing');
    expect(planTaskGraphMock).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes('disabled'))).toBe(true);
  });

  it('plans then executes and reports convergence', async () => {
    const fakeGraph = { id: 'g1', nodes: new Map() };
    planTaskGraphMock.mockResolvedValue(fakeGraph);
    executeMock.mockResolvedValue({
      graph: fakeGraph,
      converged: true,
      failedNodeIds: [],
      counts: {},
    });

    const { setMessages, messages } = fakeSetMessages();
    await handleKrakenGraph({ setMessages, cwd: '/tmp/repo', sessionId: 's1' }, 'fix the bug');

    expect(planTaskGraphMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'fix the bug' }),
    );
    expect(executeMock).toHaveBeenCalled();
    expect(messages.some((m) => m.includes('converged'))).toBe(true);
  });

  it('reports non-convergence with failed node ids', async () => {
    const fakeGraph = { id: 'g1', nodes: new Map() };
    planTaskGraphMock.mockResolvedValue(fakeGraph);
    executeMock.mockResolvedValue({
      graph: fakeGraph,
      converged: false,
      failedNodeIds: ['g1n'],
      counts: {},
    });

    const { setMessages, messages } = fakeSetMessages();
    await handleKrakenGraph({ setMessages, cwd: '/tmp/repo', sessionId: 's1' }, 'fix the bug');

    expect(messages.some((m) => m.includes('did not converge') && m.includes('g1n'))).toBe(true);
  });

  it('reports a planner error without throwing', async () => {
    planTaskGraphMock.mockRejectedValue(new Error('LLM HTTP 500'));

    const { setMessages, messages } = fakeSetMessages();
    await expect(
      handleKrakenGraph({ setMessages, cwd: '/tmp/repo', sessionId: 's1' }, 'fix the bug'),
    ).resolves.toBeUndefined();

    expect(messages.some((m) => m.includes('graph run failed') && m.includes('LLM HTTP 500'))).toBe(
      true,
    );
  });

  it('K3.4: planner throw + flag=1 reports the fallback instead of a run failure', async () => {
    planTaskGraphMock.mockRejectedValue(new Error('LLM HTTP 500'));
    process.env.ZELARI_KRAKEN_PLANNER_FALLBACK = '1';

    const { setMessages, messages } = fakeSetMessages();
    await handleKrakenGraph({ setMessages, cwd: '/tmp/repo', sessionId: 's1' }, 'fix the bug');

    expect(messages.some((m) => m.includes('falling back to single-agent'))).toBe(true);
    expect(messages.some((m) => m.includes('LLM HTTP 500'))).toBe(true);
    expect(messages.some((m) => m.includes('graph run failed'))).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('K3.4: flag=1 hands the prompt to the host single-agent runner and notes the spine', async () => {
    planTaskGraphMock.mockRejectedValue(new Error('LLM HTTP 500'));
    process.env.ZELARI_KRAKEN_PLANNER_FALLBACK = '1';

    const fallback = vi.fn(async () => undefined);
    const note = vi.fn();
    const { setMessages, messages } = fakeSetMessages();
    const ctx = {
      setMessages,
      cwd: '/tmp/repo',
      sessionId: 's1',
      fallbackToSingleAgent: fallback,
      // The spine is optional (tests/detached writer): stub the note seam.
      writerRef: { current: { spine: { note } } },
    } as unknown as KrakenGraphSlashContext;

    await handleKrakenGraph(ctx, 'fix the bug');

    expect(fallback).toHaveBeenCalledWith('fix the bug');
    expect(note).toHaveBeenCalledWith(
      'kraken.planner_fallback',
      expect.objectContaining({ reason: 'LLM HTTP 500', digest: 'LLM HTTP 500' }),
    );
    expect(messages.some((m) => m.includes('falling back to single-agent'))).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
