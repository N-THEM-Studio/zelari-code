/**
 * runner.test.ts — the social_post run state machine (F2). Local tmp dirs only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listRuns, upsertAutomation } from '../registry.js';
import { runSocialPost } from './runner.js';
import type { AutomationSpec, SocialPostSpec } from '../types.js';

// The LLM path is driven by an injected `complete` seam; still stub resolveLlm
// so no config file / network is ever touched.
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

const resolveLlmMock = vi.mocked(resolveLlm);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-srun-'));
  resolveLlmMock.mockReset();
  resolveLlmMock.mockImplementation(async (o: { provider?: string; model?: string }) => ({
    provider: o?.provider ?? 'glm',
    model: o?.model ?? 'glm-4.6',
    apiKey: 'k',
    baseUrl: 'https://glm.test/v1',
  }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function social(id: string, over: Partial<SocialPostSpec> = {}): AutomationSpec {
  return {
    id,
    name: id,
    enabled: true,
    kind: 'social_post',
    schedule: { timezone: 'Europe/Rome' },
    budget: { maxCostUsd: 1 },
    social_post: {
      channels: ['x'],
      topicOrBrief: 'hello world',
      requireApproval: true,
      approvalTtlMin: 1440,
      ...over,
    },
  };
}

describe('runSocialPost', () => {
  it('(a) requireApproval → awaiting_approval, exit 4', async () => {
    const spec = social('aa', { requireApproval: true });
    await upsertAutomation(root, spec);
    expect(await runSocialPost(root, spec)).toBe(4);

    const runs = await listRuns(root, 'aa');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('awaiting_approval');
    expect(runs[0].exitCode).toBe(4);
    expect(runs[0].expiresAt).toBeTruthy();
    expect(runs[0].draft?.text).toBe('hello world');
    expect(runs[0].posts).toBeUndefined();
  });

  it('(b) requireApproval:false → dry-run publish, completed + exit 0', async () => {
    const spec = social('bb', { requireApproval: false, channels: ['x', 'facebook'] });
    await upsertAutomation(root, spec);
    expect(await runSocialPost(root, spec)).toBe(0);

    const run = (await listRuns(root, 'bb'))[0];
    expect(run.status).toBe('completed');
    expect(run.exitCode).toBe(0);
    expect(run.posts).toHaveLength(2);
    for (const p of run.posts ?? []) {
      expect(p.ok).toBe(true);
      expect(p.url).toBeTruthy();
      expect(p.dryRun).toBe(true);
      expect(p.url).toContain('dry-run');
    }
  });

  it('(f) maxPostsPerDay → the next run is skipped, exit 0', async () => {
    const spec = social('ff', { requireApproval: false, maxPostsPerDay: 1 });
    await upsertAutomation(root, spec);

    expect(await runSocialPost(root, spec)).toBe(0); // publishes → completed
    expect(await runSocialPost(root, spec)).toBe(0); // over the cap → skipped

    const runs = await listRuns(root, 'ff');
    expect(runs).toHaveLength(2);
    const skipped = runs.filter((r) => r.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('max_posts_per_day');
    expect(runs.some((r) => r.status === 'completed')).toBe(true);
  });

  it('(g) unknown channel → failed, exit 1', async () => {
    const spec = social('gg', { requireApproval: false, channels: ['mastodon'] });
    await upsertAutomation(root, spec);
    expect(await runSocialPost(root, spec)).toBe(1);

    const run = (await listRuns(root, 'gg'))[0];
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.posts?.[0].ok).toBe(false);
    expect(run.posts?.[0].error).toMatch(/unknown channel: mastodon/);
  });

  it('(h) prompt set → LLM draft via seam; model forwarded; generatedBy llm', async () => {
    const spec = social('hh', { prompt: 'Draft about {{brief}}', topicOrBrief: 'release notes' });
    spec.model = { provider: 'glm', id: 'glm-5.3' };
    await upsertAutomation(root, spec);
    const complete = vi.fn(async (_llm, req: { system: string; user: string }) => {
      expect(req.user).toContain('release notes');
      return { text: 'the generated post' };
    });

    expect(await runSocialPost(root, spec, { complete })).toBe(4); // requireApproval default
    expect(complete).toHaveBeenCalledTimes(1);
    expect(resolveLlmMock).toHaveBeenCalledWith({ provider: 'glm', model: 'glm-5.3' });

    const run = (await listRuns(root, 'hh'))[0];
    expect(run.draft?.text).toBe('the generated post');
    expect(run.draft?.generatedBy).toEqual({
      source: 'llm',
      provider: 'glm',
      model: 'glm-5.3',
    });
  });

  it('(i) LLM failure → failed + reason llm_* + exit 1, draft absent', async () => {
    const spec = social('ii', { prompt: 'Draft a post', topicOrBrief: 'x' });
    await upsertAutomation(root, spec);
    const complete = vi.fn(async () => {
      throw new Error('boom');
    });

    expect(await runSocialPost(root, spec, { complete })).toBe(1);

    const run = (await listRuns(root, 'ii'))[0];
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.reason).toBe('llm_error:boom');
    expect(run.draft).toBeUndefined();
  });

  it('(i2) LLM no-key failure → reason llm_no_api_key:<provider>, draft absent', async () => {
    const spec = social('ik', { prompt: 'Draft a post', topicOrBrief: 'x' });
    await upsertAutomation(root, spec);
    resolveLlmMock.mockRejectedValueOnce(
      new Error("No API key for provider 'glm'. Save a key in Settings → Provider."),
    );

    expect(await runSocialPost(root, spec, { complete: vi.fn() })).toBe(1);
    const run = (await listRuns(root, 'ik'))[0];
    expect(run.reason).toBe('llm_no_api_key:glm');
    expect(run.draft).toBeUndefined();
  });

  it('(j) usage is surfaced as an llm_usage_tokens warning', async () => {
    const spec = social('jj', { prompt: 'Draft a post', topicOrBrief: 'x' });
    await upsertAutomation(root, spec);
    const complete = vi.fn(async () => ({ text: 'ok post', usage: { totalTokens: 42 } }));

    await runSocialPost(root, spec, { complete });
    const run = (await listRuns(root, 'jj'))[0];
    expect(run.draft?.warnings).toContain('llm_usage_tokens:42');
    expect(run.draft?.generatedBy?.source).toBe('llm');
  });

  it('(k) no prompt → static path, seam never called, generatedBy static', async () => {
    const spec = social('kk', { topicOrBrief: 'static text' });
    await upsertAutomation(root, spec);
    const complete = vi.fn();

    await runSocialPost(root, spec, { complete });
    expect(complete).not.toHaveBeenCalled();
    const run = (await listRuns(root, 'kk'))[0];
    expect(run.draft?.text).toBe('static text');
    expect(run.draft?.generatedBy).toEqual({ source: 'static' });
  });
});
