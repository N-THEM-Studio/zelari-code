/**
 * planTaskGraph's DEFAULT LLM transport (createDefaultLlmClient, internal to
 * planner.ts — exercised here via planTaskGraph without an injected
 * llmClient, with `fetch` mocked).
 *
 * Regression coverage for a real failure: "kraken planner: failed to
 * produce a valid task graph after 2 attempts — Empty model response" on a
 * long/complex prompt against a reasoning-capable model. Root cause: a
 * 4096 max_tokens ceiling let the model exhaust its budget on
 * chain-of-thought (reasoning_content) before ever emitting the JSON
 * answer in `message.content`, and the retry loop couldn't help since it
 * repeats the same truncation. Fixed by raising the default budget
 * (configurable via ZELARI_KRAKEN_PLANNER_MAX_TOKENS), falling back to a
 * JSON object found inside `reasoning_content` when `content` is empty,
 * and surfacing `finish_reason` in the error when both are empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/cli/providerConfig.js', () => ({
  getProviderConfig: vi.fn(() => ({ activeProviderId: 'deepseek' })),
  getModelForProvider: vi.fn(() => 'deepseek-v4-flash'),
}));

vi.mock('../../src/cli/keyStore.js', () => ({
  resolveApiKeyWithMeta: vi.fn(async () => ({ apiKey: 'test-key' })),
}));

vi.mock('../../src/cli/provider/openai-compatible.js', () => ({
  resolveBaseUrl: vi.fn(() => 'https://api.deepseek.test/v1'),
}));

import { planTaskGraph } from '../../src/cli/kraken/planner.js';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const VALID_GRAPH_JSON = JSON.stringify({
  nodes: [{ id: 'e1', kind: 'explore', label: 'research', prompt: 'find stuff', deps: [] }],
});

describe('planTaskGraph — default LLM transport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.ZELARI_KRAKEN_PLANNER_MAX_TOKENS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a generous default max_tokens so a reasoning-heavy response is not truncated', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: VALID_GRAPH_JSON } }] }),
    );

    await planTaskGraph({ prompt: 'build a complex naval game with an ocean shader' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it('respects ZELARI_KRAKEN_PLANNER_MAX_TOKENS when set', async () => {
    process.env.ZELARI_KRAKEN_PLANNER_MAX_TOKENS = '16000';
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: VALID_GRAPH_JSON } }] }),
    );

    await planTaskGraph({ prompt: 'goal' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBe(16000);
  });

  it('falls back to a JSON object found inside reasoning_content when content is empty', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: '',
              reasoning_content: `Let me think about this... ${VALID_GRAPH_JSON}`,
            },
            finish_reason: 'length',
          },
        ],
      }),
    );

    const graph = await planTaskGraph({ prompt: 'goal' });

    expect(graph.nodes.has('e1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // recovered without needing a retry
  });

  it('surfaces finish_reason in the error when both content and reasoning_content are empty', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: {}, finish_reason: 'length' }] }),
    );

    await expect(planTaskGraph({ prompt: 'goal' })).rejects.toThrow(/finish_reason=length/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // both attempts exhausted
  });
});
