/**
 * council-motion-fix.test.ts
 *
 * Increment 4: after Lucifero writes, deterministic motion violations drive a
 * bounded fix pass instead of a per-write warning flood (Increment 3) and
 * instead of trusting Lucifero's optimistic "PASS" self-report. This covers the
 * pure prompt builder that instructs the scoped fix turn.
 *
 * @see docs/plans/2026-07-05-council-reliable-verification-architecture.md
 */
import { describe, it, expect } from 'vitest';
import { buildMotionFixPrompt } from '@zelari/core/council';
import type { MicroGateWarning } from '@zelari/core/council';

describe('buildMotionFixPrompt', () => {
  const violations: MicroGateWarning[] = [
    { id: 'motion.keyframes', message: '@keyframes uses non-allowed property "box-shadow"', file: 'index.html', line: 660 },
    { id: 'motion.transitions', message: 'transition uses non-allowed property "grid-template-rows"', file: 'index.html', line: 463 },
    { id: 'css.dead-hook', message: "classList.add('rm') has no CSS rule (.rm)", file: 'index.html' },
  ];

  it('states the count and constrains the model to fix only the listed items', () => {
    const p = buildMotionFixPrompt(violations);
    expect(p).toContain('3 motion violation(s)');
    expect(p).toMatch(/Fix ONLY these/i);
    expect(p).toMatch(/do not add features/i);
  });

  it('lists each violation with file:line and message', () => {
    const p = buildMotionFixPrompt(violations);
    expect(p).toContain('index.html:L660');
    expect(p).toContain('box-shadow');
    expect(p).toContain('index.html:L463');
    expect(p).toContain('grid-template-rows');
    // Dead-hook has no line → file only.
    expect(p).toMatch(/index\.html: classList\.add\('rm'\)/);
  });

  it('spells out the transform/opacity rule and the classList/CSS rule', () => {
    const p = buildMotionFixPrompt(violations);
    expect(p).toMatch(/animate ONLY transform and opacity/i);
    expect(p).toMatch(/classList\.add\('x'\).*matching '\.x' CSS rule/i);
    expect(p).toMatch(/read_file .* edit_file/i);
  });

  it('handles a single violation', () => {
    const p = buildMotionFixPrompt([violations[0]!]);
    expect(p).toContain('1 motion violation(s)');
    expect(p).toContain('index.html:L660');
  });
});
