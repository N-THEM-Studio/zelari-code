import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { nextMode, parseMode, describeMode, MODES } from '../../src/cli/mode.js';
import { handleSlashCommand } from '../../src/cli/slashCommands';
import type { CodingSkillDefinition } from '@zelari/core/skills';

const skills: CodingSkillDefinition[] = [];

describe('mode helper', () => {
  it('cycles agent → council → zelari → agent (matches shift+tab)', () => {
    expect(nextMode('agent')).toBe('council');
    expect(nextMode('council')).toBe('zelari');
    expect(nextMode('zelari')).toBe('agent');
  });

  it('cycle order matches MODES', () => {
    let m = MODES[0];
    const seen = [m];
    for (let i = 0; i < MODES.length; i += 1) {
      m = nextMode(m);
      seen.push(m);
    }
    // After length steps we return to the start.
    expect(seen[MODES.length]).toBe(MODES[0]);
  });

  it('parseMode accepts known modes case-insensitively and rejects others', () => {
    expect(parseMode('AGENT')).toBe('agent');
    expect(parseMode(' council ')).toBe('council');
    expect(parseMode('zelari')).toBe('zelari');
    expect(parseMode('nope')).toBeNull();
    expect(parseMode('')).toBeNull();
  });

  it('describeMode is non-empty for every mode', () => {
    for (const m of MODES) expect(describeMode(m).length).toBeGreaterThan(0);
  });
});

/**
 * The shift+tab handler in app.tsx fires on `key.tab && key.shift`. That only
 * works if the installed Ink parses the shift+Tab escape sequences that way.
 * This locks that contract so an Ink upgrade that breaks it fails loudly here.
 */
describe('shift+tab key parsing (ink contract the handler relies on)', () => {
  it('maps legacy (\\x1b[Z) and kitty (\\x1b[9;2u) shift+tab to tab+shift; plain tab has no shift', async () => {
    const require = createRequire(import.meta.url);
    const inkEntry = require.resolve('ink'); // …/ink/build/index.js
    const parseKeypressPath = path.join(path.dirname(inkEntry), 'parse-keypress.js');
    const mod = await import(pathToFileURL(parseKeypressPath).href);
    const parseKeypress = (mod.default ?? mod.parseKeypress) as (s: string) => { name: string; shift: boolean };

    const legacy = parseKeypress('\x1b[Z');
    expect(legacy.name === 'tab' && legacy.shift).toBe(true);

    const kitty = parseKeypress('\x1b[9;2u');
    expect(kitty.name === 'tab' && kitty.shift).toBe(true);

    const plain = parseKeypress('\t');
    expect(plain.name === 'tab' && plain.shift).toBe(false); // no accidental toggle
  });
});

describe('/mode command (terminal-independent shift+tab fallback)', () => {
  it('/mode with no arg cycles (mode_set, no target)', () => {
    const r = handleSlashCommand('/mode', skills);
    expect(r.handled).toBe(true);
    expect(r.kind).toBe('mode_set');
    expect(r.modeTarget).toBeUndefined();
    expect(r.message).toBeUndefined();
  });

  it('/mode <name> sets the target directly', () => {
    expect(handleSlashCommand('/mode council', skills).modeTarget).toBe('council');
    expect(handleSlashCommand('/mode ZELARI', skills).modeTarget).toBe('zelari');
    expect(handleSlashCommand('/mode agent', skills).modeTarget).toBe('agent');
  });

  it('/mode <bad> returns an error message and no target', () => {
    const r = handleSlashCommand('/mode fusion', skills);
    expect(r.kind).toBe('mode_set');
    expect(r.modeTarget).toBeUndefined();
    expect(r.message).toMatch(/unknown/i);
  });
});
