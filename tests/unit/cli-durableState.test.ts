import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_STALE_MS,
  FileDurableStateStore,
  NoopDurableStateStore,
  formatStaleMarker,
  getStateStore,
  hashStablePrompt,
  isStateEnabled,
  layerKind,
} from '../../src/cli/state/fileStateStore.js';
import {
  accumulatePromptCacheStats,
  emptyPromptCacheStats,
  formatCacheStatsLine,
} from '../../src/cli/state/promptCacheStats.js';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-state-'));
}

describe('FileDurableStateStore', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    dirs.length = 0;
  });

  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('commits under .zelari/state/ and advances HEAD', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);

    const c1 = await store.commit({
      mode: 'zelari',
      label: 'layer one',
      layer: 'mission:impl-1',
      verification: { ok: true, ran: true },
      discoveries: [
        {
          id: 'd1',
          kind: 'file_change',
          summary: 'added foo.ts',
          paths: ['src/foo.ts'],
          reusable: true,
        },
      ],
    });
    expect(c1.id).toBeTruthy();
    expect(c1.parentId).toBeNull();
    expect(c1.discoveryCount).toBe(1);

    const head = await store.head();
    expect(head?.id).toBe(c1.id);

    const c2 = await store.commit({
      mode: 'zelari',
      label: 'layer two',
      verification: { ok: true, ran: true },
      discoveries: [
        { id: 'd2', kind: 'decision', summary: 'use JSON store', reusable: true },
      ],
    });
    expect(c2.parentId).toBe(c1.id);
    expect((await store.head())?.id).toBe(c2.id);

    const list = await store.list(10);
    expect(list[0].id).toBe(c2.id);
    expect(list.map((x) => x.id)).toContain(c1.id);

    const layout = path.join(root, '.zelari', 'state');
    await expect(fs.stat(path.join(layout, 'HEAD.json'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(layout, 'commits', `${c1.id}.json`))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(layout, 'artifacts', c1.id, 'discoveries.json')),
    ).resolves.toBeTruthy();
  });

  it('refuses auto-commit when verification failed unless force', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);

    await expect(
      store.commit({
        mode: "kraken",
        label: 'bad',
        verification: { ok: false, ran: true },
      }),
    ).rejects.toThrow(/refused/);

    const soft = await store.commit({
      mode: "kraken",
      label: 'soft',
      verification: { ok: false, ran: true },
      force: true,
    });
    expect(soft.id).toBeTruthy();
  });

  it('materializeContext caps and lists reusable discoveries', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);
    await store.commit({
      mode: 'council',
      label: 'ctx',
      verification: { ok: true, ran: true },
      discoveries: [
        { id: 'a', kind: 'note', summary: 'keep me', reusable: true },
        { id: 'b', kind: 'note', summary: 'drop me', reusable: false },
      ],
    });
    const text = await store.materializeContext();
    expect(text).toContain('keep me');
    expect(text).not.toContain('drop me');
    expect(text).toContain('Durable State');
  });

  it('getStateStore returns noop when ZELARI_STATE=0', async () => {
    const root = await tmpProject();
    dirs.push(root);
    expect(isStateEnabled({ ZELARI_STATE: '0' })).toBe(false);
    const store = await getStateStore(root, { ZELARI_STATE: '0' });
    expect(store).toBeInstanceOf(NoopDurableStateStore);
    expect(await store.head()).toBeNull();
  });

  it('setHead points HEAD at an earlier commit', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);
    const c1 = await store.commit({
      mode: "kraken",
      label: 'first',
      verification: { ok: true, ran: true },
      force: true,
    });
    const c2 = await store.commit({
      mode: "kraken",
      label: 'second',
      verification: { ok: true, ran: true },
      force: true,
    });
    expect((await store.head())?.id).toBe(c2.id);
    const restored = await store.setHead(c1.id);
    expect(restored.id).toBe(c1.id);
    expect((await store.head())?.id).toBe(c1.id);
    await expect(store.setHead('missing-id')).rejects.toThrow(/unknown/);
  });
});

describe('hashStablePrompt', () => {
  it('is deterministic and changes with content', () => {
    expect(hashStablePrompt('abc')).toBe(hashStablePrompt('abc'));
    expect(hashStablePrompt('abc')).not.toBe(hashStablePrompt('abd'));
  });
});

describe('tryStateCommit + restoreDurableState', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('tryStateCommit writes a real commit and restore moves HEAD', async () => {
    const { tryStateCommit, discoveriesFromOutcome } = await import(
      '../../src/cli/state/commitHelpers.js'
    );
    const { restoreDurableState } = await import('../../src/cli/state/restoreState.js');
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);

    const r1 = await tryStateCommit({
      projectRoot: root,
      store,
      mode: 'zelari',
      label: 'first',
      verification: { ok: true, ran: true },
      stablePromptHash: 'abc123deadbeef01',
      discoveries: discoveriesFromOutcome({
        stepId: '1',
        writeCount: 2,
        note: 'first layer',
      }),
    });
    expect(r1.ok).toBe(true);
    expect(r1.meta?.id).toBeTruthy();
    expect(r1.meta?.stablePromptHash).toBe('abc123deadbeef01');

    const r2 = await tryStateCommit({
      projectRoot: root,
      store,
      mode: 'zelari',
      label: 'second',
      verification: { ok: true, ran: true },
      discoveries: discoveriesFromOutcome({ stepId: '2', note: 'second' }),
    });
    expect(r2.ok).toBe(true);
    expect((await store.head())?.id).toBe(r2.meta?.id);

    const restored = await restoreDurableState({
      projectRoot: root,
      store,
      commitId: r1.meta!.id,
      restoreTree: false,
    });
    expect(restored.ok).toBe(true);
    expect(restored.meta?.id).toBe(r1.meta?.id);
    expect((await store.head())?.id).toBe(r1.meta?.id);
    expect(restored.message).toMatch(/restored HEAD/);
  });
});

describe('promptCacheStats', () => {
  it('accumulates hit rate and stable busts', () => {
    let s = emptyPromptCacheStats();
    s = accumulatePromptCacheStats(s, {
      promptTokens: 10_000,
      cachedTokens: 8_000,
      costUsd: 0.01,
      stableHash: 'aaa',
    });
    expect(s.hitRate).toBeCloseTo(0.8);
    expect(s.premiumTokens).toBe(2_000);
    expect(s.stableBustCount).toBe(0);

    s = accumulatePromptCacheStats(s, {
      promptTokens: 10_000,
      cachedTokens: 9_000,
      stableHash: 'bbb',
    });
    expect(s.stableBustCount).toBe(1);
    expect(s.cachedTokens).toBe(17_000);
    expect(formatCacheStatsLine(s)).toContain('stable busts 1');
  });
});

describe('supersede + stale rendering (t163)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  async function newStore(): Promise<{ root: string; store: FileDurableStateStore }> {
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);
    return { root, store };
  }

  const commitLayer = (store: FileDurableStateStore, layer?: string) =>
    store.commit({
      mode: 'zelari',
      label: layer ?? 'no layer',
      layer,
      verification: { ok: true, ran: true },
    });

  it('supersedes the previous same-kind layer; chain keeps the first superseder', async () => {
    const { store } = await newStore();
    const c6 = await commitLayer(store, 'mission:progress-6');
    const c7 = await commitLayer(store, 'mission:progress-7');
    const c8 = await commitLayer(store, 'mission:progress-8');

    const g6 = await store.get(c6.id);
    const g7 = await store.get(c7.id);
    const g8 = await store.get(c8.id);

    expect(g6?.supersededBy).toBe(c7.id);
    expect(typeof g6?.supersededAt).toBe('number');
    expect(g7?.supersededBy).toBe(c8.id);
    // chain semantics: 6 stays superseded by 7, never rewritten to 8
    expect(g6?.supersededBy).not.toBe(c8.id);
    // the newest layer is current — never superseded
    expect(g8?.supersededAt).toBeUndefined();
    expect(g8?.supersededBy).toBeUndefined();
  });

  it('does not touch a different kind', async () => {
    const { store } = await newStore();
    const progress = await commitLayer(store, 'mission:progress-1');
    await commitLayer(store, 'mission:rework-1');
    expect((await store.get(progress.id))?.supersededAt).toBeUndefined();
  });

  it('unlayered commits never supersede nor get superseded', async () => {
    const { store } = await newStore();
    const progress = await commitLayer(store, 'mission:progress-1');
    const bare = await commitLayer(store); // no layer
    // the unlayered commit supersedes nothing
    expect((await store.get(progress.id))?.supersededAt).toBeUndefined();
    // a later same-kind layer leaves the unlayered commit untouched
    await commitLayer(store, 'mission:progress-2');
    const gBare = await store.get(bare.id);
    expect(gBare?.supersededAt).toBeUndefined();
    expect(gBare?.supersededBy).toBeUndefined();
  });

  it('derives kind by stripping one trailing -<n>', () => {
    expect(layerKind('mission:progress-6')).toBe('mission:progress');
    expect(layerKind('mission:progress')).toBe('mission:progress');
    expect(layerKind('plan:task-12')).toBe('plan:task');
    expect(layerKind(undefined)).toBeNull();
    expect(layerKind('')).toBeNull();
  });

  it('renders "stale · superseded" for a superseded layer', async () => {
    const { store } = await newStore();
    const c6 = await commitLayer(store, 'mission:progress-6');
    const c7 = await commitLayer(store, 'mission:progress-7');
    const text = await store.materializeContext(c6.id);
    expect(text).toContain('stale · superseded');
    expect(text).toContain(`by ${c7.id.slice(0, 8)}`);
  });

  it('renders "stale · age" for a layer older than the threshold', async () => {
    const { store, root } = await newStore();
    const c = await commitLayer(store, 'mission:progress-1');
    // backdate the commit on disk (3 days old)
    const metaPath = path.join(root, '.zelari', 'state', 'commits', `${c.id}.json`);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as { createdAt: number };
    meta.createdAt = Date.now() - 3 * 24 * 3600_000;
    await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');

    const text = await store.materializeContext(c.id);
    expect(text).toContain('stale · age 3d');
  });

  it('renders no marker for a fresh commit (no stray line)', async () => {
    const { store } = await newStore();
    const c = await commitLayer(store, 'mission:progress-1');
    const text = await store.materializeContext(c.id);
    expect(text).not.toContain('stale');
    // nothing injected: the second line is still the label line
    expect(text.split('\n')[1]).toMatch(/^label: /);
  });

  it('formatStaleMarker: age threshold is the exported DEFAULT_STALE_MS', () => {
    const now = 1_000_000_000_000;
    expect(DEFAULT_STALE_MS).toBe(48 * 3600_000);
    expect(formatStaleMarker({ createdAt: now - DEFAULT_STALE_MS }, now)).toBeNull();
    expect(formatStaleMarker({ createdAt: now - DEFAULT_STALE_MS - 1 }, now)).toContain('stale · age');
    // superseded wins over age
    expect(
      formatStaleMarker({ createdAt: now, supersededAt: now, supersededBy: 'abcdef1234' }, now),
    ).toBe(`stale · superseded ${new Date(now).toISOString().slice(0, 10)} by abcdef12`);
  });
});
