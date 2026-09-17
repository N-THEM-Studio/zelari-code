/**
 * approvals.test.ts — the pending inbox + decision resolution (F2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRun, listRuns, upsertAutomation, writeRun } from '../registry.js';
import { listPending, resolveApproval } from './approvals.js';
import { runSocialPost } from './runner.js';
import type { AutomationSpec, AutomationRun, SocialPostSpec } from '../types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-appr-'));
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
      channels: ['x', 'website'],
      topicOrBrief: 'draft body',
      requireApproval: true,
      approvalTtlMin: 1440,
      ...over,
    },
  };
}

/** Seed a spec + one pending run; returns the runId. */
async function pending(id: string, over: Partial<SocialPostSpec> = {}): Promise<string> {
  const spec = social(id, over);
  await upsertAutomation(root, spec);
  expect(await runSocialPost(root, spec)).toBe(4);
  return (await listRuns(root, id))[0].runId;
}

describe('listPending', () => {
  it('lists awaiting_approval runs with a <=120-char preview', async () => {
    const runId = await pending('p1');
    const items = await listPending(root);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ automationId: 'p1', runId });
    expect(items[0].draftPreview).toBe('draft body');
    expect(items[0].expiresAt).toBeTruthy();
  });

  it('ignores runs that are not awaiting approval', async () => {
    await upsertAutomation(root, social('done', { requireApproval: false }));
    await runSocialPost(root, social('done', { requireApproval: false }));
    expect(await listPending(root)).toEqual([]);
  });
});

describe('resolveApproval', () => {
  it('(b) allow → dry-run publish completed, all posts ok+url+dryRun, exit 0', async () => {
    const runId = await pending('bb');
    expect(await resolveApproval(root, runId, 'allow')).toBe(0);

    const run = await getRun(root, 'bb', runId);
    expect(run?.status).toBe('completed');
    expect(run?.exitCode).toBe(0);
    expect(run?.posts).toHaveLength(2);
    expect(run?.posts?.every((p) => p.ok && !!p.url && p.dryRun)).toBe(true);
    expect(run?.approvals?.[0].decision).toBe('allow');
  });

  it('(c) deny → skipped, exit 0', async () => {
    const runId = await pending('cc');
    expect(await resolveApproval(root, runId, 'deny')).toBe(0);

    const run = await getRun(root, 'cc', runId);
    expect(run?.status).toBe('skipped');
    expect(run?.exitCode).toBe(0);
    expect(run?.approvals?.[0].decision).toBe('deny');
    expect(run?.posts).toBeUndefined();
  });

  it('(d) edit → the edited text is what gets published', async () => {
    const runId = await pending('dd');
    expect(await resolveApproval(root, runId, 'edit', 'EDITED TEXT')).toBe(0);

    const run = await getRun(root, 'dd', runId);
    expect(run?.status).toBe('completed');
    expect(run?.draft?.text).toBe('EDITED TEXT');
    expect(run?.approvals?.[0]).toMatchObject({ decision: 'edit', editedText: 'EDITED TEXT' });
  });

  it('(e) TTL expired → skipped (reason approval_ttl_expired), exit 4', async () => {
    await upsertAutomation(root, social('ee'));
    const runId = '20260101000000-expired0';
    const run: AutomationRun = {
      runId,
      automationId: 'ee',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      status: 'awaiting_approval',
      exitCode: 4,
      draft: { text: 'stale' },
    };
    await writeRun(root, run);

    expect(await resolveApproval(root, runId, 'allow')).toBe(4);
    const after = await getRun(root, 'ee', runId);
    expect(after?.status).toBe('skipped');
    expect(after?.reason).toBe('approval_ttl_expired');
    expect(after?.posts).toBeUndefined();
  });

  it('unknown runId → exit 1', async () => {
    expect(await resolveApproval(root, 'nope', 'allow')).toBe(1);
  });

  it('edit on a non-pending run is still applied (fail-safe default TTL)', async () => {
    await upsertAutomation(root, social('zz'));
    const runId = '20260101000000-zzzzzzzz';
    await writeRun(root, {
      runId,
      automationId: 'zz',
      startedAt: new Date().toISOString(),
      status: 'awaiting_approval',
      exitCode: 4,
      draft: { text: 'old' },
    });
    expect(await resolveApproval(root, runId, 'edit', 'new')).toBe(0);
    expect((await getRun(root, 'zz', runId))?.draft?.text).toBe('new');
  });
});
