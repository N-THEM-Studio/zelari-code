/**
 * M1.6 — the single repair prompt carries only a SHORT capped TAIL of each
 * failing check's captured output, never the full log.
 *
 * The cap (REPAIR_FAIL_EXCERPT_CAP) and the max-5-per-prompt limit bound the
 * token cost of the one automatic repair pass; without the excerpts argument
 * the prompt must stay byte-identical to the pre-M1.6 directive.
 */
import { describe, expect, it } from 'vitest';
import {
  buildKrakenRepairPrompt,
  REPAIR_FAIL_EXCERPT_CAP,
  type KrakenCompletionGate,
} from './completionGate.js';

function gate(overrides: Partial<KrakenCompletionGate> = {}): KrakenCompletionGate {
  return {
    blocked: true,
    selectionUsed: true,
    total: 2,
    passed: 0,
    failedChecks: ['the test suite passes'],
    unknownChecks: [],
    ...overrides,
  };
}

describe('buildKrakenRepairPrompt — M1.6 failure excerpts', () => {
  it('caps a 50k-char output to the tail, marks the omission, drops the head', () => {
    const head = 'HEAD::this-is-the-beginning-of-a-very-long-log::';
    const tailMarker = 'TAIL::the-actual-assertion-error-lives-here::end-of-output';
    const huge = head + 'x'.repeat(50_000) + tailMarker;
    const prompt = buildKrakenRepairPrompt(gate(), new Map([['the test suite passes', huge]]));

    // The tail (where the real error sits) survives, capped at the constant.
    expect(prompt).toContain(tailMarker);
    expect(prompt).toContain(`Failure excerpt (tail, capped ${REPAIR_FAIL_EXCERPT_CAP} chars)`);
    // The omission is marked with the truncated-char count.
    expect(prompt).toContain(`…[truncated ${huge.length - REPAIR_FAIL_EXCERPT_CAP} chars]`);
    // The head of the output NEVER enters the prompt.
    expect(prompt).not.toContain(head);
    // Whole-prompt bound: boilerplate + one excerpt block stays well under
    // the excerpt cap plus headroom.
    expect(prompt.length).toBeLessThan(REPAIR_FAIL_EXCERPT_CAP + 2_000);
  });

  it('keeps a short excerpt verbatim with no truncation marker', () => {
    const prompt = buildKrakenRepairPrompt(gate(), { 'the test suite passes': 'exit 1 (expected 0)' });
    expect(prompt).toContain('exit 1 (expected 0)');
    expect(prompt).not.toContain('…[truncated');
  });

  it('without excerpts the prompt is byte-identical to the legacy directive', () => {
    const legacy = buildKrakenRepairPrompt(gate());
    // Any no-excerpt spelling must reproduce the exact legacy bytes.
    expect(buildKrakenRepairPrompt(gate(), undefined)).toBe(legacy);
    expect(buildKrakenRepairPrompt(gate(), new Map())).toBe(legacy);
    expect(buildKrakenRepairPrompt(gate(), {})).toBe(legacy);
    // Snapshot-ish anchor on the legacy shape: directive + no excerpt blocks.
    expect(legacy).toContain('Recover this turn:');
    expect(legacy).toContain('FAILED checks (evidence contradicts them):');
    expect(legacy).not.toContain('Failure excerpt');
  });

  it('unknown checks join their excerpt too (record and map forms agree)', () => {
    const g = gate({ failedChecks: [], unknownChecks: ['typecheck verdict'], total: 1 });
    const fromRecord = buildKrakenRepairPrompt(g, { 'typecheck verdict': 'command timed out' });
    expect(fromRecord).toContain('Failure excerpt (tail, capped 2000 chars) — typecheck verdict:');
    expect(fromRecord).toContain('command timed out');
    const fromMap = buildKrakenRepairPrompt(g, new Map([['typecheck verdict', 'command timed out']]));
    expect(fromMap).toBe(fromRecord);
  });

  it('uncovered excerpt entries (deterministic pack results) still surface, capped at 5', () => {
    // Gate lists one check; the map carries 9 more (criteria-pack-only shape).
    const entries: Array<[string, string]> = [['the test suite passes', 'exit 1']];
    for (let i = 1; i <= 9; i++) entries.push([`pack criterion ${i}`, `fail ${i}`]);
    const prompt = buildKrakenRepairPrompt(gate(), new Map(entries));
    expect(prompt).toContain('DETERMINISTIC check failures with captured output');
    // Max 5 excerpt blocks per prompt — counted, not assumed.
    const blocks = prompt.split('Failure excerpt (tail, capped 2000 chars)').length - 1;
    expect(blocks).toBe(5);
    // Failed check + the first four uncovered entries win the budget.
    expect(prompt).toContain('pack criterion 4');
    expect(prompt).not.toContain('pack criterion 5');
  });
});
