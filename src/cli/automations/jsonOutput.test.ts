/**
 * jsonOutput.test.ts — pins the EXACT machine-readable shapes emitted by
 * `automation list|runs|pending|status --json` (consumed by the Desktop IPC
 * bridge). tmp dirs only; no OS scheduler is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAutomationCli } from './cli.js';
import { listJson, pendingJson, readOnlyJson, runsJson, upsertJson } from './jsonOutput.js';
import { upsertAutomation, writeRun } from './registry.js';
import { runSocialPost } from './social/runner.js';
import type { AutomationSpec } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-json-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const GARDENER: AutomationSpec = {
  id: 'news',
  name: 'News digest',
  enabled: true,
  kind: 'gardener',
  schedule: { intervalMin: 45, timezone: 'UTC' },
  budget: { maxCostUsd: 1 },
};

const SOC: AutomationSpec = {
  id: 'soc',
  name: 'Soc',
  enabled: true,
  kind: 'social_post',
  schedule: { timezone: 'UTC' },
  budget: { maxCostUsd: 1 },
  social_post: {
    channels: ['x'],
    topicOrBrief: 'hi',
    requireApproval: true,
    approvalTtlMin: 1440,
  },
};

describe('jsonOutput builders', () => {
  it('listJson carries id/name/kind/enabled/schedule + last-run status', async () => {
    await upsertAutomation(root, GARDENER);
    await writeRun(root, {
      runId: '20260101000000-aaaa',
      automationId: 'news',
      startedAt: new Date().toISOString(),
      status: 'completed',
      exitCode: 0,
    });
    const json = await listJson(root);
    const row = json.automations.find((a) => a.id === 'news');
    expect(row).toBeTruthy();
    expect(row?.name).toBe('News digest');
    expect(row?.kind).toBe('gardener');
    expect(row?.enabled).toBe(true);
    expect(row?.schedule.intervalMin).toBe(45);
    expect(row?.lastRun).toEqual({ status: 'completed', exitCode: 0 });
    // The full spec rides along so the Desktop editor can prefill every field.
    expect(row?.spec?.id).toBe('news');
    expect(row?.spec?.budget.maxCostUsd).toBe(1);
  });

  it('listJson lastRun is null when the job never ran', async () => {
    await upsertAutomation(root, GARDENER);
    const json = await listJson(root);
    expect(json.automations.find((a) => a.id === 'news')?.lastRun).toBeNull();
  });

  it('runsJson exposes status/exitCode and posts[].url evidence', async () => {
    await upsertAutomation(root, GARDENER);
    await writeRun(root, {
      runId: '20260101000000-bbbb',
      automationId: 'news',
      startedAt: new Date().toISOString(),
      status: 'completed',
      exitCode: 0,
      posts: [{ channel: 'x', ok: true, url: 'https://x.com/i/1', postId: '1', dryRun: true }],
    });
    const json = await runsJson(root, 'news');
    expect(json.id).toBe('news');
    expect(json.runs[0].status).toBe('completed');
    expect(json.runs[0].exitCode).toBe(0);
    expect(json.runs[0].posts[0].url).toBe('https://x.com/i/1');
  });

  it('pendingJson lists awaiting_approval runs with draft preview + expiry', async () => {
    await upsertAutomation(root, SOC);
    await runSocialPost(root, SOC);
    const json = await pendingJson(root);
    expect(json.approvals).toHaveLength(1);
    expect(json.approvals[0].automationId).toBe('soc');
    expect(typeof json.approvals[0].draftPreview).toBe('string');
    expect(json.approvals[0].expiresAt).toBeTruthy();
  });
});

describe('upsertJson', () => {
  it('renders the saved spec as a single JSON line (no pretty-print newlines)', () => {
    const line = upsertJson(SOC);
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line) as { id: string; kind: string };
    expect(parsed.id).toBe('soc');
    expect(parsed.kind).toBe('social_post');
  });
});

describe('readOnlyJson dispatch', () => {
  it('returns undefined for a sub that is not a JSON-capable read', async () => {
    expect(await readOnlyJson('show', root, 'x', undefined)).toBeUndefined();
    expect(await readOnlyJson('upsert', root, undefined, undefined)).toBeUndefined();
    expect(await readOnlyJson(undefined, root, undefined, undefined)).toBeUndefined();
  });

  it('runs/status need an --id (fall through to the human error path)', async () => {
    expect(await readOnlyJson('runs', root, undefined, undefined)).toBeUndefined();
    expect(await readOnlyJson('status', root, undefined, undefined)).toBeUndefined();
  });

  it('list migrates gardener and renders parseable JSON', async () => {
    const rendered = await readOnlyJson('list', root, undefined, undefined);
    expect(rendered).toBeTruthy();
    const parsed = JSON.parse(rendered as string) as { automations: Array<{ id: string }> };
    expect(parsed.automations.some((a) => a.id === 'gardener')).toBe(true);
  });
});

describe('cli --json emits machine-readable stdout', () => {
  function capture(): { printed: () => string } {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return { printed: () => spy.mock.calls.map((c) => String(c[0])).join('') };
  }

  it('`automation list --json` prints JSON (exit 0)', async () => {
    const cap = capture();
    try {
      expect(await runAutomationCli(['automation', 'list', '--json'], root)).toBe(0);
      const parsed = JSON.parse(cap.printed()) as { automations: unknown[] };
      expect(Array.isArray(parsed.automations)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('`automation runs --id <id> --json` and `pending --json` print JSON', async () => {
    await upsertAutomation(root, SOC);
    await runSocialPost(root, SOC);

    const capRuns = capture();
    try {
      expect(await runAutomationCli(['automation', 'runs', '--id', 'soc', '--json'], root)).toBe(0);
      const runs = JSON.parse(capRuns.printed()) as { id: string; runs: unknown[] };
      expect(runs.id).toBe('soc');
      expect(Array.isArray(runs.runs)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }

    const capPending = capture();
    try {
      expect(await runAutomationCli(['automation', 'pending', '--json'], root)).toBe(0);
      const pending = JSON.parse(capPending.printed()) as { approvals: unknown[] };
      expect(pending.approvals).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
