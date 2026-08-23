import { describe, expect, it } from 'vitest';
import {
  DefaultMemorySanitizer,
  formatMemoryContext,
  MemoryEdgeInputSchema,
  recencyScore,
  scoreMemoryCandidate,
} from './index.js';
import type { MemoryNode } from './types.js';

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
  const now = new Date('2026-08-23T12:00:00.000Z').toISOString();
  return {
    id: 'mem_1', schemaVersion: 1, projectId: 'project_test', kind: 'decision',
    content: 'Use native MemoryService and keep MCP external only.',
    importance: 0.9, confidence: 0.8, status: 'active', tags: ['architecture'],
    source: { agent: 'council', verificationId: 'verify_1' },
    createdAt: now, updatedAt: now, recordedAt: now, metadata: {},
    ...overrides,
  };
}

describe('memory scoring and context', () => {
  it('redistributes semantic weight when embeddings are unavailable', () => {
    const result = scoreMemoryCandidate(
      { node: node() },
      'native memory service architecture',
      { now: Date.parse('2026-08-23T12:00:00.000Z') },
    );
    expect(result.score).toBeGreaterThan(0.6);
    expect(result.signals.semanticRelevance).toBe(0);
    expect(result.signals.verificationBonus).toBe(1);
  });

  it('applies deterministic recency decay', () => {
    const now = Date.parse('2026-08-31T00:00:00.000Z');
    expect(recencyScore('2026-08-01T00:00:00.000Z', now, 30)).toBeCloseTo(0.5, 5);
  });

  it('honors configurable weights', () => {
    const result = scoreMemoryCandidate(
      { node: node({ importance: 0.25, confidence: 1 }) },
      'native memory service architecture',
      {
        now: Date.parse('2026-08-23T12:00:00.000Z'),
        weights: {
          semanticRelevance: 0, lexicalRelevance: 0, importance: 1,
          confidence: 0, recency: 0, graphProximity: 0, verificationBonus: 0,
        },
      },
    );
    expect(result.score).toBe(0.25);
  });

  it('rejects arbitrary relation names', () => {
    expect(MemoryEdgeInputSchema.safeParse({
      from: 'mem_a', to: 'mem_b', relation: 'discovered_in',
    }).success).toBe(false);
  });

  it('never exceeds the hard context budget', () => {
    const ranked = Array.from({ length: 8 }, (_, index) => ({
      node: node({ id: `mem_${index}`, content: `Long memory ${index} ${'x'.repeat(200)}` }),
      score: 0.9 - index / 100,
      signals: {
        semanticRelevance: 0, lexicalRelevance: 1, importance: 0.9,
        confidence: 0.8, recency: 1, graphProximity: 0, verificationBonus: 1,
      },
    }));
    const context = formatMemoryContext(ranked, { maxChars: 420, maxMemories: 8 });
    expect(context.text.length).toBeLessThanOrEqual(420);
    expect(context.truncated).toBe(true);
    expect(context.memories.length).toBeGreaterThan(0);
  });
});

describe('memory sanitizer', () => {
  const sanitizer = new DefaultMemorySanitizer();

  it('redacts credential values while retaining the useful outcome', () => {
    const result = sanitizer.sanitize('Authentication failed: api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.rejected).toBe(false);
    expect(result.content).toContain('api_key=[REDACTED]');
    expect(result.content).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('rejects private keys', () => {
    const result = sanitizer.sanitize('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----');
    expect(result.rejected).toBe(true);
  });

  it('redacts unlabelled high-entropy credential-like strings', () => {
    const token = 'A7fK2mQ9vR4xT8pL1sN6wY3cD0hJ5uB2eG7iM9oP';
    const result = sanitizer.sanitize(`Provider returned opaque credential ${token}`);
    expect(result.rejected).toBe(false);
    expect(result.content).toContain('[REDACTED]');
    expect(result.content).not.toContain(token);
    expect(result.redactions).toContain('high-entropy-token');
  });

  it('drops private reasoning blocks while retaining the conclusion', () => {
    const result = sanitizer.sanitize(
      '<think>private chain of thought</think>Verified conclusion: WAL is enabled.',
    );
    expect(result.content).toBe('Verified conclusion: WAL is enabled.');
    expect(result.content).not.toContain('chain of thought');
    expect(result.redactions).toContain('private-reasoning');
  });
});
