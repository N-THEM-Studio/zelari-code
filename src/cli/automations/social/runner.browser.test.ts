/**
 * runner.browser.test.ts — the F3.2 publish-mode mapping in the runner, driven
 * by an injected adapter factory (no browser). Pins the P1 exit-code contract:
 * a relogin-required session is UNPROVEN (exit 4), a step failure is FAILED (1).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listRuns, upsertAutomation } from '../registry.js';
import { PublishStepError, ReloginRequiredError } from '../browser/publisher.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { AutomationSpec, SocialPostSpec } from '../types.js';
import { runSocialPost } from './runner.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-rbr-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function browserSpec(id: string, over: Partial<SocialPostSpec> = {}): AutomationSpec {
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
      requireApproval: false,
      publishMode: 'browser',
      ...over,
    },
  };
}

const adapterThatThrows = (err: Error): { createAdapter: () => ChannelAdapter } => ({
  createAdapter: () => ({
    id: 'x',
    async publish() {
      throw err;
    },
  }),
});

describe('runSocialPost — browser publish mapping', () => {
  it('maps ReloginRequiredError → relogin_required, exit 4 (unproven, not failed)', async () => {
    const spec = browserSpec('xr');
    await upsertAutomation(root, spec);

    const code = await runSocialPost(root, spec, adapterThatThrows(new ReloginRequiredError('x')));
    expect(code).toBe(4);

    const run = (await listRuns(root, 'xr'))[0];
    expect(run.status).toBe('relogin_required');
    expect(run.reason).toBe('relogin_required');
    expect(run.exitCode).toBe(4);
    expect(run.posts?.[0]).toMatchObject({ channel: 'x', ok: false, error: 'relogin_required' });
  });

  it('maps a step error → failed, exit 1, with the failing step in the error', async () => {
    const spec = browserSpec('xs');
    await upsertAutomation(root, spec);

    const code = await runSocialPost(root, spec, adapterThatThrows(new PublishStepError('post-button', 'not found')));
    expect(code).toBe(1);

    const run = (await listRuns(root, 'xs'))[0];
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.posts?.[0].ok).toBe(false);
    expect(run.posts?.[0].error).toMatch(/post-button/);
  });

  it('records the evidence screenshot path on a successful browser publish', async () => {
    const spec = browserSpec('xo');
    await upsertAutomation(root, spec);
    const deps = {
      createAdapter: (): ChannelAdapter => ({
        id: 'x',
        async publish() {
          return {
            postId: '111',
            url: 'https://x.com/me/status/111',
            dryRun: false,
            screenshotPath: '.zelari/automations/runs/xo/R/evidence-x.png',
          };
        },
      }),
    };
    expect(await runSocialPost(root, spec, deps)).toBe(0);
    const run = (await listRuns(root, 'xo'))[0];
    expect(run.status).toBe('completed');
    expect(run.posts?.[0].screenshot).toBe('.zelari/automations/runs/xo/R/evidence-x.png');
  });
});
