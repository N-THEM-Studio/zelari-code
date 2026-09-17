/**
 * generate.test.ts — LLM draft generation (offline). The one-shot helper is
 * mocked; the completion seam is faked, so no request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SocialPostSpec } from '../types.js';

vi.mock('../../llm/oneShot.js', () => ({
  resolveLlm: vi.fn(async (o: { provider?: string; model?: string }) => ({
    provider: o?.provider ?? 'glm',
    model: o?.model ?? 'glm-4.6',
    apiKey: 'k',
    baseUrl: 'https://glm.test/v1',
  })),
  chatCompletion: vi.fn(),
}));

import { resolveLlm } from '../../llm/oneShot.js';
import {
  buildMessages,
  generateDraftWithLlm,
  LlmDraftError,
  SOCIAL_SYSTEM_PROMPT,
} from './generate.js';

const resolveLlmMock = vi.mocked(resolveLlm);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-gen-'));
  resolveLlmMock.mockResolvedValue({
    provider: 'glm',
    model: 'glm-4.6',
    apiKey: 'k',
    baseUrl: 'https://glm.test/v1',
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function spec(over: Partial<SocialPostSpec> = {}): SocialPostSpec {
  return {
    channels: ['x'],
    topicOrBrief: '',
    requireApproval: true,
    approvalTtlMin: 1440,
    ...over,
  };
}

describe('buildMessages', () => {
  it('substitutes {{brief}} / {{topic}} placeholders', () => {
    const { user } = buildMessages(
      spec({ prompt: 'Write about {{brief}} and {{topic}}.' }),
      'AI agents',
      'Write about {{brief}} and {{topic}}.',
    );
    expect(user).toContain('Write about AI agents and AI agents.');
    expect(user).not.toContain('Brief:');
  });

  it('appends the brief as a context block when no placeholder is present', () => {
    const { user } = buildMessages(
      spec({ prompt: 'Draft a launch post.' }),
      'New feature',
      'Draft a launch post.',
    );
    expect(user).toContain('Draft a launch post.');
    expect(user).toContain('Brief:\nNew feature');
  });

  it('uses the resolved prompt text (file content) verbatim', () => {
    const { user } = buildMessages(
      spec({ prompt: 'prompt.md' }),
      'ignored',
      'FILE INSTRUCTIONS',
    );
    expect(user).toContain('FILE INSTRUCTIONS');
    expect(user).not.toContain('prompt.md');
  });

  it('includes tone and target channels when set', () => {
    const { user } = buildMessages(
      spec({ prompt: 'Say hi.', tone: 'witty', channels: ['x', 'facebook'] }),
      'brief',
      'Say hi.',
    );
    expect(user).toContain('Tone: witty');
    expect(user).toContain('Target channels: x, facebook');
  });

  it('falls back to a default instruction when the prompt is blank', () => {
    const { system, user } = buildMessages(spec(), 'the brief');
    expect(system).toBe(SOCIAL_SYSTEM_PROMPT);
    expect(user).toContain('brief below');
    expect(user).toContain('Brief:\nthe brief');
  });
});

describe('generateDraftWithLlm', () => {
  it('returns the model text tagged generatedBy:{source:llm} with usage', async () => {
    const complete = vi.fn(async () => ({ text: 'Generated post', usage: { totalTokens: 12 } }));
    const draft = await generateDraftWithLlm({
      spec: spec({ prompt: 'Draft a post about {{brief}}', topicOrBrief: 'topic x' }),
      root,
      modelRef: { provider: 'glm', id: 'm1' },
      complete,
    });

    expect(draft.text).toBe('Generated post');
    expect(draft.generatedBy).toEqual({ source: 'llm', provider: 'glm', model: 'glm-4.6' });
    expect(draft.usage).toEqual({ totalTokens: 12 });
    // The model id from the spec is forwarded to resolveLlm.
    expect(resolveLlmMock).toHaveBeenCalledWith({ provider: 'glm', model: 'm1' });
    const req = complete.mock.calls[0]![1] as { system: string; user: string };
    expect(req.system).toBe(SOCIAL_SYSTEM_PROMPT);
    expect(req.user).toContain('topic x');
  });

  it('reads the prompt from a file and substitutes the brief', async () => {
    await writeFile(path.join(root, 'prompt.md'), 'Post about {{brief}}.', 'utf-8');
    let seenUser = '';
    const complete = vi.fn(async (_llm, req: { user: string }) => {
      seenUser = req.user;
      return { text: 'done' };
    });
    await generateDraftWithLlm({
      spec: spec({ prompt: 'prompt.md', topicOrBrief: 'cats' }),
      root,
      complete,
    });
    expect(seenUser).toContain('Post about cats.');
  });

  it('maps a missing API key to llm_no_api_key:<provider>', async () => {
    resolveLlmMock.mockRejectedValueOnce(
      new Error("No API key for provider 'glm'. Save a key in Settings → Provider."),
    );
    await expect(
      generateDraftWithLlm({ spec: spec({ prompt: 'x' }), root, complete: vi.fn() }),
    ).rejects.toMatchObject({ reason: 'llm_no_api_key:glm' });
  });

  it('maps a missing model to llm_no_model', async () => {
    resolveLlmMock.mockRejectedValueOnce(new Error("No model selected for provider 'glm'"));
    await expect(
      generateDraftWithLlm({ spec: spec({ prompt: 'x' }), root, complete: vi.fn() }),
    ).rejects.toMatchObject({ reason: 'llm_no_model' });
  });

  it('maps a completion error to llm_error:<msg>', async () => {
    const complete = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      generateDraftWithLlm({ spec: spec({ prompt: 'x' }), root, complete }),
    ).rejects.toMatchObject({ reason: 'llm_error:boom' });
  });

  it('maps an empty completion to llm_empty_response', async () => {
    const complete = vi.fn(async () => ({ text: '   ' }));
    await expect(
      generateDraftWithLlm({ spec: spec({ prompt: 'x' }), root, complete }),
    ).rejects.toMatchObject({ reason: 'llm_empty_response' });
  });

  it('validates media + length on the generated text (shared finalizeDraft)', async () => {
    const complete = vi.fn(async () => ({ text: 'a'.repeat(281) }));
    const draft = await generateDraftWithLlm({
      spec: spec({ prompt: 'x', media: { paths: ['gone.png'] } }),
      root,
      complete,
    });
    expect(draft.warnings).toContain('media_missing:gone.png');
    expect(draft.warnings).toContain('text_exceeds_x_limit');
  });

  it('rethrows a LlmDraftError unchanged', async () => {
    const complete = vi.fn(async () => {
      throw new LlmDraftError('llm_custom', 'custom');
    });
    await expect(
      generateDraftWithLlm({ spec: spec({ prompt: 'x' }), root, complete }),
    ).rejects.toMatchObject({ reason: 'llm_custom' });
  });
});

describe('generateDraftWithLlm — researchQuery', () => {
  it('feeds fresh hits into the user message and records draft.research', async () => {
    const research = vi.fn(async () => ({
      ok: true as const,
      provider: 'duckduckgo',
      hits: [
        { title: 'AI news', url: 'https://example.com/1', snippet: 'Big launch' },
        { title: 'More AI', url: 'https://example.com/2', snippet: 'Details here' },
      ],
    }));
    let seenUser = '';
    const complete = vi.fn(async (_llm: unknown, req: { user: string }) => {
      seenUser = req.user;
      return { text: 'post' };
    });
    const draft = await generateDraftWithLlm({
      spec: spec({ prompt: 'x', researchQuery: 'latest AI news' }),
      root,
      complete,
      research,
    });
    expect(research).toHaveBeenCalledWith('latest AI news', 5);
    expect(seenUser).toContain('WEB RESEARCH RESULTS');
    expect(seenUser).toContain('https://example.com/1');
    expect(draft.research).toEqual({ query: 'latest AI news', provider: 'duckduckgo', hits: 2 });
    expect(draft.warnings.join('\n')).not.toContain('research_failed');
  });

  it('degrades to a research_failed warning when the search fails', async () => {
    const research = vi.fn(async () => ({ ok: false as const, error: 'duckduckgo down' }));
    const complete = vi.fn(async () => ({ text: 'post' }));
    const draft = await generateDraftWithLlm({
      spec: spec({ prompt: 'x', researchQuery: 'news', researchMaxResults: 3 }),
      root,
      complete,
      research,
    });
    expect(research).toHaveBeenCalledWith('news', 3);
    expect(draft.warnings).toContain('research_failed:duckduckgo down');
    expect(draft.research).toBeUndefined();
  });

  it('skips the search entirely without researchQuery', async () => {
    const research = vi.fn();
    const complete = vi.fn(async () => ({ text: 'post' }));
    await generateDraftWithLlm({ spec: spec({ prompt: 'x' }), root, complete, research });
    expect(research).not.toHaveBeenCalled();
  });
});
