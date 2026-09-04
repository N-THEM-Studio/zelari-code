/**
 * tools/eval/sealNormalization.test.ts — cross-platform seal determinism.
 *
 * Regression for the post-v2.30.0 CI failure: anchors were sealed on a
 * Windows checkout (core.autocrlf=true -> CRLF working files) and verified
 * on Linux CI (LF checkout) — every sealed anchor "DRIFTED" at once. Sealed
 * hashes must be a function of anchor CONTENT, never of checkout line
 * endings (docs/EVALS.md #1, ADR-0036).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  computeSealManifest,
  normalizeAnchorText,
  readSealManifest,
  sealPath,
  sha256AnchorFile,
  sha256Text,
  verifySeal,
  writeSealManifest,
} from './sealedAnchors.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'zelari-seal-norm-'));
afterAll(() => {
  // tmpdir — best-effort cleanup is fine (OS reclaims)
});

const LF_BODY = {
  id: 'norm-anchor',
  tier: 0,
  task: 'verify line-ending independence',
  files: [{ path: 'src/a.ts', expected: 'contains guard' }],
};
const LF_TEXT = `${JSON.stringify(LF_BODY, null, 2)}\n`;

function writeAnchor(name: string, text: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

describe('normalizeAnchorText', () => {
  it('CRLF, LF and lone CR hash identically', () => {
    const crlf = LF_TEXT.replace(/\n/g, '\r\n');
    const cr = LF_TEXT.replace(/\n/g, '\r');
    expect(normalizeAnchorText(crlf)).toBe(LF_TEXT);
    expect(normalizeAnchorText(cr)).toBe(LF_TEXT);
    expect(sha256Text(normalizeAnchorText(crlf))).toBe(sha256Text(LF_TEXT));
    expect(sha256Text(normalizeAnchorText(cr))).toBe(sha256Text(LF_TEXT));
  });

  it('strips a UTF-8 BOM before hashing', () => {
    expect(normalizeAnchorText(`\uFEFF${LF_TEXT}`)).toBe(LF_TEXT);
    expect(sha256Text(normalizeAnchorText(`\uFEFF${LF_TEXT}`))).toBe(sha256Text(LF_TEXT));
  });

  it('real content edits still change the hash (drift detection intact)', () => {
    const edited = LF_TEXT.replace('contains guard', 'no guard');
    expect(sha256Text(normalizeAnchorText(edited))).not.toBe(sha256Text(LF_TEXT));
  });
});

describe('seal across line-ending variants', () => {
  it('sealing an LF file verifies against a CRLF checkout of the same content', () => {
    const lfFile = writeAnchor('a-lf.anchor.json', LF_TEXT);
    writeAnchor('a-crlf.anchor.json', LF_TEXT.replace(/\n/g, '\r\n'));

    // seal from the LF variant (CI-style checkout)
    const manifest = computeSealManifest(dir, ['norm-anchor'], '2026-09-05T00:00:00.000Z', null);
    writeSealManifest(sealPath(dir), manifest);

    // rename so the CRLF variant is the file the manifest points at
    const crlfPath = path.join(dir, 'a-crlf.anchor.json');
    const manifestPointingAtCrlf = {
      ...manifest,
      anchors: manifest.anchors.map((a) => ({
        ...a,
        file: 'a-crlf.anchor.json',
        sha256: sha256AnchorFile(lfFile),
      })),
    };
    expect(sha256AnchorFile(crlfPath)).toBe(manifestPointingAtCrlf.anchors[0].sha256);

    writeSealManifest(sealPath(dir), manifestPointingAtCrlf);
    const verification = verifySeal(dir, readSealManifest(sealPath(dir)));
    expect(verification.ok).toBe(true);
    expect(verification.sealedCount).toBe(1);
    expect(verification.problems).toEqual([]);
  });
});
