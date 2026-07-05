import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileMemoryBackend,
  NoopMemoryBackend,
  getMemoryBackend,
  formatMemoryHits,
  isMemoryEnabled,
} from '../../src/cli/memory/fileBackend.js';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-mem-'));
}

describe('FileMemoryBackend', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    dirs.length = 0;
  });

  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('roundtrips add + keyword search in the same project', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const mem = new FileMemoryBackend();
    await mem.init(root);
    await mem.add('The auth module uses JWT tokens for sessions');

    const hits = await mem.search('jwt authentication tokens');
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain('JWT');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('writes its log under <projectRoot>/.zelari/memory/log.jsonl', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const mem = new FileMemoryBackend();
    await mem.init(root);
    await mem.add('a persisted fact');
    const logPath = path.join(root, '.zelari', 'memory', 'log.jsonl');
    const raw = await fs.readFile(logPath, 'utf8');
    expect(raw.trim().split('\n').length).toBe(1);
    expect(JSON.parse(raw.trim()).content).toBe('a persisted fact');
  });

  it('isolates projects (project A facts do not leak into project B)', async () => {
    const rootA = await tmpProject();
    const rootB = await tmpProject();
    dirs.push(rootA, rootB);

    const memA = new FileMemoryBackend();
    await memA.init(rootA);
    await memA.add('project alpha decided to use Postgres');

    const memB = new FileMemoryBackend();
    await memB.init(rootB);
    const hits = await memB.search('postgres alpha decision');
    expect(hits).toEqual([]);
  });

  it('applies metadataFilter', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const mem = new FileMemoryBackend();
    await mem.init(root);
    await mem.add('decision about caching layer', { sliceId: 'slice-1' });
    await mem.add('decision about caching strategy', { sliceId: 'slice-2' });

    const hits = await mem.search('caching decision', {
      metadataFilter: { sliceId: 'slice-1' },
    });
    expect(hits.length).toBe(1);
    expect(hits[0].metadata.sliceId).toBe('slice-1');
  });

  it('returns [] for an empty query', async () => {
    const root = await tmpProject();
    dirs.push(root);
    const mem = new FileMemoryBackend();
    await mem.init(root);
    await mem.add('something');
    expect(await mem.search('  ')).toEqual([]);
  });
});

describe('getMemoryBackend factory', () => {
  it('returns a no-op backend when ZELARI_MEMORY=0', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-mem-'));
    const mem = await getMemoryBackend(root, { ZELARI_MEMORY: '0' } as NodeJS.ProcessEnv);
    expect(mem).toBeInstanceOf(NoopMemoryBackend);
    expect(await mem.add('ignored')).toBe('');
    expect(await mem.search('ignored')).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns a working file backend by default', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-mem-'));
    const mem = await getMemoryBackend(root, {} as NodeJS.ProcessEnv);
    expect(mem).toBeInstanceOf(FileMemoryBackend);
    await mem.add('default backend works');
    expect((await mem.search('default backend')).length).toBe(1);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('isMemoryEnabled', () => {
  it('is disabled only for exactly "0"', () => {
    expect(isMemoryEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isMemoryEnabled({ ZELARI_MEMORY: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isMemoryEnabled({ ZELARI_MEMORY: '0' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('formatMemoryHits', () => {
  it('returns empty string for no hits', () => {
    expect(formatMemoryHits([])).toBe('');
  });

  it('renders a numbered RAG block', () => {
    const out = formatMemoryHits([
      { id: '1', text: 'use Stripe for payments', score: 2, metadata: {} },
    ]);
    expect(out).toContain('Recalled from project memory');
    expect(out).toContain('1. use Stripe for payments');
  });
});
