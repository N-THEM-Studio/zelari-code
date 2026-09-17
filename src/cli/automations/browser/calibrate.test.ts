/**
 * calibrate.test.ts — pure suggestion heuristics + a fake-page run that MUST
 * never type and never click a post button (non-destructiveness is the point
 * of the command, so it is pinned by test).
 */
import { describe, expect, it, vi } from 'vitest';
import { runCalibration, suggestPostButtons, suggestTextBoxes, type ControlDump } from './calibrate.js';
import type { BrowserPageLike, PersistentContextLike } from './session.js';

const btn = (o: Partial<ControlDump>): ControlDump => ({ tag: 'div', text: '', ...o });

describe('suggestPostButtons', () => {
  it('matches localized post verbs via aria-label or text', () => {
    const out = suggestPostButtons([
      btn({ tag: 'div', role: 'button', aria: 'Pubblica' }),
      btn({ tag: 'div', role: 'button', text: 'Post' }),
      btn({ tag: 'div', role: 'button', aria: 'Avanti' }),
      btn({ tag: 'a', role: 'link', text: 'Post di prova' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('aria="Pubblica"');
    expect(out[1]).toContain('text="Post"');
  });

  it('ignores non-buttons and empty names', () => {
    expect(suggestPostButtons([btn({ tag: 'span', text: 'Post' }), btn({ role: 'button', text: '' })])).toEqual([]);
  });
});

describe('suggestTextBoxes', () => {
  it('caps and shapes textbox candidates', () => {
    const out = suggestTextBoxes([
      btn({ tag: 'div', role: 'textbox', testid: 'tweetTextarea_0' }),
      btn({ tag: 'textarea' }),
    ]);
    expect(out[0]).toContain('data-testid=tweetTextarea_0');
    expect(out).toHaveLength(2);
  });
});

/** Fake page that records every interaction (and fails the test on typing). */
function fakePage(opts: { cookies: Array<{ name: string }>; controls?: ControlDump[] }) {
  const clicks: string[] = [];
  const typed: Array<{ selector: string; text: string }> = [];
  const page: BrowserPageLike = {
    goto: async () => undefined,
    hasSelector: async () => true,
    close: async () => undefined,
    click: async (selector: string) => {
      clicks.push(selector);
    },
    press: async () => undefined,
    controls: async () => opts.controls ?? [],
    typeText: async (selector: string, text: string) => {
      typed.push({ selector, text });
    },
  };
  const ctx: PersistentContextLike = {
    newPage: async () => page,
    pages: () => [page],
    close: async () => undefined,
    onClose: () => undefined,
    cookies: async () => opts.cookies,
  };
  return { page, ctx, clicks, typed };
}

describe('runCalibration (fake browser)', () => {
  it('stops at relogin_required WITHOUT a single click when cookies are gone', async () => {
    const f = fakePage({ cookies: [{ name: 'guest_id' }] });
    const r = await runCalibration('x', { opener: async () => f.ctx, writeReport: async () => undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/relogin_required/);
    expect(f.clicks).toEqual([]); // zero interactions — never poke a logged-out page
    expect(f.typed).toEqual([]);
  });

  it('happy path: dumps controls, records entry/textbox, NEVER types', async () => {
    const f = fakePage({
      cookies: [{ name: 'auth_token' }],
      controls: [btn({ tag: 'div', role: 'button', aria: 'Post' }), btn({ tag: 'div', role: 'textbox', testid: 'tweetTextarea_0' })],
    });
    const writeReport = vi.fn(async () => undefined);
    const r = await runCalibration('x', { opener: async () => f.ctx, writeReport });
    expect(r.ok).toBe(true);
    expect(r.entryMatched).toBeDefined();
    expect(r.textBoxMatched).toBeDefined();
    expect(r.controls).toHaveLength(2);
    expect(r.postButtonCandidates.some((c) => c.includes('aria="Post"'))).toBe(true);
    expect(f.typed).toEqual([]); // calibration never types
    expect(f.clicks).toHaveLength(1); // only the composer entry
    expect(writeReport).toHaveBeenCalledTimes(1);
    expect(r.reportPath).toMatch(/calibration[\\/]x-/);
  });

  it('returns playwright-unavailable when the opener yields null', async () => {
    const r = await runCalibration('facebook', { opener: async () => null, writeReport: async () => undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('playwright-unavailable');
  });
});
