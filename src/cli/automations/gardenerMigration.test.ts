/**
 * gardenerMigration.test.ts — F0 back-compat: create once, never overwrite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureGardenerSpec } from './gardenerMigration.js';
import { automationsDir, getAutomation } from './registry.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-gm-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ensureGardenerSpec', () => {
  it('creates the spec once (index + file, kind gardener, disabled)', async () => {
    const status = await ensureGardenerSpec(root);
    expect(status.created).toBe(true);

    const spec = await getAutomation(root, 'gardener');
    expect(spec?.kind).toBe('gardener');
    expect(spec?.enabled).toBe(false);

    const idx = JSON.parse(
      await readFile(path.join(automationsDir(root), 'index.json'), 'utf-8'),
    );
    expect(idx.automations).toEqual([{ id: 'gardener', enabled: false }]);
  });

  it('is idempotent (second call reports created=false)', async () => {
    await ensureGardenerSpec(root);
    expect((await ensureGardenerSpec(root)).created).toBe(false);
  });

  it('does not overwrite a hand-edited existing spec', async () => {
    await ensureGardenerSpec(root);
    const specPath = path.join(automationsDir(root), 'gardener.json');
    const mutated = {
      id: 'gardener',
      name: 'Hand edited',
      enabled: true,
      kind: 'gardener',
      schedule: { intervalMin: 30, timezone: 'UTC' },
      budget: { maxCostUsd: 5 },
    };
    await writeFile(specPath, `${JSON.stringify(mutated, null, 2)}\n`, 'utf-8');

    const status = await ensureGardenerSpec(root);
    expect(status.created).toBe(false);

    const after = JSON.parse(await readFile(specPath, 'utf-8'));
    expect(after.name).toBe('Hand edited');
    expect(after.enabled).toBe(true);
    expect(after.budget.maxCostUsd).toBe(5);
  });
});
