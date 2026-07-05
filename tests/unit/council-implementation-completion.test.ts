import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkImplementationCompletion,
  buildImplementationVerifyRetryPrompt,
  resolveVerifyRetryTool,
  detectDegradedRun,
  auditDegradedBanner,
  applyDeterministicAutofix,
  runImplementationVerification,
} from '../../packages/core/src/council/verification/index.js';

describe('checkImplementationCompletion', () => {
  const old = process.env.ZELARI_VERIFY_SKIP_TOOL;
  afterEach(() => {
    if (old === undefined) delete process.env.ZELARI_VERIFY_SKIP_TOOL;
    else process.env.ZELARI_VERIFY_SKIP_TOOL = old;
  });

  it('passes when no writes occurred', () => {
    expect(checkImplementationCompletion(['read_file', 'list_files']).ok).toBe(true);
  });

  it('fails when write_file has no verify tool after', () => {
    const r = checkImplementationCompletion(['write_file', 'read_file']);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('grep_content');
  });

  it('passes when grep_content follows write_file', () => {
    const r = checkImplementationCompletion(['write_file', 'grep_content']);
    expect(r.ok).toBe(true);
  });

  it('passes when bash follows edit_file', () => {
    const r = checkImplementationCompletion(['edit_file', 'bash']);
    expect(r.ok).toBe(true);
  });

  it('respects ZELARI_VERIFY_SKIP_TOOL=1', () => {
    process.env.ZELARI_VERIFY_SKIP_TOOL = '1';
    expect(checkImplementationCompletion(['write_file']).ok).toBe(true);
  });
});

describe('resolveVerifyRetryTool', () => {
  it('prefers grep_content when available', () => {
    expect(resolveVerifyRetryTool(new Set(['grep_content', 'bash']))).toBe('grep_content');
  });

  it('falls back to bash', () => {
    expect(resolveVerifyRetryTool(new Set(['bash', 'read_file']))).toBe('bash');
  });
});

describe('buildImplementationVerifyRetryPrompt', () => {
  it('names the verify tool imperatively', () => {
    const p = buildImplementationVerifyRetryPrompt('grep_content');
    expect(p).toContain('grep_content');
    expect(p.toLowerCase()).toContain('no prose');
  });
});

describe('detectDegradedRun', () => {
  it('flags chairman error in implementation mode', () => {
    const r = detectDegradedRun({ chairmanErrored: true, runMode: 'implementation' });
    expect(r.degraded).toBe(true);
    expect(r.reasons).toContain('chairman errored');
  });

  it('ignores degraded signals in design-phase', () => {
    const r = detectDegradedRun({ chairmanErrored: true, runMode: 'design-phase' });
    expect(r.degraded).toBe(false);
  });

  it('flags done claim with zero writes', () => {
    const r = detectDegradedRun({
      luciferWriteCount: 0,
      synthesisText: 'Implementazione completata, pronto al commit.',
      runMode: 'implementation',
    });
    expect(r.degraded).toBe(true);
  });
});

describe('auditDegradedBanner', () => {
  it('warns when degraded run omits banner', () => {
    const r = auditDegradedBanner('Done but no banner.', true);
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('synthesis.degraded-banner');
  });

  it('passes when DEGRADED_RUN present', () => {
    expect(auditDegradedBanner('DEGRADED_RUN: chairman errored', true)).toHaveLength(0);
  });
});

describe('applyDeterministicAutofix', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zelari-autofix-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes dead classList.add and clears css.dead-hook on re-verify', () => {
    const html = `<!DOCTYPE html><html><head><style></style></head><body>
<script>document.documentElement.classList.add('rm');</script></body></html>`;
    writeFileSync(join(tmpDir, 'index.html'), html, 'utf8');
    const before = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, '.zelari'),
    });
    expect(before.results.some((r) => r.id === 'css.dead-hook' && !r.ok)).toBe(true);
    const fix = applyDeterministicAutofix(tmpDir, before);
    expect(fix.applied).toBe(true);
    const after = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, '.zelari'),
    });
    expect(after.results.some((r) => r.id === 'css.dead-hook' && !r.ok)).toBe(false);
  });
});
