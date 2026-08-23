import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getMemoryService } from '../../src/cli/memory/serviceFactory.js';
import { runMemoryJsonApi } from '../../src/cli/memory/jsonApi.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('read-only Desktop memory JSON bridge', () => {
  it('returns bounded search, provenance, relations, and immutable history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-json-'));
    roots.push(root);
    const memory = await getMemoryService(root, {} as NodeJS.ProcessEnv, { force: true });
    const decision = await memory.remember({
      kind: 'decision', content: 'Use native memory in Desktop.', source: { agent: 'council' },
    });
    const verification = await memory.remember({
      kind: 'verification', content: 'Desktop memory explorer test passed.', source: { agent: 'verifier' },
    });
    await memory.connect({ from: decision.id, to: verification.id, relation: 'validated_by' });
    await memory.close();

    const search = await runMemoryJsonApi(root, JSON.stringify({
      operation: 'search', query: 'native memory Desktop', limit: 10,
    })) as { ok: boolean; results: Array<{ node: { id: string } }>; stats: { backend: string } };
    expect(search.ok).toBe(true);
    expect(search.results[0]?.node.id).toBe(decision.id);
    expect(search.stats.backend).toBe('sqlite');

    const detail = await runMemoryJsonApi(root, JSON.stringify({
      operation: 'detail', memoryId: decision.id,
    })) as { ok: boolean; node: { source: { agent: string } }; related: unknown[]; history: unknown[] };
    expect(detail).toMatchObject({ ok: true, node: { source: { agent: 'council' } } });
    expect(detail.related).toHaveLength(1);
    expect(detail.history).toHaveLength(2); // create + validated confidence update
  });

  it('rejects malformed, oversized, and mutation-shaped requests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-json-policy-'));
    roots.push(root);
    await expect(runMemoryJsonApi(root, '{bad')).rejects.toThrow(/valid JSON/i);
    await expect(runMemoryJsonApi(root, JSON.stringify({ operation: 'retract', memoryId: 'x' })))
      .rejects.toThrow();
    await expect(runMemoryJsonApi(root, ' '.repeat(256_001))).rejects.toThrow(/256 KB/i);
  });
});
