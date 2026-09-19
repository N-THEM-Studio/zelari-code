/**
 * callerTmp.test.ts — t116 (sandbox hardening, part c): the temp directory a
 * jail may write to comes from the CALLER, not from an internal `tmpdir()`.
 *
 * The spec builder still tolerates a pre-t116 call site that never resolved a
 * temp dir (back-compat, asserted below) — but a caller that passes one always
 * wins, which is the property this file pins.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { buildJailSpec, defaultWritable } from '../osJail.js';

const CALLER_TMP = path.resolve(os.tmpdir(), 'zelari-caller-tmp-fixture');

describe('caller-supplied temp dir (t116c)', () => {
  it('buildJailSpec uses the tmp the caller resolved — never the ambient one', () => {
    const spec = buildJailSpec({ root: path.resolve('/ws-fixture'), tmp: CALLER_TMP });
    expect(spec.writable).toContain(CALLER_TMP);
    expect(spec.writable).toHaveLength(3); // root + caller tmp + ~/.zelari-code
    expect(spec.writable[0]).toBe(path.resolve('/ws-fixture'));
  });

  it('defaultWritable takes tmp as an explicit argument (no internal derivation)', () => {
    const w = defaultWritable('/ws-fixture', '/home/u', CALLER_TMP, 'linux');
    expect(w).toContain(CALLER_TMP);
    expect(w).toContain(path.join('/home/u', '.zelari-code'));
  });

  it('a caller tmp that equals the root still collapses (dedup stays intact)', () => {
    const w = defaultWritable(CALLER_TMP, '/home/u', CALLER_TMP, 'linux');
    expect(w).toHaveLength(2);
  });

  it('legacy call site without tmp still gets a usable spec (back-compat)', () => {
    const spec = buildJailSpec({ root: path.resolve('/ws-fixture') });
    expect(spec.writable).toHaveLength(3);
    expect(spec.writable[0]).toBe(path.resolve('/ws-fixture'));
  });
});
