import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileDurableStateStore } from '../../src/cli/state/fileStateStore.js';
import {
  clearDurableContextCache,
  loadDurableContext,
} from '../../src/cli/state/loadDurableContext.js';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-ldc-'));
}

describe('loadDurableContext', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    clearDurableContextCache();
    dirs.length = 0;
  });

  afterEach(async () => {
    clearDurableContextCache();
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('returns empty when no commits', async () => {
    const root = await tmpProject();
    dirs.push(root);
    expect(await loadDurableContext(root)).toBe('');
  });

  it('returns materializeContext text from HEAD', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);
    await store.commit({
      mode: 'zelari',
      label: 'layer-a',
      layer: 'mission:impl-1',
      verification: { ok: true, ran: true },
      discoveries: [
        {
          id: 'd1',
          kind: 'file_change',
          summary: 'added widget.ts',
          paths: ['src/widget.ts'],
          reusable: true,
        },
      ],
    });
    clearDurableContextCache();
    const text = await loadDurableContext(root);
    expect(text).toContain('Durable State');
    expect(text).toContain('widget.ts');
    expect(text).toContain('layer-a');
  });

  it('returns empty when ZELARI_STATE=0', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);
    await store.commit({
      mode: "kraken",
      label: 'x',
      verification: { ok: true, ran: true },
      force: true,
    });
    clearDurableContextCache();
    expect(await loadDurableContext(root, { env: { ZELARI_STATE: '0' } })).toBe(
      '',
    );
  });

  it('caches within TTL', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const store = new FileDurableStateStore();
    await store.init(root);
    await store.commit({
      mode: "kraken",
      label: 'first',
      verification: { ok: true, ran: true },
      force: true,
      discoveries: [
        { id: 'a', kind: 'note', summary: 'first discovery', reusable: true },
      ],
    });
    clearDurableContextCache();
    const a = await loadDurableContext(root, { cacheMs: 60_000 });
    await store.commit({
      mode: "kraken",
      label: 'second',
      verification: { ok: true, ran: true },
      force: true,
      discoveries: [
        { id: 'b', kind: 'note', summary: 'second discovery', reusable: true },
      ],
    });
    // Cache still holds first HEAD materialize until clear/TTL.
    const b = await loadDurableContext(root, { cacheMs: 60_000 });
    expect(b).toBe(a);
    expect(a).toContain('first discovery');
    clearDurableContextCache();
    const c = await loadDurableContext(root);
    expect(c).toContain('second discovery');
  });
});
