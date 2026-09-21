import { describe, expect, it } from 'vitest';
import { deriveRelevantWhen, RELEVANT_WHEN_CAP } from './relevantWhen.js';
import { MemoryNodeInputSchema } from './schemas.js';

describe('deriveRelevantWhen (pure, zero-LLM)', () => {
  it('describes a failure as "when <tool> fails with <error-class>"', () => {
    const triggers = deriveRelevantWhen('npm test failed with ETIMEDOUT', 'failure');
    expect(triggers).toEqual(['when npm fails with etimedout']);
  });

  it('describes a procedure as "when running <command>"', () => {
    const triggers = deriveRelevantWhen('Run npm run build to package the CLI.', 'procedure');
    expect(triggers[0]).toMatch(/^when running /);
    expect(triggers[0]).toContain('npm');
  });

  it('derives 1–3 short situational phrases for other kinds', () => {
    const triggers = deriveRelevantWhen(
      'Use SQLite WAL for shared project memory.',
      'decision',
      ['architecture'],
    );
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers.length).toBeLessThanOrEqual(RELEVANT_WHEN_CAP);
    for (const trigger of triggers) {
      expect(trigger).toMatch(/^when /);
      expect(trigger.length).toBeLessThanOrEqual(120);
    }
  });

  it('caps output and never leaks long credential-like tokens', () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
    const triggers = deriveRelevantWhen(
      `Upload failed with ${secret} token archived expired retry`,
      'failure',
    );
    expect(triggers.length).toBeLessThanOrEqual(RELEVANT_WHEN_CAP);
    for (const trigger of triggers) {
      expect(trigger).not.toContain('sk-proj-');
      expect(trigger).not.toContain(secret);
    }
  });

  it('returns nothing for empty content', () => {
    expect(deriveRelevantWhen('', 'fact')).toEqual([]);
  });
});

describe('MemoryNodeInputSchema.relevantWhen', () => {
  const base = { kind: 'fact' as const, content: 'A durable fact.' };

  it('accepts up to 8 triggers', () => {
    const relevantWhen = Array.from({ length: 8 }, (_, index) => `when thing ${index}`);
    expect(MemoryNodeInputSchema.safeParse({ ...base, relevantWhen }).success).toBe(true);
  });

  it('rejects more than 8 triggers', () => {
    const relevantWhen = Array.from({ length: 9 }, (_, index) => `when thing ${index}`);
    expect(MemoryNodeInputSchema.safeParse({ ...base, relevantWhen }).success).toBe(false);
  });

  it('rejects a trigger longer than 120 chars', () => {
    expect(MemoryNodeInputSchema.safeParse({
      ...base, relevantWhen: ['x'.repeat(121)],
    }).success).toBe(false);
  });

  it('rejects empty trigger strings', () => {
    expect(MemoryNodeInputSchema.safeParse({ ...base, relevantWhen: [''] }).success).toBe(false);
  });

  it('stays strict about unknown keys', () => {
    expect(MemoryNodeInputSchema.safeParse({ ...base, trigger: 'nope' }).success).toBe(false);
  });
});
