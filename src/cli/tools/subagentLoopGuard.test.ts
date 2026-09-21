/**
 * subagentLoopGuard.test — t157 (P2c) of the 2026-09-21 tentacle plan.
 *
 * Pure unit coverage of the cross-turn degenerate-loop guard: the exact
 * threshold, the ineligible outputs (empty / too short), the 1-char-different
 * near miss, the reset rule, and the parent-facing stop line.
 */
import { describe, expect, it } from 'vitest';
import {
  DEGENERATE_LOOP_THRESHOLD,
  DEGENERATE_MIN_LENGTH,
  DEGENERATE_SAMPLE_MAX,
  createLoopGuard,
  formatDegenerateLoopStop,
  normalizeAssistantText,
} from './subagentLoopGuard.js';

/** Eligible (longer than DEGENERATE_MIN_LENGTH) status-theater line. */
const LOOP_LINE = 'Bene, dungeon.js fatto. Aggiorno todo e procedo con inventory adesso.';

function observeAll(guard: ReturnType<typeof createLoopGuard>, texts: string[]) {
  return texts.map((t) => guard.observe(t));
}

describe('t157 — subagentLoopGuard (P2c)', () => {
  it('normalizes case and whitespace collapse', () => {
    expect(normalizeAssistantText('  Bene.\n\n  PROCEDO   con   il   fix  ')).toBe(
      'bene. procedo con il fix',
    );
  });

  it('trips on the Nth identical message, not before (exact threshold)', () => {
    const guard = createLoopGuard();
    const verdicts = observeAll(guard, [
      LOOP_LINE,
      LOOP_LINE,
      LOOP_LINE,
    ]);
    expect(verdicts[0]).toMatchObject({ degenerate: false, repetitions: 1 });
    expect(verdicts[1]).toMatchObject({ degenerate: false, repetitions: 2 });
    expect(verdicts[DEGENERATE_LOOP_THRESHOLD - 1]).toMatchObject({
      degenerate: true,
      repetitions: DEGENERATE_LOOP_THRESHOLD,
    });
    expect(verdicts[DEGENERATE_LOOP_THRESHOLD - 1]!.sample).toContain('aggiorno todo');
  });

  it('stays degenerate-and-counting on further identical messages', () => {
    const guard = createLoopGuard();
    observeAll(guard, [LOOP_LINE, LOOP_LINE, LOOP_LINE]);
    const fourth = guard.observe(LOOP_LINE);
    expect(fourth.degenerate).toBe(true);
    expect(fourth.repetitions).toBe(4);
  });

  it('ignores the 1-char difference (near miss never trips)', () => {
    const guard = createLoopGuard();
    const variant = 'Bene, dungeon.js fatto. Aggiorno todo e procedo con inventory adesan.';
    const verdicts = observeAll(guard, [
      LOOP_LINE,
      variant,
      LOOP_LINE,
      variant,
      LOOP_LINE,
      variant,
    ]);
    expect(verdicts.every((v) => !v.degenerate)).toBe(true);
    expect(verdicts[verdicts.length - 1]!.repetitions).toBe(1);
  });

  it('never trips on empty output, even when repeated', () => {
    const guard = createLoopGuard();
    const verdicts = observeAll(guard, ['', '', '', '   \n  ', '']);
    expect(verdicts.every((v) => !v.degenerate)).toBe(true);
  });

  it('never trips on short output ("OK" / "Done" chatter)', () => {
    const guard = createLoopGuard();
    const verdicts = observeAll(guard, ['OK', 'OK', 'OK', 'OK', 'OK']);
    expect(verdicts.every((v) => !v.degenerate)).toBe(true);
  });

  it('accepts exactly MIN_LENGTH+1 chars and rejects exactly MIN_LENGTH', () => {
    const atLimit = 'a'.repeat(DEGENERATE_MIN_LENGTH);
    const overLimit = 'a'.repeat(DEGENERATE_MIN_LENGTH + 1);

    const exact = createLoopGuard();
    expect(observeAll(exact, [atLimit, atLimit, atLimit]).every((v) => !v.degenerate)).toBe(true);

    const over = createLoopGuard();
    const overVerdicts = observeAll(over, [overLimit, overLimit, overLimit]);
    expect(overVerdicts[overVerdicts.length - 1]!.degenerate).toBe(true);
  });

  it('resets the streak after a different output', () => {
    const guard = createLoopGuard();
    const other = 'Fatto. Ora passo alla verifica dei test del modulo budget.';
    const verdicts = observeAll(guard, [
      LOOP_LINE,
      LOOP_LINE,
      other,
      LOOP_LINE,
      LOOP_LINE,
      LOOP_LINE,
    ]);
    expect(verdicts[1]!.degenerate).toBe(false);
    // The different (eligible) output restarts the run at 1 …
    expect(verdicts[2]).toMatchObject({ degenerate: false, repetitions: 1 });
    // … and the first LOOP_LINE after it restarts the run again (it is a
    // different output from `other`), so only the third occurrence trips.
    expect(verdicts[3]).toMatchObject({ degenerate: false, repetitions: 1 });
    expect(verdicts[4]!.repetitions).toBe(2);
    expect(verdicts[5]).toMatchObject({
      degenerate: true,
      repetitions: DEGENERATE_LOOP_THRESHOLD,
    });
  });

  it('a tool-only turn (empty assistant text) breaks the streak', () => {
    const guard = createLoopGuard();
    const verdicts = observeAll(guard, [LOOP_LINE, '', LOOP_LINE, '', LOOP_LINE]);
    expect(verdicts.every((v) => !v.degenerate)).toBe(true);
  });

  it('treats a reflowed/re-cased repeat as the same output', () => {
    const guard = createLoopGuard();
    const verdicts = observeAll(guard, [
      LOOP_LINE,
      LOOP_LINE.toUpperCase(),
      `  ${LOOP_LINE.replace(/ /g, '   ')}  `,
    ]);
    expect(verdicts[2]).toMatchObject({
      degenerate: true,
      repetitions: DEGENERATE_LOOP_THRESHOLD,
    });
  });

  it('caps the sample and reset() forgets the streak', () => {
    const guard = createLoopGuard();
    const long = 'x'.repeat(DEGENERATE_SAMPLE_MAX * 3);
    const verdict = guard.observe(long);
    expect(verdict.sample.length).toBe(DEGENERATE_SAMPLE_MAX);
    guard.observe(long);
    guard.reset();
    expect(guard.observe(long)).toMatchObject({ degenerate: false, repetitions: 1 });
  });

  it('formats the parent-facing stop line (reason + turn + sample)', () => {
    const line = formatDegenerateLoopStop({
      turn: 7,
      repetitions: DEGENERATE_LOOP_THRESHOLD,
      sample: 'bene, procedo con il fix',
    });
    expect(line).toContain('degenerate loop detected');
    expect(line).toContain('same assistant output repeated 3 times');
    expect(line).toContain('turn 7');
    expect(line).toContain('bene, procedo con il fix');
  });
});
