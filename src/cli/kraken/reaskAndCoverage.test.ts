/**
 * reaskAndCoverage.test.ts — t56 + t57 unit coverage for the two new
 * modules (`verifyReask.ts`, `exploreCoverage.ts`).
 *
 * Pure logic only: no network (fetch stubbed), no real sidecar dirs for
 * the coverage math (writeTentacleSidecar is exercised against a temp
 * dir via node:fs, which is cheap and honest).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isVerifyReaskEnabled,
  reaskVerifyTrailer,
  VERIFY_REASK_ENV,
} from './verifyReask.js';
import {
  computeCoverage,
  computeAndStoreExploreCoverage,
  extractMentionedPaths,
  normalizePathToken,
  writeTentacleSidecar,
} from './exploreCoverage.js';

const PROVIDER = {
  providerId: 'openai' as const,
  model: 'test-model',
  endpoint: 'https://example.invalid/v1/chat/completions',
  apiKey: 'test-key',
};

function replyWith(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('verifyReask (t56)', () => {
  it('defaults ON; explicit opt-out values disable', () => {
    expect(isVerifyReaskEnabled({})).toBe(true);
    expect(isVerifyReaskEnabled({ [VERIFY_REASK_ENV]: '0' })).toBe(false);
    expect(isVerifyReaskEnabled({ [VERIFY_REASK_ENV]: 'false' })).toBe(false);
    expect(isVerifyReaskEnabled({ [VERIFY_REASK_ENV]: 'no' })).toBe(false);
    expect(isVerifyReaskEnabled({ [VERIFY_REASK_ENV]: '1' })).toBe(true);
  });

  it('returns the restated verdict without any network config of its own', async () => {
    const verdict = await reaskVerifyTrailer('long review … final line was mangled', {
      fetchImpl: replyWith('VERDICT: PASS'),
      providerOverride: PROVIDER,
      env: {},
    });
    expect(verdict).toBe('pass');
  });

  it('returns null when the re-ask still yields no parseable trailer', async () => {
    const verdict = await reaskVerifyTrailer('review text', {
      fetchImpl: replyWith('I cannot determine anything.'),
      providerOverride: PROVIDER,
      env: {},
    });
    expect(verdict).toBe(null);
  });

  it('returns null without calling the provider when disabled', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const verdict = await reaskVerifyTrailer('review text', {
      fetchImpl,
      providerOverride: PROVIDER,
      env: { [VERIFY_REASK_ENV]: '0' },
    });
    expect(verdict).toBe(null);
    expect(called).toBe(false);
  });

  it('returns null on HTTP failure (fail-open, never throws)', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(
      reaskVerifyTrailer('review text', { fetchImpl: failing, providerOverride: PROVIDER, env: {} }),
    ).resolves.toBe(null);
  });
});

describe('exploreCoverage (t57)', () => {
  const cwd = path.join(tmpdir(), 'zelari-test-repo');

  it('normalizes win32 + posix tokens to lowercase repo-relative keys', () => {
    expect(normalizePathToken('src/cli/a.ts', cwd)).toBe('src/cli/a.ts');
    expect(normalizePathToken('./Src\\CLI\\A.ts', cwd)).toBe('src/cli/a.ts');
    expect(normalizePathToken('`src/cli/a.ts`.', cwd)).toBe('src/cli/a.ts');
    expect(normalizePathToken('node_modules/foo/index.js', cwd)).toBe(null);
    expect(normalizePathToken('notapath', cwd)).toBe(null);
    expect(normalizePathToken('https://example.com/x.ts', cwd)).toBe(null);
  });

  it('extracts mentioned paths from prose', () => {
    const paths = extractMentionedPaths(
      'Il planner tocchera src/cli/kraken/executor.ts e packages/core/src/index.ts.',
      cwd,
    );
    expect(paths.has('src/cli/kraken/executor.ts')).toBe(true);
    expect(paths.has('packages/core/src/index.ts')).toBe(true);
  });

  it('computeCoverage: ratio of touched covered by explore; null on empty touched', () => {
    const mentioned = new Set(['a.ts', 'b.ts']);
    const touched = new Set(['b.ts', 'c.ts']);
    expect(computeCoverage(mentioned, touched)).toEqual({
      mentionedCount: 2,
      touchedCount: 2,
      coveredCount: 1,
      ratio: 0.5,
    });
    expect(computeCoverage(mentioned, new Set())).toBe(null);
  });

  it('writes sidecars and computes the report end-to-end (fail-open)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-sidecar-'));
    try {
      await writeTentacleSidecar(dir, 'sess-1', 'n-explore', {
        agent: 'explore',
        result: 'Conclusione: guardare src/a.ts e src/b.ts.',
      });
      await writeTentacleSidecar(dir, 'sess-1', 'n-general', {
        agent: 'general',
        result: 'Modificati src/a.ts e src/z.ts.',
      });
      const report = await computeAndStoreExploreCoverage(dir, 'sess-1');
      expect(report).not.toBe(null);
      expect(report!.touched.sort()).toEqual(['src/a.ts', 'src/z.ts']);
      expect(report!.covered).toEqual(['src/a.ts']);
      expect(report!.ratio).toBeCloseTo(0.5);
      // report persisted next to the sidecars
      const onDisk = JSON.parse(
        readFileSync(path.join(dir, '.zelari', 'radio', 'tentacles', 'sess-1', 'coverage.json'), 'utf8'),
      ) as { ratio: number };
      expect(onDisk.ratio).toBeCloseTo(0.5);
      // no writer sidecars → null, nothing written
      await expect(computeAndStoreExploreCoverage(dir, 'sess-empty')).resolves.toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
