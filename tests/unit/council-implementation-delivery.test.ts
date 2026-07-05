import { describe, it, expect } from 'vitest';
import {
  buildDeliveryFixPrompt,
  buildImplementationWriteRetryPrompt,
  checkImplementationDelivery,
  filterDeliveryBlockingFails,
} from '../../packages/core/src/council/verification/implementationDelivery.js';
import type { VerificationCheckResult } from '../../packages/core/src/council/verification/types.js';

describe('checkImplementationDelivery', () => {
  it('passes when at least one write succeeded', () => {
    expect(checkImplementationDelivery(1, 2).ok).toBe(true);
  });

  it('fails when writes emitted but none succeeded', () => {
    const r = checkImplementationDelivery(0, 3);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('edit_file');
  });

  it('fails when no write tools emitted', () => {
    const r = checkImplementationDelivery(0, 0);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('write_file');
  });
});

describe('filterDeliveryBlockingFails', () => {
  it('excludes synthesis meta errors', () => {
    const results: VerificationCheckResult[] = [
      {
        id: 'motion.keyframes',
        severity: 'error',
        ok: false,
        tier: 'grep',
        message: 'bad keyframe',
      },
      {
        id: 'synthesis.tier-inflation',
        severity: 'error',
        ok: false,
        tier: 'grep',
        message: 'inflated tier',
      },
    ];
    const blocked = filterDeliveryBlockingFails(results);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.id).toBe('motion.keyframes');
  });
});

describe('buildDeliveryFixPrompt', () => {
  it('lists blocking ids and inline-js hint', () => {
    const p = buildDeliveryFixPrompt(
      [
        {
          id: 'inline-js.budget',
          severity: 'error',
          ok: false,
          tier: 'grep',
          message: '6585 bytes',
          file: 'index.html',
        },
      ],
      'terminal code style',
    );
    expect(p).toMatch(/inline-js\.budget/);
    expect(p).toMatch(/trim the inline/i);
    expect(p).toContain('terminal code style');
  });
});

describe('buildImplementationWriteRetryPrompt', () => {
  it('is imperative and mentions tool calls', () => {
    const p = buildImplementationWriteRetryPrompt('make it terminal style');
    expect(p).toMatch(/IMPLEMENTATION INCOMPLETE/i);
    expect(p).toContain('make it terminal style');
    expect(p).toMatch(/write_file|edit_file/);
  });
});
