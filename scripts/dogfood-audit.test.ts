/**
 * scripts/dogfood-audit.test.ts — t52 (W5.2 dogfooding), deterministic half.
 *
 * The audit must NEVER fake green: empty synthesis and empty diff are exit 2
 * INSUFFICIENT-DATA, an ungrounded path claim is exit 1, only a path that is in
 * `git diff --name-only` may exit 0. Every scenario below runs against a
 * throwaway git repo in os.tmpdir(), so no network (or real history) is needed
 * and nothing is written inside the product tree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { auditClaims, extractClaims } from './dogfood-audit.mjs';

const AUDIT = fileURLToPath(new URL('./dogfood-audit.mjs', import.meta.url));
const repos: string[] = [];

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** base commit (src.txt) + one change on top (src/bar.ts); returns the base sha. */
function makeRepo(renameSecondCommit = false): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'zelari-dogfood-audit-'));
  repos.push(dir);
  const run = (args: string[]) => git(dir, args);
  run(['init', '-q']);
  run(['config', 'user.email', 'dogfood@example.invalid']);
  run(['config', 'user.name', 'dogfood audit test']);
  writeFileSync(path.join(dir, 'src.txt'), 'base\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'base']);
  const first = run(['rev-parse', 'HEAD']).trim();
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'bar.ts'), 'export const bar = 1;\n');
  writeFileSync(path.join(dir, 'docs', 'note.md'), '# note\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'add src/bar.ts']);
  // A rename is only visible against a base that already contains the old path.
  const added = run(['rev-parse', 'HEAD']).trim();
  let base = first;
  if (renameSecondCommit) {
    base = added;
    run(['mv', 'src/bar.ts', 'src/baz.ts']);
    run(['commit', '-q', '-m', 'rename bar -> baz']);
  }
  return { dir, base, head: run(['rev-parse', 'HEAD']).trim() };
}

function runAudit(repo: string, args: string[], input?: string) {
  const reportPath = path.join(repo, 'audit.md');
  const res = spawnSync(process.execPath, [AUDIT, ...args, '--cwd', repo, '--out', reportPath], {
    cwd: repo,
    encoding: 'utf8',
    input: input ?? '',
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    report: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '',
  };
}

describe('dogfood-audit CLI (throwaway git repo)', () => {
  it('empty synthesis exits 2 INSUFFICIENT-DATA (never green)', () => {
    const { dir, base } = makeRepo();
    const res = runAudit(dir, ['--synthesis', '-', '--base', base]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('INSUFFICIENT-DATA');
    expect(res.stdout).toContain('INSUFFICIENT-DATA (exit 2)');
    expect(res.report).not.toContain('**PASS**'); // the status field never claims green
    expect(res.report).toContain('**INSUFFICIENT-DATA**');
  });

  it('empty diff (identical trees) exits 2 even with a concrete claim', () => {
    const { dir, head } = makeRepo();
    const synthesis = path.join(dir, 'synthesis.md');
    writeFileSync(synthesis, 'I landed `src/bar.ts`.\n');
    const res = runAudit(dir, ['--synthesis', synthesis, '--base', head]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('empty diff');
  });

  it('ungrounded path claim exits 1', () => {
    const { dir, base } = makeRepo();
    const res = runAudit(dir, ['--synthesis', '-', '--base', base], 'I landed `src/foo.ts`.\n');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('FAIL (exit 1)');
    expect(res.report).toContain('| `src/foo.ts` | ungrounded |');
  });

  it('claim present in the diff exits 0 (stdin) and is reported grounded', () => {
    const { dir, base } = makeRepo();
    const res = runAudit(dir, ['--synthesis', '-', '--base', base], 'I landed `src/bar.ts` and `docs/note.md`.\n');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PASS (exit 0)');
    expect(res.report).toContain('| `src/bar.ts` | grounded |');
    expect(res.report).toContain('| `docs/note.md` | grounded |');
  });

  it('rename source is mentioned in the diff body but NOT grounded (exit 1)', () => {
    const { dir, base } = makeRepo(true);
    const res = runAudit(dir, ['--synthesis', '-', '--base', base], 'I rewrote `src/bar.ts`.\n');
    expect(res.status).toBe(1);
    expect(res.report).toContain('appears in the diff body only');
  });

  it('zero path claims is exit 0 but labelled NO-PATH-CLAIMS with the ground list', () => {
    const { dir, base } = makeRepo();
    const res = runAudit(dir, ['--synthesis', '-', '--base', base], 'Refactored the audit tooling, no files worth naming.\n');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('NO-PATH-CLAIMS');
    expect(res.report).toContain('## Ground (not claimed)');
    expect(res.report).toContain('- `src/bar.ts`');
  });

  it('rejects an unknown flag with exit 2 and a usage line', () => {
    const { dir, base } = makeRepo();
    const res = runAudit(dir, ['--synthesis', '-', '--base', base, '--bogus']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('unknown argument');
  });
});

describe('dogfood-audit decision core (pure)', () => {
  it('maps inputs to the exit-code contract', () => {
    const base = 'origin/main';
    expect(auditClaims({ synthesis: '   \n', diffPaths: ['src/bar.ts'], base }).exitCode).toBe(2);
    expect(auditClaims({ synthesis: '`src/bar.ts`', diffPaths: [], base }).exitCode).toBe(2);
    expect(auditClaims({ synthesis: '`src/foo.ts`', diffPaths: ['src/bar.ts'], base }).exitCode).toBe(1);
    expect(auditClaims({ synthesis: '`src/bar.ts`', diffPaths: ['src/bar.ts'], base }).exitCode).toBe(0);
    expect(auditClaims({ synthesis: 'no claims here', diffPaths: ['src/bar.ts'], base }).status).toBe('no-path-claims');
  });

  it('extracts path claims, ignores URLs and keeps identifiers informational', () => {
    const { paths, identifiers } = extractClaims(
      'See `src/bar.ts`, docs/GUIDA.md, https://example.com/fake/lib.ts and `evaluateFlipGate` vs origin/main.',
    );
    expect(paths).toEqual(['src/bar.ts', 'docs/GUIDA.md']);
    expect(identifiers).toContain('evaluateFlipGate');
    expect(identifiers).toContain('origin/main'); // informational only, never scored as a path
    expect(paths).not.toContain('origin/main');
    expect(paths).not.toContain('example.com/fake/lib.ts');
  });
});
