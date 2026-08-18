import { describe, it, expect, afterEach } from 'vitest';
import { krakenSelectionPlaybook } from './selectionPlaybook.js';
import { KRAKEN_LEAD_PLAYBOOK_MODULE } from '@zelari/core/skills';

const FLAG = 'ZELARI_KRAKEN_SELECTION';

describe('krakenSelectionPlaybook (Fase 5 — adaptive playbook)', () => {
  const prev = process.env[FLAG];
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it('flag off ⇒ no module (prompt byte-identical, regression guard)', () => {
    delete process.env[FLAG];
    expect(krakenSelectionPlaybook(true)).toEqual([]);
  });

  it('non-kraken call site ⇒ no module even with flag on', () => {
    process.env[FLAG] = '1';
    expect(krakenSelectionPlaybook(false)).toEqual([]);
  });

  it('flag on + kraken path ⇒ exactly one module', () => {
    process.env[FLAG] = '1';
    const mods = krakenSelectionPlaybook(true);
    expect(mods).toHaveLength(1);
    expect(mods[0].title).toMatch(/Verified Selection/i);
  });

  it('carries the adaptive thresholds (simple→direct, ambiguous→2, uncertainty→3)', () => {
    process.env[FLAG] = '1';
    const c = krakenSelectionPlaybook(true)[0].content;
    expect(c).toMatch(/DIRECT/i);
    expect(c).toMatch(/2 candidates/);
    expect(c).toMatch(/up to 3 candidates/);
  });

  it('carries the orchestration contract (purpose=candidate, kraken_select, single path)', () => {
    process.env[FLAG] = '1';
    const c = krakenSelectionPlaybook(true)[0].content;
    expect(c).toContain('purpose="candidate"');
    expect(c).toContain('kraken_select');
    expect(c).toContain('needs_more_evidence');
    expect(c).toMatch(/Never blend/i);
  });

  it('carries check routing (PLAN → plan section, BUILD → verify Acceptance) + integrity', () => {
    process.env[FLAG] = '1';
    const c = krakenSelectionPlaybook(true)[0].content;
    expect(c).toMatch(/verification section/i);
    expect(c).toMatch(/Acceptance/i);
    expect(c).toMatch(/proof of absence/i);
  });

  it('sorts after the lead playbook (priority ordering preserved)', () => {
    process.env[FLAG] = '1';
    const [m] = krakenSelectionPlaybook(true);
    expect(m.priority).toBeGreaterThan(KRAKEN_LEAD_PLAYBOOK_MODULE.priority);
  });
});
