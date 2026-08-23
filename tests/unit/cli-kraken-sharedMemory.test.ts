import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { DefaultMemoryService } from '@zelari/core/memory';
import { runTentacle, type TaskToolDeps } from '../../src/cli/tools/taskTool.js';
import { SQLiteMemoryBackend } from '../../src/cli/memory/sqliteBackend.js';
import { canonicalProjectId } from '../../src/cli/memory/serviceFactory.js';

const directories: string[] = [];

async function openMemory(root: string): Promise<DefaultMemoryService> {
  const backend = new SQLiteMemoryBackend();
  await backend.init(root);
  return new DefaultMemoryService(await canonicalProjectId(root), backend);
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('Kraken native shared memory MVP', () => {
  it('transfers a finding, survives restart, and supersedes it with history intact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-kraken-memory-'));
    directories.push(root);
    let memory = await openMemory(root);
    let providerCall = 0;
    let secondRequest = '';
    const provider: ProviderStreamFn = async function* (request) {
      providerCall += 1;
      if (providerCall === 1) {
        yield {
          kind: 'text',
          delta: 'Constraint discovered: schema migrations must never silently downgrade a newer database.',
        };
      } else {
        secondRequest = request.messages.map((message) => message.content).join('\n');
        yield { kind: 'text', delta: 'I reused the prior schema migration constraint.' };
      }
      yield { kind: 'finish', reason: 'stop' };
    };
    const deps: TaskToolDeps = {
      createSubAgentContext: async () => ({
        providerStream: provider,
        model: 'test-model',
        provider: 'openai-compatible',
        registry: {} as never,
        tools: [],
      }),
      allowWorktree: false,
      memoryService: memory,
      memoryAutoWrite: true,
    };

    const first = await runTentacle({
      deps, agent: 'explore', thoroughness: 'quick', parentCwd: root,
      sessionId: 'session-a', nodeId: 'tentacle-a',
      args: { description: 'Inspect schema migration constraints', prompt: 'Find the migration invariant.' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(first.memoryId).toBeDefined();

    const second = await runTentacle({
      deps, agent: 'explore', thoroughness: 'quick', parentCwd: root,
      sessionId: 'session-a', nodeId: 'tentacle-b',
      args: { description: 'Apply schema migration constraint', prompt: 'Use known migration constraints.' },
    });
    expect(second.ok).toBe(true);
    expect(secondRequest).toContain('[ZELARI MEMORY]');
    expect(secondRequest).toContain('must never silently downgrade');

    await memory.close();
    memory = await openMemory(root);
    const afterRestart = await memory.recall({ text: 'schema migration downgrade', limit: 10 });
    expect(afterRestart.some((hit) => hit.node.id === first.memoryId)).toBe(true);
    const replacement = await memory.remember({
      kind: 'decision',
      content: 'Verified decision: reject databases whose memory schema is newer than the runtime.',
      importance: 0.9, confidence: 0.98,
      source: { agent: 'council', sessionId: 'session-b', verificationId: 'verify-schema' },
      writeClass: 'auto',
    });
    await memory.connect({ from: replacement.id, to: first.memoryId!, relation: 'supersedes' });
    const current = await memory.recall({ text: 'schema migration newer runtime downgrade', limit: 10 });
    expect(current.some((hit) => hit.node.id === replacement.id)).toBe(true);
    expect(current.some((hit) => hit.node.id === first.memoryId)).toBe(false);
    expect((await memory.history(first.memoryId!)).map((version) => version.snapshot.status))
      .toEqual(['active', 'superseded']);
    await memory.close();
  });
});
