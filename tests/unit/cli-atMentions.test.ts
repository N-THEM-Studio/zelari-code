import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractAtMentions,
  expandAtMentions,
  hasAtMentions,
} from '../../src/cli/atMentions.js';

describe('atMentions', () => {
  it('extracts @paths and ignores emails', () => {
    const text = 'see @src/cli/main.ts and email me at user@example.com then @apps/desktop';
    expect(extractAtMentions(text)).toEqual(['src/cli/main.ts', 'apps/desktop']);
    expect(hasAtMentions(text)).toBe(true);
  });

  it('expands file content under cwd', () => {
    const root = join(tmpdir(), `zelari-at-${Date.now()}`);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'hello.ts'), 'export const n = 1;\n', 'utf8');
    try {
      const { text, hits } = expandAtMentions('Review @src/hello.ts please', root);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.path).toBe('src/hello.ts');
      expect(hits[0]?.text).toContain('export const n = 1');
      expect(text).toContain('[Tagged paths]');
      expect(text).toContain('--- File: src/hello.ts ---');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('notes missing paths', () => {
    const root = join(tmpdir(), `zelari-at-miss-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const { hits } = expandAtMentions('Look at @no/such/file.ts', root);
      expect(hits[0]?.note).toMatch(/not found/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
