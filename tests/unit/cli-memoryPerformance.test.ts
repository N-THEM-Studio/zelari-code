import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getMemoryService } from '../../src/cli/memory/serviceFactory.js';
import { benchmarkMemoryService } from '../../tools/eval/memoryPerformance.ts';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('memory performance regression probe', () => {
  it('measures real SQLite add, recall, and context p50/p95 without embeddings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-performance-'));
    roots.push(root);
    const memory = await getMemoryService(root, { ZELARI_MEMORY_V2: '1' } as NodeJS.ProcessEnv, { force: true });
    const report = await benchmarkMemoryService(memory, { nodes: 120, samples: 12 });
    expect(report).toMatchObject({ nodes: 120, samples: 12 });
    expect(report.addP95Ms).toBeLessThan(1_000);
    expect(report.recallP95Ms).toBeLessThan(1_000);
    expect(report.contextP95Ms).toBeLessThan(1_000);
    await memory.close();
  });
});
