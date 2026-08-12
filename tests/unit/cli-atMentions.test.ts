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

  it('loads image attachments as base64 vision blocks', () => {
    const root = join(tmpdir(), `zelari-at-img-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(root, 'pic.png'), png);
    try {
      const { text, hits } = expandAtMentions('Describe @pic.png', root);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.image?.mime).toBe('image/png');
      expect(hits[0]?.image?.dataBase64.length).toBeGreaterThan(10);
      expect(hits[0]?.text).toContain('Immagine');
      expect(text).toContain('--- Image: pic.png (image/png');
      // The base64 payload must NOT be dumped into the prompt text.
      expect(text).not.toContain('iVBORw0KG');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows absolute image paths outside the project root', () => {
    const root = join(tmpdir(), `zelari-at-img-abs-${Date.now()}`);
    const outside = join(tmpdir(), `zelari-outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'shot.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    );
    try {
      const { hits } = expandAtMentions(`See @${outside}/shot.jpg`, root);
      expect(hits[0]?.image?.mime).toBe('image/jpeg');
      expect(hits[0]?.note).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
