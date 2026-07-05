import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAnswerLeak,
  captureFailure,
  recallLessons,
  formatLessonsForContext,
} from '../../packages/core/src/council/lessons/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-lessons-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('isAnswerLeak', () => {
  it('rejects flag-shaped secrets', () => {
    expect(isAnswerLeak('Use flag{abc123} in the fix').leak).toBe(true);
  });

  it('rejects test workspace names', () => {
    expect(isAnswerLeak('Replay on TESTMCP workspace').leak).toBe(true);
  });

  it('allows methodology text', () => {
    expect(
      isAnswerLeak('Grep @keyframes before PASS; only transform and opacity allowed.'),
    ).toEqual({ leak: false });
  });
});

describe('captureFailure', () => {
  it('rejects leak-shaped methodology', () => {
    const r = captureFailure(tmpDir, {
      id: 'synthesis.honesty',
      severity: 'error',
      ok: false,
      message: 'flag{deadbeef} in synthesis',
    });
    expect(r.rejected).toBe(true);
    expect(r.captured).toBe(false);
  });

  it('writes advisory lesson on first FAIL', () => {
    const r = captureFailure(tmpDir, {
      id: 'synthesis.tier-inflation',
      severity: 'error',
      ok: false,
      message: 'Synthesis claims PASS for motion but report has failing motion.* checks',
    });
    expect(r.captured).toBe(true);
    expect(r.lesson?.tier).toBe('advisory');
    const raw = readFileSync(join(tmpDir, 'lessons.jsonl'), 'utf8');
    expect(raw).toContain('synthesis.tier-inflation');
  });

  it('promotes to enforced on second recurrence', () => {
    const check = {
      id: 'synthesis.tier-inflation' as const,
      severity: 'error' as const,
      ok: false,
      message: 'Synthesis tier grep exceeds achieved tier claimed for motion budget',
    };
    captureFailure(tmpDir, check);
    const second = captureFailure(tmpDir, check);
    expect(second.lesson?.recurrence).toBe(2);
    expect(second.lesson?.tier).toBe('enforced');
  });
});

describe('recallLessons', () => {
  it('recalls enforced tier-inflation lesson for matching task', () => {
    const check = {
      id: 'synthesis.tier-inflation' as const,
      severity: 'error' as const,
      ok: false,
      message: 'Synthesis claims PASS for motion but report has failing motion checks',
    };
    captureFailure(tmpDir, check);
    captureFailure(tmpDir, check);

    const lessons = recallLessons(tmpDir, {
      taskText: 'fix synthesis tier inflation on motion verification',
      maxLessons: 5,
    });
    expect(lessons.some((l) => l.checkId === 'synthesis.tier-inflation' && l.tier === 'enforced')).toBe(true);

    const block = formatLessonsForContext(lessons);
    expect(block).toContain('synthesis.tier-inflation');
    expect(block).toContain('[enforced]');
  });

  it('respects maxBytes budget', () => {
    for (let i = 0; i < 8; i++) {
      captureFailure(tmpDir, {
        id: 'motion.keyframes',
        severity: 'error',
        ok: false,
        message: `keyframes violation variant ${i} with extra words for size`,
      });
    }
    const lessons = recallLessons(tmpDir, { maxLessons: 5, maxBytes: 400 });
    expect(lessons.length).toBeLessThanOrEqual(5);
    const serialized = JSON.stringify(lessons);
    expect(serialized.length).toBeLessThanOrEqual(500);
  });
});
