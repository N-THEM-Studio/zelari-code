import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyCitations,
  auditSynthesisTiers,
  parseVerificationTable,
  runImplementationVerification,
} from '../../packages/core/src/council/verification/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-synth-audit-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const BAD_HTML = `<!DOCTYPE html>
<html><head><style>
@keyframes dot-breathe { 0% { box-shadow: 0 0 8px blue; } }
.card { transition: box-shadow 160ms ease; }
</style></head><body>
<script>document.documentElement.classList.add('rm');</script>
</body></html>`;

describe('parseVerificationTable', () => {
  it('parses Tier column from verification status table', () => {
    const rows = parseVerificationTable(`## Verification status
| Check | Tier | Status | Evidence |
| Motion budget | grep | PASS | index.html:L10 |
`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.check).toBe('Motion budget');
    expect(rows[0]?.tier).toBe('grep');
    expect(rows[0]?.status).toBe('PASS');
  });
});

describe('verifyCitations', () => {
  it('flags missing file', () => {
    const r = verifyCitations(tmpDir, 'See index.html:L10 for proof.');
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('synthesis.cite-invalid');
  });

  it('flags out-of-range line', () => {
    writeFileSync(join(tmpDir, 'index.html'), '<html></html>\n', 'utf8');
    const r = verifyCitations(tmpDir, 'index.html:L9999');
    expect(r.some((x) => x.id === 'synthesis.cite-invalid' && !x.ok)).toBe(true);
  });

  it('passes valid citation', () => {
    writeFileSync(join(tmpDir, 'index.html'), 'line1\nline2\n', 'utf8');
    const r = verifyCitations(tmpDir, 'index.html:L2');
    expect(r).toHaveLength(0);
  });

  it('returns empty when no citations', () => {
    expect(verifyCitations(tmpDir, 'No path citations here.')).toHaveLength(0);
  });
});

describe('auditSynthesisTiers', () => {
  it('flags PASS when report has motion failures', () => {
    writeFileSync(join(tmpDir, 'index.html'), BAD_HTML, 'utf8');
    const report = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, '.zelari'),
    });
    const synthesis = `## Verification status
| Check | Tier | Status | Evidence |
| Motion budget | grep | PASS | index.html:L5 |
`;
    const r = auditSynthesisTiers(synthesis, report);
    expect(r.some((x) => x.id === 'synthesis.tier-inflation' && !x.ok)).toBe(true);
  });

  it('flags global completion claim when report.ok is false', () => {
    writeFileSync(join(tmpDir, 'index.html'), BAD_HTML, 'utf8');
    const report = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, '.zelari'),
    });
    const r = auditSynthesisTiers('Pronto al commit, nessuna regressione.', report);
    expect(r.some((x) => x.id === 'synthesis.tier-inflation')).toBe(true);
  });
});

describe('runImplementationVerification tier integration', () => {
  it('includes tier on grep results and synthesis.tier-inflation on dishonest table', () => {
    writeFileSync(join(tmpDir, 'index.html'), BAD_HTML, 'utf8');
    const synthesis = `## Verification status
| Check | Tier | Status | Evidence |
| Motion budget | build | PASS | index.html:L5 |
`;
    const report = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, '.zelari'),
      synthesisText: synthesis,
    });
    expect(report.results.some((r) => r.id === 'motion.keyframes' && r.tier === 'grep')).toBe(true);
    expect(report.results.some((r) => r.id === 'synthesis.tier-inflation' && !r.ok)).toBe(true);
  });
});
