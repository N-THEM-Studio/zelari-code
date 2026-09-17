/**
 * probe.test.ts — the 4-step diagnostic + report formatting, driven entirely by
 * a FAKE browser (no Playwright). Covers every branch: browser present/absent,
 * profile present/absent, login-state matched (in/out) and stale selectors.
 */
import { describe, expect, it } from 'vitest';
import { formatProbeReport, runProbe } from './probe.js';
import type { BrowserPageLike, ContextOpener, PersistentContextLike } from './session.js';

function fakePage(match: (selector: string) => boolean): BrowserPageLike {
  return {
    goto: async () => undefined,
    url: () => 'https://x.com/home',
    close: async () => undefined,
    hasSelector: async (selector) => match(selector),
  };
}

const openerWith =
  (page: BrowserPageLike | null): ContextOpener =>
  async (): Promise<PersistentContextLike | null> => {
    if (!page) return null;
    return {
      newPage: async () => page,
      pages: () => [page],
      close: async () => undefined,
      onClose: () => undefined,
    };
  };

const base = { available: async () => true, profileExists: () => true };

describe('runProbe', () => {
  it('passes all steps and names the matching selector (logged-in)', async () => {
    const page = fakePage((s) => s === "[data-testid='SideNav_NewTweet_Button']");
    const r = await runProbe('x', { ...base, opener: openerWith(page) });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual([
      'browser-available',
      'profile-exists',
      'goto-login',
      'login-state',
    ]);
    expect(r.steps.find((s) => s.step === 'goto-login')?.detail).toBe('https://x.com/home');
    expect(r.steps.find((s) => s.step === 'login-state')?.detail).toBe('logged-in via compose-button');
  });

  it('classifies a logged-out page as a valid (ok) determination', async () => {
    const page = fakePage((s) => s === "input[name='password']");
    const r = await runProbe('x', { ...base, opener: openerWith(page) });
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.step === 'login-state')?.detail).toBe('logged-out via login-password');
  });

  it('fails login-state when no selector matches (stale selectors)', async () => {
    const r = await runProbe('x', { ...base, opener: openerWith(fakePage(() => false)) });
    expect(r.ok).toBe(false);
    const ls = r.steps.find((s) => s.step === 'login-state');
    expect(ls?.ok).toBe(false);
    expect(ls?.detail).toMatch(/no selector matched/);
  });

  it('skips the browser steps when Playwright is unavailable', async () => {
    const r = await runProbe('x', { available: async () => false, profileExists: () => true });
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.step === 'browser-available')?.ok).toBe(false);
    expect(r.steps.find((s) => s.step === 'goto-login')?.detail).toMatch(/skipped/);
    expect(r.steps.find((s) => s.step === 'login-state')?.detail).toMatch(/skipped/);
  });

  it('flags a missing profile (not yet logged in)', async () => {
    const r = await runProbe('x', {
      ...base,
      profileExists: () => false,
      opener: openerWith(fakePage(() => false)),
    });
    const ps = r.steps.find((s) => s.step === 'profile-exists');
    expect(ps?.ok).toBe(false);
    expect(ps?.detail).toMatch(/automation login x/);
    expect(r.ok).toBe(false);
  });

  it('reports a launch failure on goto-login', async () => {
    const r = await runProbe('x', { ...base, opener: openerWith(null) });
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.step === 'goto-login')?.ok).toBe(false);
    expect(r.steps.find((s) => s.step === 'login-state')?.detail).toMatch(/skipped/);
  });

  it('rejects an unknown channel', async () => {
    await expect(runProbe('tiktok')).rejects.toThrow(/unknown social channel/);
  });
});

describe('formatProbeReport', () => {
  it('renders a header plus one line per step', async () => {
    const r = await runProbe('x', {
      ...base,
      opener: openerWith(fakePage((s) => s === "[data-testid='SideNav_NewTweet_Button']")),
    });
    const text = formatProbeReport(r);
    expect(text).toContain('probe x — OK');
    expect(text).toContain('[ok] browser-available');
    expect(text).toContain('[ok] login-state — logged-in via compose-button');
  });

  it('marks failures with [x]', () => {
    const text = formatProbeReport({
      channel: 'x',
      ok: false,
      checkedAt: '2026-01-01T00:00:00.000Z',
      steps: [{ step: 'login-state', ok: false, detail: 'no selector matched' }],
    });
    expect(text).toContain('probe x — FAILED');
    expect(text).toContain('[x] login-state — no selector matched');
  });
});
