import { describe, expect, it } from 'vitest';
import {
  buildDecomposeUser,
  decomposeGoal,
  fallbackPieces,
  formatHistoryNote,
  parsePiecesJson,
  piecesFromModelText,
} from '../../src/cli/gauntlet/decompose.js';

describe('fallbackPieces', () => {
  it('uses the first line of the Goal as the label', () => {
    const [p] = fallbackPieces('fix the lights\nmore context');
    expect(p?.id).toBe('g1');
    expect(p?.label).toBe('fix the lights');
    expect(p?.prompt).toContain('fix the lights');
  });
});

describe('parsePiecesJson', () => {
  it('reads pieces[] and caps the list', () => {
    const out = parsePiecesJson(
      {
        pieces: [
          { id: 'a', label: 'HUD', prompt: 'draw hud', acceptance: ['fps'] },
          { id: 'a', prompt: 'dup id becomes unique' },
        ],
      },
      6,
    );
    expect(out).toHaveLength(2);
    expect(out?.[0]?.id).toBe('a');
    expect(out?.[1]?.id).toBe('a-2');
    expect(out?.[0]?.acceptance).toEqual(['fps']);
  });

  it('returns null on garbage so the caller can fall back', () => {
    expect(parsePiecesJson(null, 6)).toBeNull();
    expect(parsePiecesJson({ pieces: [] }, 6)).toBeNull();
    expect(parsePiecesJson({ hello: 1 }, 6)).toBeNull();
  });

  it('keeps optional bar paths', () => {
    const out = parsePiecesJson(
      { pieces: [{ prompt: 'hud', bar: ['gold/hud.png', '  '] }] },
      6,
    );
    expect(out?.[0]?.bar).toEqual(['gold/hud.png']);
  });
});

describe('decomposeGoal', () => {
  it('falls back when no complete fn is provided', async () => {
    const r = await decomposeGoal({ goal: 'fix lights', maxPieces: 4 });
    expect(r.source).toBe('fallback');
    expect(r.pieces).toHaveLength(1);
    expect(r.pieces[0]?.prompt).toContain('fix lights');
  });

  it('uses LLM JSON when complete returns pieces', async () => {
    const r = await decomposeGoal({
      goal: 'ship a racer',
      maxPieces: 4,
      complete: async () =>
        JSON.stringify({
          pieces: [
            { id: 'hud', label: 'HUD', prompt: 'draw the hud', scope: ['src/hud.ts'] },
            { id: 'ai', label: 'AI', prompt: 'opponents', scope: ['src/ai.ts'] },
          ],
        }),
    });
    expect(r.source).toBe('llm');
    expect(r.pieces.map((p) => p.id)).toEqual(['hud', 'ai']);
  });

  it('falls back when complete throws or returns junk', async () => {
    const boom = await decomposeGoal({
      goal: 'x',
      maxPieces: 2,
      complete: async () => {
        throw new Error('timeout');
      },
    });
    expect(boom.source).toBe('fallback');
    expect(boom.error).toMatch(/timeout/);

    const junk = await decomposeGoal({
      goal: 'x',
      maxPieces: 2,
      complete: async () => 'sorry, cannot JSON today',
    });
    expect(junk.source).toBe('fallback');
  });
});

describe('formatHistoryNote / buildDecomposeUser', () => {
  it('keeps the Goal authoritative and clips prior turns', () => {
    const note = formatHistoryNote(
      [
        { role: 'user', content: 'prepara il plan' },
        { role: 'assistant', content: 'piano scritto' },
      ],
      4,
      80,
    );
    expect(note).toMatch(/^user:/);
    const user = buildDecomposeUser({
      goal: 'sviluppa il piano',
      maxPieces: 6,
      historyNote: note,
    });
    expect(user).toContain('## Goal');
    expect(user).toContain('sviluppa il piano');
    expect(user).toContain('authoritative');
  });
});

describe('piecesFromModelText', () => {
  it('extracts a fenced JSON object', () => {
    const text = 'here\n```json\n{"pieces":[{"prompt":"one"}]}\n```\n';
    const out = piecesFromModelText(text, 6);
    expect(out?.[0]?.prompt).toBe('one');
  });
});
