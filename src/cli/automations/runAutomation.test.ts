/**
 * runAutomation.test.ts — dispatch + evidence persistence.
 *
 * The gardener path spawns the real CLI in production; here it is driven
 * through the documented test seam `ZELARI_AUTOMATION_RUNNER_STUB_EXIT` so no
 * child process is ever launched. social_post is F2 (skipped, exit 4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listRuns, upsertAutomation } from './registry.js';
import { runAutomation } from './runAutomation.js';
import type { AutomationSpec } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-ra-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.ZELARI_AUTOMATION_RUNNER_STUB_EXIT;
});

const SOCIAL: AutomationSpec = {
  id: 'share',
  name: 'Share',
  enabled: true,
  kind: 'social_post',
  schedule: { intervalMin: 60, timezone: 'Europe/Rome' },
  budget: { maxCostUsd: 1 },
  social_post: { channels: ['x'], topicOrBrief: 'hello', requireApproval: true, approvalTtlMin: 1440 },
};

const GARDENER: AutomationSpec = {
  id: 'gardener',
  name: 'Gardener',
  enabled: true,
  kind: 'gardener',
  schedule: { intervalMin: 1440, timezone: 'Europe/Rome' },
  budget: { maxCostUsd: 1 },
};

describe('runAutomation', () => {
  it('social_post requireApproval → awaiting_approval, exit 4', async () => {
    await upsertAutomation(root, SOCIAL);
    const code = await runAutomation(root, 'share');
    expect(code).toBe(4);

    const runs = await listRuns(root, 'share');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('awaiting_approval');
    expect(runs[0].exitCode).toBe(4);
    expect(runs[0].draft?.text).toBe('hello');
    expect(runs[0].expiresAt).toBeDefined();
  });

  it('unknown id → exit 1', async () => {
    expect(await runAutomation(root, 'nope')).toBe(1);
  });

  it('disabled spec → skipped run with reason disabled, exit 4', async () => {
    await upsertAutomation(root, { ...GARDENER, enabled: false });
    const code = await runAutomation(root, 'gardener');
    expect(code).toBe(4);

    const runs = await listRuns(root, 'gardener');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('skipped');
    expect(runs[0].reason).toBe('disabled');
    expect(runs[0].exitCode).toBe(4);
  });

  it('gardener → completed when the (stubbed) child exits 0', async () => {
    process.env.ZELARI_AUTOMATION_RUNNER_STUB_EXIT = '0';
    await upsertAutomation(root, GARDENER);
    const code = await runAutomation(root, 'gardener');
    expect(code).toBe(0);

    const runs = await listRuns(root, 'gardener');
    expect(runs[0].status).toBe('completed');
    expect(runs[0].exitCode).toBe(0);
    expect(runs[0].posts ?? []).toEqual([]);
  });

  it('gardener → failed exit 1 when the (stubbed) child exits non-zero', async () => {
    process.env.ZELARI_AUTOMATION_RUNNER_STUB_EXIT = '3';
    await upsertAutomation(root, GARDENER);
    const code = await runAutomation(root, 'gardener');
    expect(code).toBe(1);

    const runs = await listRuns(root, 'gardener');
    expect(runs[0].status).toBe('failed');
    expect(runs[0].exitCode).toBe(1);
    expect(runs[0].draft?.warnings?.[0]).toMatch(/exited 3/);
  });
});
