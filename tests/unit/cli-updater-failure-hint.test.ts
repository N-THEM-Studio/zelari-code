/**
 * Tests for the update-failure hint builder (v1.0.3).
 *
 * When `/update --yes` (or any other path that calls performUpdate) fails,
 * we want the user to see a SHORT, TARGETED recovery hint based on the
 * actual npm error. This is much better than just dumping the full npm
 * output and hoping the user can read it. The test pins each branch of
 * the heuristic so a future refactor doesn't silently regress the
 * "command not found" failure mode that motivated v1.0.3.
 */

import { describe, it, expect } from 'vitest';
import { buildUpdateFailureHint } from '../../src/cli/slashHandlers/updater';

describe('buildUpdateFailureHint', () => {
  it('returns a peer-deps hint on ERESOLVE / EPEERINVALID', () => {
    const hint = buildUpdateFailureHint(
      'npm ERR! ERESOLVE could not resolve',
      'While resolving: @zelari/core@1.0.1',
      1,
    );
    expect(hint).toMatch(/peer-dependency conflict/);
    expect(hint).toMatch(/--legacy-peer-deps/);
    expect(hint).toMatch(/--force/);
  });

  it('returns a permission hint on EACCES / EPERM', () => {
    const hint = buildUpdateFailureHint(
      'npm ERR! code EACCES',
      'permission denied',
      1,
    );
    expect(hint).toMatch(/permission denied/);
    // POSIX fix should mention the npmjs docs URL or sudo guidance.
    expect(hint.toLowerCase()).toMatch(/(sudo|administrator|eacces)/);
  });

  it('returns a PATH / npm-missing hint on ENOENT for npm', () => {
    const hint = buildUpdateFailureHint(
      'spawn npm ENOENT',
      '',
      1,
    );
    expect(hint).toMatch(/npm.*not found/i);
    expect(hint).toMatch(/PATH/);
  });

  it('returns a shim-repair hint when output mentions zelari-code + not found / shim', () => {
    // The classic Windows + npm 10/11 case: npm exits 0 but the shim is
    // missing, and the next `zelari-code` call says "not found". We don't
    // have npm's exit code in that case (it's 0 from npm's perspective),
    // so the hint should fire on the output text alone.
    const hint = buildUpdateFailureHint(
      'install ok',
      'zelari-code: command not found after install',
      0,
    );
    expect(hint).toMatch(/shim/i);
    expect(hint).toMatch(/--force/);
    expect(hint).toMatch(/zelari-code doctor/);
  });

  it('returns a shim-repair hint on EEXIST (shim already exists, blocked)', () => {
    const hint = buildUpdateFailureHint(
      'EEXIST: file already exists',
      'could not create zelari-code.cmd',
      1,
    );
    expect(hint).toMatch(/--force/);
  });

  it('returns a generic hint with a --force suggestion when the error is unrecognized', () => {
    const hint = buildUpdateFailureHint(
      'something completely weird happened',
      'no matching pattern',
      42,
    );
    expect(hint).toMatch(/--force/);
    // On Windows, the generic hint should also suggest the doctor.
    // The platform branch is runtime-dependent, so we just check the
    // generic case is present.
    expect(hint).toMatch(/--verbose/);
  });

  it('always includes actionable content (a fix command) regardless of input', () => {
    const cases: Array<[string, string, number | null]> = [
      ['', '', null],
      ['some error', 'some output', 1],
      ['', '', 0],
    ];
    for (const [err, out, code] of cases) {
      const hint = buildUpdateFailureHint(err, out, code);
      // Each hint should contain at least one of the recovery actions
      // (or the generic --verbose fallback that tells the user how to
      // get more detail).
      expect(hint).toMatch(/--force|--legacy-peer-deps|--verbose|doctor|PATH/);
    }
  });
});
