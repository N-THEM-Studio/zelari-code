import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMotionAutofix,
  runImplementationVerification,
  scanKeyframesViolations,
  scanTransitionViolations,
} from '../../packages/core/src/council/verification/index.js';

const FAIL_HTML = `<!DOCTYPE html><html><head><style>
@keyframes shimmer { to { background-position: 200% center; } }
.card { transition: box-shadow 300ms ease, transform 200ms ease; }
</style></head><body><script>document.documentElement.classList.add('rm');</script></body></html>`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-motion-autofix-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('applyMotionAutofix', () => {
  it('sanitizes forbidden keyframe/transition props and injects .rm CSS', () => {
    writeFileSync(join(tmpDir, 'index.html'), FAIL_HTML, 'utf8');
    const before = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, '.zelari'),
    });
    expect(before.ok).toBe(false);

    const fix = applyMotionAutofix(tmpDir, before);
    expect(fix.applied).toBe(true);
    expect(fix.filesChanged).toContain('index.html');

    const html = readFileSync(join(tmpDir, 'index.html'), 'utf8');
    expect(html).toMatch(/\.rm\s*\*/);
    const scanOpts = { compositorOnly: true, forbidLayoutProps: true };
    expect(scanKeyframesViolations(html, scanOpts)).toHaveLength(0);
    expect(
      scanTransitionViolations(html, scanOpts).filter((v) => v.property === 'box-shadow'),
    ).toHaveLength(0);

    const after = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, '.zelari'),
    });
    expect(after.results.some((r) => r.id === 'motion.keyframes' && !r.ok)).toBe(false);
    expect(after.results.some((r) => r.id === 'css.dead-hook' && !r.ok)).toBe(false);
  });

  it('no-ops when report has no motion failures', () => {
    const clean = `<!DOCTYPE html><html><head><style>
.reveal { transition: transform 300ms ease; }
</style></head><body></body></html>`;
    writeFileSync(join(tmpDir, 'index.html'), clean, 'utf8');
    const report = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, '.zelari'),
    });
    const fix = applyMotionAutofix(tmpDir, report);
    expect(fix.applied).toBe(false);
    expect(fix.filesChanged).toHaveLength(0);
  });
});
