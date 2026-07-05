import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFailure } from '../../packages/core/src/council/lessons/index.js';
import { buildLessonsSummary } from '../../src/cli/workspace/buildLessonsSummary.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-lessons-summary-'));
  mkdirSync(join(tmpDir, '.zelari'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildLessonsSummary', () => {
  it('returns enforced tier-inflation lesson for matching task', () => {
    const zelari = join(tmpDir, '.zelari');
    const check = {
      id: 'synthesis.tier-inflation' as const,
      severity: 'error' as const,
      ok: false,
      message: 'Synthesis claims PASS for motion but report has failing motion checks',
    };
    captureFailure(zelari, check);
    captureFailure(zelari, check);

    const block = buildLessonsSummary(
      tmpDir,
      'council motion verification tier inflation fix',
    );
    expect(block).not.toBeNull();
    expect(block).toContain('synthesis.tier-inflation');
    expect(block).toContain('[enforced]');
  });

  it('returns null when no lessons file', () => {
    expect(buildLessonsSummary(tmpDir, 'any task')).toBeNull();
  });
});
