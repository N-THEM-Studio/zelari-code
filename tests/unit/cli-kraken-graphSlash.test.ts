import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const planTaskGraphMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/cli/kraken/planner.js', () => ({
  planTaskGraph: (...args: unknown[]) => planTaskGraphMock(...args),
}));

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

import { handleKrakenGraph } from '../../src/cli/slashHandlers/krakenGraph.js';

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
  });
  afterEach(() => {
    delete process.env.ZELARI_KRAKEN_GRAPH;
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
});
