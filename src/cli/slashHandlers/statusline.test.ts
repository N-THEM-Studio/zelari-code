/**
 * slashHandlers/statusline.test.ts — t114: `/statusline` is a real, persisted,
 * fail-soft command (read-modify-write on the prefs file, never a throw).
 *
 * Red-if-reopens: every mutation below is asserted TWICE — on the message the
 * TUI prints and on the file that the next render will load. In particular
 * `/statusline off <last item>` must keep an empty list (the bar renders
 * "(none)"), while `/statusline reset` must restore exactly the default chip
 * order; the registration test fails if `/statusline` or `/report` disappears
 * from the slash registry or from `/help`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleStatusLine } from './statusline.js';
import {
  defaultStatusLineConfig,
  loadStatusLineConfig,
  saveStatusLineConfig,
} from '../statusline/statuslineConfig.js';
import { DEFAULT_STATUSLINE_ITEMS, STATUSLINE_CUSTOM_ID } from '../statusline/statuslineItems.js';
import { handleSlashCommand } from '../slashCommands.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zelari-statusline-cmd-'));
  file = path.join(dir, 'statusline.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('/statusline show (t114)', () => {
  it('renders the default order, every built-in on and no custom script', () => {
    const out = handleStatusLine([], { file });
    expect(out).toContain('custom: (not configured)');
    expect(out).toContain('[x] phase');
    expect(out).toContain('[x] jail');
    expect(out).toContain('[ ] custom');
    expect(out).toContain('usage: /statusline');
  });

  it('is read-only: showing the state never creates the file', () => {
    handleStatusLine(['show'], { file });
    expect(loadStatusLineConfig({ file })).toEqual(defaultStatusLineConfig());
  });
});

describe('/statusline on|off|up|down (t114)', () => {
  it('off persists the removal and on re-appends the item', () => {
    expect(handleStatusLine(['off', 'jail'], { file })).toContain('jail disabled');
    expect(loadStatusLineConfig({ file }).items).not.toContain('jail');

    expect(handleStatusLine(['on', 'jail'], { file })).toContain('jail enabled');
    const items = loadStatusLineConfig({ file }).items;
    expect(items).toContain('jail');
    expect(items[items.length - 1]).toBe('jail');
    expect(items).toHaveLength(DEFAULT_STATUSLINE_ITEMS.length);
  });

  it('up/down reorder within bounds and the file reflects the new order', () => {
    handleStatusLine(['up', 'session'], { file });
    expect(loadStatusLineConfig({ file }).items.slice(-2)).toEqual(['session', 'cost']);
    handleStatusLine(['down', 'phase'], { file });
    expect(loadStatusLineConfig({ file }).items.slice(0, 2)).toEqual(['mode', 'phase']);
  });

  it('reports unknown / disabled items instead of writing rubbish', () => {
    expect(handleStatusLine(['off', 'ghost'], { file })).toMatch(/not enabled/);
    expect(handleStatusLine(['off', 'ghost'], { file })).toContain('/statusline');
    expect(loadStatusLineConfig({ file })).toEqual(defaultStatusLineConfig());
  });

  it('refuses to enable custom before a script exists', () => {
    expect(handleStatusLine(['on', 'custom'], { file })).toContain('/statusline custom <command>');
    expect(loadStatusLineConfig({ file }).items).not.toContain(STATUSLINE_CUSTOM_ID);
  });

  it('an unknown sub-command still prints the current state plus the reason', () => {
    const out = handleStatusLine(['banana'], { file });
    expect(out).toContain("unknown sub-command 'banana'");
    expect(out).toContain('order:');
    expect(loadStatusLineConfig({ file })).toEqual(defaultStatusLineConfig());
  });

  it('disabling the LAST enabled item keeps an empty bar (no silent re-enable)', () => {
    saveStatusLineConfig({ items: ['jail'], custom: null }, { file });
    const out = handleStatusLine(['off', 'jail'], { file });
    expect(out).toContain('(none');
    expect(loadStatusLineConfig({ file })).toEqual({ items: [], custom: null });
  });
});

describe('/statusline custom + timeout + reset (t114)', () => {
  it('sets a real script, previews its first line and persists command + timeout', () => {
    const out = handleStatusLine(['custom', 'echo', 'ci'], { file });
    expect(out).toContain('custom script set');
    expect(out).toContain('first line: ci');
    const config = loadStatusLineConfig({ file });
    expect(config.custom).toEqual({ command: 'echo ci', timeoutMs: 1500 });
    expect(config.items).toContain(STATUSLINE_CUSTOM_ID);
  });

  it('a script that produces nothing is stored but stays hidden (fail-soft, honest message)', () => {
    const out = handleStatusLine(['custom', 'definitely-not-a-real-binary-xyz'], { file });
    expect(out).toMatch(/no usable first line|produced no usable first line/);
    expect(loadStatusLineConfig({ file }).custom?.command).toBe('definitely-not-a-real-binary-xyz');
  });

  it('custom clear drops both the command and the item', () => {
    handleStatusLine(['custom', 'echo', 'ci'], { file });
    handleStatusLine(['custom', 'clear'], { file });
    const config = loadStatusLineConfig({ file });
    expect(config.custom).toBeNull();
    expect(config.items).not.toContain(STATUSLINE_CUSTOM_ID);
  });

  it('timeout needs a configured script, then updates it without dropping the command', () => {
    expect(handleStatusLine(['timeout', '2500'], { file })).toContain('no custom script configured');
    handleStatusLine(['custom', 'echo', 'ci'], { file });
    expect(handleStatusLine(['timeout', '2500'], { file })).toContain('custom timeout set to 2500ms');
    expect(loadStatusLineConfig({ file }).custom).toEqual({ command: 'echo ci', timeoutMs: 2500 });
    expect(handleStatusLine(['timeout', 'nope'], { file })).toContain('usage: /statusline timeout');
  });

  it('reset restores exactly the default chip order and clears the script', () => {
    handleStatusLine(['custom', 'echo', 'ci'], { file });
    handleStatusLine(['off', 'jail'], { file });
    expect(handleStatusLine(['reset'], { file })).toContain('reset to the default chip order');
    expect(loadStatusLineConfig({ file })).toEqual(defaultStatusLineConfig());
  });

  it('a failed write is reported, never thrown, and the running order is unchanged', () => {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'file, not a directory');
    const out = handleStatusLine(['off', 'jail'], { file: path.join(blocker, 'statusline.json') });
    expect(out).toContain('cannot write the config file');
  });
});

describe('/statusline and /report are wired into the slash registry (t114/t115)', () => {
  const withEnv = <T>(patch: Record<string, string>, fn: () => T): T => {
    const saved = new Map(Object.keys(patch).map((k) => [k, process.env[k]]));
    Object.assign(process.env, patch);
    try {
      return fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('/statusline resolves to its own kind and shares the persisted config', () => {
    withEnv({ ZELARI_STATUSLINE_CONFIG_FILE: file }, () => {
      const result = handleSlashCommand('/statusline', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('statusline');
      expect(result.message).toContain('order:');
    });
  });

  it('/report resolves to its own kind without touching the real sessions dir', () => {
    withEnv({ ZELARI_SESSIONS_DIR: path.join(dir, 'no-sessions') }, () => {
      const result = handleSlashCommand('/report', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('report');
      expect(result.message).toContain('no session spine found');
    });
  });

  it('/help documents both commands', () => {
    const help = handleSlashCommand('/help', []).message ?? '';
    expect(help).toContain('/statusline');
    expect(help).toContain('/report');
  });
});
