/**
 * draft.test.ts — spec → draft (F2). Local tmp dirs only, no LLM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { draftSocialPost } from './draft.js';
import type { SocialPostSpec } from '../types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-draft-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function spec(over: Partial<SocialPostSpec> = {}): SocialPostSpec {
  return {
    channels: ['x'],
    topicOrBrief: '',
    requireApproval: true,
    approvalTtlMin: 1440,
    ...over,
  };
}

describe('draftSocialPost', () => {
  it('treats a literal brief as the draft text (trimmed)', async () => {
    const d = await draftSocialPost(spec({ topicOrBrief: '  hello world  ' }), root);
    expect(d.text).toBe('hello world');
    expect(d.warnings).toEqual([]);
    expect(d.media).toEqual([]);
  });

  it('reads the draft text from an existing .md file', async () => {
    await writeFile(path.join(root, 'brief.md'), '# Title\n\nBody text.\n', 'utf-8');
    const d = await draftSocialPost(spec({ topicOrBrief: 'brief.md' }), root);
    expect(d.text).toBe('# Title\n\nBody text.');
  });

  it('reads the draft text from an absolute .txt path', async () => {
    const p = path.join(root, 'abs.txt');
    await writeFile(p, 'absolute content', 'utf-8');
    const d = await draftSocialPost(spec({ topicOrBrief: p }), root);
    expect(d.text).toBe('absolute content');
  });

  it('falls back to the literal brief when the .md path does not exist', async () => {
    const d = await draftSocialPost(spec({ topicOrBrief: 'nope.md' }), root);
    expect(d.text).toBe('nope.md');
  });

  it('keeps existing media and warns (never throws) on a missing file', async () => {
    await writeFile(path.join(root, 'pic.png'), 'x', 'utf-8');
    const d = await draftSocialPost(
      spec({ topicOrBrief: 'hi', media: { paths: ['pic.png', 'gone.png'] } }),
      root,
    );
    expect(d.media).toEqual(['pic.png']);
    expect(d.warnings).toContain('media_missing:gone.png');
  });

  it('warns when the text exceeds the x char limit', async () => {
    const d = await draftSocialPost(spec({ topicOrBrief: 'a'.repeat(281) }), root);
    expect(d.warnings).toContain('text_exceeds_x_limit');
  });
});
