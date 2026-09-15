/**
 * updater install-kind classification — makes `/update` and the doctor aware
 * that an npx/local copy has no global install to update (ADR-0038).
 *
 * resolveInstallKind takes its two inputs (npm prefix + package root) as
 * parameters, so the classification is tested hermetically: no npm spawn and
 * no filesystem mocking.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  resolveInstallKind,
  nonGlobalUpdateAdvisory,
} from '../../src/cli/updater';

// A base path that is never the temp dir and never contains `_npx`.
const BASE = path.resolve(path.sep + 'zelari-install-fixture');

describe('resolveInstallKind', () => {
  it('classifies a package under the npm global prefix as global', () => {
    const prefix = path.join(BASE, 'npm');
    expect(
      resolveInstallKind(prefix, path.join(prefix, 'node_modules', 'zelari-code')),
    ).toBe('global');
    // Some layouts nest the package directly under the prefix.
    expect(resolveInstallKind(prefix, prefix)).toBe('global');
  });

  it('classifies a checkout outside the prefix as local', () => {
    expect(
      resolveInstallKind(
        path.join(BASE, 'npm'),
        path.join(BASE, 'projects', 'zelari-code'),
      ),
    ).toBe('local');
  });

  it('classifies an npx cache path (_npx) as npx', () => {
    const root = path.join(BASE, '_npx', '1a2b3c', 'node_modules', 'zelari-code');
    // Even though a global prefix is provided, the _npx marker wins.
    expect(resolveInstallKind(path.join(BASE, 'npm'), root)).toBe('npx');
  });

  it('classifies a package under the OS temp dir as npx', () => {
    const root = path.join(
      os.tmpdir(),
      'zelari-npx-copy',
      'node_modules',
      'zelari-code',
    );
    expect(resolveInstallKind(null, root)).toBe('npx');
  });

  it('returns unknown when the npm prefix cannot be resolved', () => {
    expect(resolveInstallKind(null, path.join(BASE, 'checkout'))).toBe('unknown');
  });

  it('still detects npx when the prefix probe failed', () => {
    const root = path.join(
      os.tmpdir(),
      '_npx',
      'deadbeef',
      'node_modules',
      'zelari-code',
    );
    expect(resolveInstallKind(null, root)).toBe('npx');
  });
});

describe('nonGlobalUpdateAdvisory', () => {
  it('points every non-global kind at npx and at a persistent global install', () => {
    for (const kind of ['npx', 'local'] as const) {
      const msg = nonGlobalUpdateAdvisory(kind);
      expect(msg).toMatch(/self-update is disabled/);
      expect(msg).toMatch(/npx zelari-code@latest/);
      expect(msg).toMatch(/npm install -g zelari-code/);
    }
  });

  it('distinguishes the npx wording from the local/source wording', () => {
    expect(nonGlobalUpdateAdvisory('npx')).toMatch(/via npx/);
    expect(nonGlobalUpdateAdvisory('local')).toMatch(/local\/source install/);
  });
});
