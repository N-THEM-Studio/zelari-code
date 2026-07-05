import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pickSmokeScript,
  runProjectSmoke,
} from '../../src/cli/workspace/projectSmoke.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-smoke-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('pickSmokeScript', () => {
  it('prefers typecheck over test and build', () => {
    expect(
      pickSmokeScript({ build: 'x', test: 'y', typecheck: 'z' }),
    ).toBe('typecheck');
  });

  it('falls back to test then build', () => {
    expect(pickSmokeScript({ build: 'b', test: 't' })).toBe('test');
    expect(pickSmokeScript({ build: 'b' })).toBe('build');
  });

  it('returns null when no smoke scripts', () => {
    expect(pickSmokeScript({ lint: 'eslint .' })).toBeNull();
  });
});

describe('runProjectSmoke', () => {
  const oldSmoke = process.env.ZELARI_SMOKE;

  afterEach(() => {
    if (oldSmoke === undefined) delete process.env.ZELARI_SMOKE;
    else process.env.ZELARI_SMOKE = oldSmoke;
  });

  it('skips when no package.json', async () => {
    const r = await runProjectSmoke(tmpDir);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('package.json');
  });

  it('skips when no typecheck/test/build script', async () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' } }),
      'utf8',
    );
    const r = await runProjectSmoke(tmpDir);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('skipped');
  });

  it('runs typecheck script and reports PASS', async () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        scripts: { typecheck: 'node -e "process.exit(0)"' },
      }),
      'utf8',
    );
    const r = await runProjectSmoke(tmpDir);
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.script).toBe('typecheck');
  }, 30_000);
});
