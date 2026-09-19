/**
 * statuslineConfig.test.ts — t114: the status-line configuration is PERSISTED,
 * zod-validated and fail-soft.
 *
 * Red-if-reopens:
 *   - the default test fails if the default stops being exactly today's chips
 *     with no custom script (the zero-visible-change contract);
 *   - the round-trip test fails if the file stops being the source of truth;
 *   - the normalization tests fail if an unknown/duplicate id survives, if a
 *     corrupt file stops degrading to DEFAULT, or if `items: []` starts being
 *     silently widened back to the full bar (turning off the last chip).
 *
 * Every test isolates the file: nothing here touches the real `~/.zelari-code`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_STATUSLINE_TIMEOUT_MS,
  MAX_STATUSLINE_TIMEOUT_MS,
  loadStatusLineConfig,
  moveItem,
  normalizeStatusLineConfig,
  saveStatusLineConfig,
  setCustomCommand,
  setItemEnabled,
  statusLineConfigPath,
  updateStatusLineConfig,
  defaultStatusLineConfig,
} from './statuslineConfig.js';
import { DEFAULT_STATUSLINE_ITEMS, STATUSLINE_CUSTOM_ID } from './statuslineItems.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zelari-statusline-'));
  file = path.join(dir, 'statusline.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('defaults — zero visible change until an opt-in (t114)', () => {
  it('is exactly the current chip order, with no custom script', () => {
    expect(defaultStatusLineConfig()).toEqual({ items: [...DEFAULT_STATUSLINE_ITEMS], custom: null });
  });

  it('pins the documented timeout and the hard ceiling', () => {
    expect(DEFAULT_STATUSLINE_TIMEOUT_MS).toBe(1500);
    expect(MAX_STATUSLINE_TIMEOUT_MS).toBe(30_000);
  });

  it('a missing file resolves to DEFAULT instead of throwing', () => {
    expect(loadStatusLineConfig({ file })).toEqual(defaultStatusLineConfig());
  });
});

describe('persistence — the file is the source of truth (t114)', () => {
  it('round-trips an enable/disable and a reorder through disk', () => {
    const { ok, config } = updateStatusLineConfig((c) => moveItem(setItemEnabled(c, 'jail', false), 'session', -1), {
      file,
    });
    expect(ok).toBe(true);
    expect(config.items).not.toContain('jail');

    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.items).toEqual(config.items);
    expect(onDisk.custom).toBeNull();
    expect(loadStatusLineConfig({ file })).toEqual(config);
  });

  it('persists the custom command with its timeout, and clears both', () => {
    const set = updateStatusLineConfig((c) => setCustomCommand(c, 'node ~/sl.js'), { file }).config;
    expect(set.custom).toEqual({ command: 'node ~/sl.js', timeoutMs: DEFAULT_STATUSLINE_TIMEOUT_MS });
    expect(set.items).toContain(STATUSLINE_CUSTOM_ID);
    expect(loadStatusLineConfig({ file })).toEqual(set);

    const cleared = updateStatusLineConfig((c) => setCustomCommand(c, null), { file }).config;
    expect(cleared.custom).toBeNull();
    expect(cleared.items).not.toContain(STATUSLINE_CUSTOM_ID);
    expect(loadStatusLineConfig({ file })).toEqual(cleared);
  });

  it('the env override wins over the home path, and the home is the fallback', () => {
    expect(statusLineConfigPath({ ZELARI_STATUSLINE_CONFIG_FILE: ` ${file} ` })).toBe(file);
    const prev = process.env.ZELARI_HOME;
    process.env.ZELARI_HOME = dir;
    try {
      expect(statusLineConfigPath({})).toBe(path.join(dir, 'statusline.json'));
    } finally {
      if (prev === undefined) delete process.env.ZELARI_HOME;
      else process.env.ZELARI_HOME = prev;
    }
  });

  it('honours ZELARI_STATUSLINE_CONFIG_FILE and ZELARI_HOME for real I/O on temp paths', () => {
    // env-driven (not just `opts.file`): the documented CI/test isolation knobs
    const viaEnvFile = { env: { ZELARI_STATUSLINE_CONFIG_FILE: file } };
    expect(saveStatusLineConfig({ items: ['model'], custom: { command: 's.sh', timeoutMs: 900 } }, viaEnvFile)).toBe(
      true,
    );
    expect(readFileSync(file, 'utf-8')).toContain('"s.sh"');
    expect(loadStatusLineConfig(viaEnvFile)).toEqual({
      items: ['model', STATUSLINE_CUSTOM_ID],
      custom: { command: 's.sh', timeoutMs: 900 },
    });

    // no per-file override ⇒ the home wins, and ZELARI_HOME is a temp dir
    const home = path.join(dir, 'home');
    const viaHome = { env: { ZELARI_HOME: home } };
    expect(statusLineConfigPath(viaHome.env)).toBe(path.join(home, 'statusline.json'));
    expect(loadStatusLineConfig(viaHome)).toEqual(defaultStatusLineConfig()); // nothing persisted yet
    expect(updateStatusLineConfig((c) => setItemEnabled(c, 'jail', false), viaHome).ok).toBe(true);
    expect(loadStatusLineConfig(viaHome).items).not.toContain('jail');
    expect(existsSync(path.join(home, 'statusline.json'))).toBe(true);
  });

  it('a failed write is REPORTED (false) and never thrown — a read-only home cannot break boot', () => {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const impossible = path.join(blocker, 'statusline.json');
    expect(() => saveStatusLineConfig(defaultStatusLineConfig(), { file: impossible })).not.toThrow();
    expect(saveStatusLineConfig(defaultStatusLineConfig(), { file: impossible })).toBe(false);
    // read-modify-write stays honest: ok:false, but the ORDER the caller asked for is returned
    const { ok, config } = updateStatusLineConfig((c) => setItemEnabled(c, 'jail', false), { file: impossible });
    expect(ok).toBe(false);
    expect(config.items).not.toContain('jail');
  });
});

describe('normalization — unknown ids die, corrupt files degrade (t114)', () => {
  it('drops unknown and duplicate ids instead of resurrecting chips', () => {
    const out = normalizeStatusLineConfig({
      version: 1,
      items: ['model', 'ghost-chip', 'model', 'jail'],
      custom: null,
    });
    expect(out.items).toEqual(['model', 'jail']);
  });

  it('degrades to DEFAULT on unparseable / wrongly-typed / non-object JSON', () => {
    for (const raw of [null, 42, 'nope', [], { items: 'not-an-array' }, { version: 2, items: ['jail'] }]) {
      expect(normalizeStatusLineConfig(raw)).toEqual(defaultStatusLineConfig());
    }
  });

  it('an ABSENT items key means "not configured" and yields the default order', () => {
    expect(normalizeStatusLineConfig({ version: 1 }).items).toEqual([...DEFAULT_STATUSLINE_ITEMS]);
    // a hand-made file carrying only a custom command still keeps the bar
    const withCustom = normalizeStatusLineConfig({ custom: { command: 'x' } });
    expect(withCustom.items).toEqual([...DEFAULT_STATUSLINE_ITEMS, STATUSLINE_CUSTOM_ID]);
    expect(withCustom.custom).toEqual({ command: 'x', timeoutMs: DEFAULT_STATUSLINE_TIMEOUT_MS });
  });

  it('an EXPLICIT empty list means "nothing enabled" and survives normalization', () => {
    expect(normalizeStatusLineConfig({ items: [], custom: null })).toEqual({ items: [], custom: null });
  });

  it('keeps `custom` in the list exactly while a command exists (and appends it once)', () => {
    const without = normalizeStatusLineConfig({ items: ['model', STATUSLINE_CUSTOM_ID], custom: null });
    expect(without).toEqual({ items: ['model'], custom: null });
    const withIt = normalizeStatusLineConfig({
      items: ['model', STATUSLINE_CUSTOM_ID],
      custom: { command: ' node -e "" ', timeoutMs: 2000 },
    });
    expect(withIt.custom).toEqual({ command: 'node -e ""', timeoutMs: 2000 });
    expect(withIt.items).toEqual(['model', STATUSLINE_CUSTOM_ID]);
    // a blank command is not a command
    expect(normalizeStatusLineConfig({ items: ['model'], custom: { command: '   ' } })).toEqual({
      items: ['model'],
      custom: null,
    });
  });

  it('rejects a timeout above the ceiling (schema failure ⇒ DEFAULT, never a 60s status line)', () => {
    const out = normalizeStatusLineConfig({ custom: { command: 'x', timeoutMs: MAX_STATUSLINE_TIMEOUT_MS + 1 } });
    expect(out).toEqual(defaultStatusLineConfig());
  });
});

describe('editing primitives (t114)', () => {
  it('setItemEnabled is a no-op for unknown ids and for custom without a script', () => {
    const base = defaultStatusLineConfig();
    expect(setItemEnabled(base, 'ghost', false)).toBe(base);
    expect(setItemEnabled(base, STATUSLINE_CUSTOM_ID, true)).toBe(base);
    // disabling an item that is not enabled is already the desired state
    expect(setItemEnabled(setItemEnabled(base, 'jail', false), 'jail', false).items).not.toContain('jail');
  });

  it('re-enabling appends at the declared order tail', () => {
    const off = setItemEnabled(defaultStatusLineConfig(), 'phase', false);
    const on = setItemEnabled(off, 'phase', true);
    expect(on.items[on.items.length - 1]).toBe('phase');
    expect(on.items).toHaveLength(DEFAULT_STATUSLINE_ITEMS.length);
  });

  it('moveItem clamps at both ends and is a no-op for unknown ids', () => {
    const base = defaultStatusLineConfig();
    expect(moveItem(base, 'ghost', -1)).toBe(base);
    expect(moveItem(base, 'phase', -1)).toBe(base); // already first
    expect(moveItem(base, 'session', 1)).toBe(base); // already last
    expect(moveItem(base, 'session', -1).items.slice(-2)).toEqual(['session', 'cost']);
  });

  it('setCustomCommand keeps the previous timeout when only the command changes', () => {
    const first = setCustomCommand(defaultStatusLineConfig(), 'a.sh', 2500);
    expect(first.custom).toEqual({ command: 'a.sh', timeoutMs: 2500 });
    expect(setCustomCommand(first, 'b.sh').custom).toEqual({ command: 'b.sh', timeoutMs: 2500 });
    expect(setCustomCommand(first, '   ')).toEqual({
      items: [...DEFAULT_STATUSLINE_ITEMS],
      custom: null,
    });
  });
});
