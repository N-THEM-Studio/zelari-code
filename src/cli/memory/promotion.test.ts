import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '@zelari/core/memory';
import {
  meetsPromoteThreshold,
  promoteMemoryToAgentsMd,
} from './promotion.js';

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem-1',
    schemaVersion: 1,
    projectId: 'p',
    kind: 'procedure',
    content: 'npm test → pass',
    importance: 0.75,
    confidence: 0.9,
    status: 'active',
    tags: [],
    source: {},
    createdAt: 't',
    updatedAt: 't',
    recordedAt: 't',
    metadata: {},
    ...overrides,
  };
}

describe('meetsPromoteThreshold', () => {
  it('accepts importance≥0.7 and confidence≥0.8', () => {
    expect(meetsPromoteThreshold(node())).toBe(true);
    expect(meetsPromoteThreshold(node({ importance: 0.69, confidence: 0.9 }))).toBe(false);
    expect(meetsPromoteThreshold(node({ importance: 0.9, confidence: 0.79 }))).toBe(false);
  });

  it('accepts metadata.verified even below numeric threshold', () => {
    expect(
      meetsPromoteThreshold(
        node({ importance: 0.1, confidence: 0.1, metadata: { verified: true } }),
      ),
    ).toBe(true);
  });
});

describe('promoteMemoryToAgentsMd', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('rejects nodes below threshold with a structured reason', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zelari-promote-'));
    dirs.push(root);
    const result = await promoteMemoryToAgentsMd(
      root,
      node({ importance: 0.2, confidence: 0.2 }),
    );
    expect(result.added).toBe(false);
    expect(result.reason).toBe('below-threshold');
  });

  it('promotes a verified procedure into the memory-promotions block', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zelari-promote-'));
    dirs.push(root);
    const result = await promoteMemoryToAgentsMd(
      root,
      node({ metadata: { verified: true }, importance: 0.1, confidence: 0.1 }),
    );
    expect(result.added).toBe(true);
    const body = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(body).toContain('memory:mem-1');
    expect(body).toContain('zelari:memory-promotions:start');
  });
});
