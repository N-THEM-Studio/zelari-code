/**
 * registry.test.ts — hermetic coverage for the Automations Registry.
 * No network, no OS scheduling: local tmp dirs only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  automationsDir,
  deleteAutomation,
  getAutomation,
  getRun,
  listAutomations,
  listRuns,
  newRunId,
  upsertAutomation,
  writeRun,
} from './registry.js';
import type { AutomationRun, AutomationSpec } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-reg-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function spec(id: string, over: Partial<AutomationSpec> = {}): AutomationSpec {
  return {
    id,
    name: id,
    enabled: false,
    kind: 'gardener',
    schedule: { intervalMin: 60, timezone: 'Europe/Rome' },
    budget: { maxCostUsd: 1 },
    ...over,
  };
}

function run(automationId: string, runId: string): AutomationRun {
  return {
    runId,
    automationId,
    startedAt: new Date().toISOString(),
    status: 'completed',
    exitCode: 0,
  };
}

async function readIndex(): Promise<{ version: number; automations: unknown }> {
  return JSON.parse(await readFile(path.join(automationsDir(root), 'index.json'), 'utf-8'));
}

describe('registry — spec store', () => {
  it('upsert → list → get roundtrip and creates index.json', async () => {
    await upsertAutomation(root, spec('alpha', { name: 'Alpha', kind: 'social_post', enabled: true }));

    expect(existsSync(path.join(automationsDir(root), 'index.json'))).toBe(true);
    expect(existsSync(path.join(automationsDir(root), 'alpha.json'))).toBe(true);
    expect(await readIndex()).toEqual({ version: 1, automations: [{ id: 'alpha', enabled: true }] });

    const got = await getAutomation(root, 'alpha');
    expect(got?.name).toBe('Alpha');
    expect(await listAutomations(root)).toEqual([
      { id: 'alpha', enabled: true, name: 'Alpha', kind: 'social_post' },
    ]);
  });

  it('updates the existing index entry instead of duplicating it', async () => {
    await upsertAutomation(root, spec('beta', { enabled: false }));
    await upsertAutomation(root, spec('beta', { enabled: true, name: 'Beta2' }));
    expect(await readIndex()).toEqual({ version: 1, automations: [{ id: 'beta', enabled: true }] });
  });

  it('rejects an invalid id', async () => {
    await expect(upsertAutomation(root, spec('Bad-Id'))).rejects.toThrow(/invalid automation id/);
  });

  it('listAutomations tolerates a missing index', async () => {
    expect(await listAutomations(root)).toEqual([]);
  });

  it('deletes a spec and its index entry', async () => {
    await upsertAutomation(root, spec('gamma'));
    await deleteAutomation(root, 'gamma');
    expect(await getAutomation(root, 'gamma')).toBeNull();
    expect(await readIndex()).toEqual({ version: 1, automations: [] });
  });

  it('refuses to delete the reserved gardener id', async () => {
    await upsertAutomation(root, spec('gardener'));
    await expect(deleteAutomation(root, 'gardener')).rejects.toThrow(/reserved/);
    expect(await getAutomation(root, 'gardener')).not.toBeNull();
  });
});

describe('registry — runs', () => {
  it('writeRun → listRuns returns newest first', async () => {
    await writeRun(root, run('alpha', '20260916000000-aaaaaaaa'));
    await writeRun(root, run('alpha', '20260916000001-bbbbbbbb'));
    await writeRun(root, run('alpha', '20260916000002-cccccccc'));

    const runs = await listRuns(root, 'alpha');
    expect(runs.map((r) => r.runId)).toEqual([
      '20260916000002-cccccccc',
      '20260916000001-bbbbbbbb',
      '20260916000000-aaaaaaaa',
    ]);
    expect(await getRun(root, 'alpha', '20260916000001-bbbbbbbb')).not.toBeNull();
  });

  it('listRuns respects the limit and tolerates a missing dir', async () => {
    expect(await listRuns(root, 'missing')).toEqual([]);
    await writeRun(root, run('alpha', '20260916000000-aaaaaaaa'));
    await writeRun(root, run('alpha', '20260916000001-bbbbbbbb'));
    expect(await listRuns(root, 'alpha', 1)).toHaveLength(1);
  });

  it('newRunId has the expected <14-digit>-<8hex> shape', () => {
    expect(newRunId()).toMatch(/^\d{14}-[0-9a-f]{8}$/);
  });
});

describe('registry — atomic writes', () => {
  it('leaves no .tmp files behind', async () => {
    await upsertAutomation(root, spec('alpha'));
    await writeRun(root, run('alpha', newRunId()));
    const entries = await readdir(automationsDir(root), { recursive: true });
    expect(entries.filter((n) => String(n).includes('.tmp'))).toEqual([]);
  });
});
