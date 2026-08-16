/**
 * planDriftCheck tests — P1.5 governance acceptance (v0.10 post-mortem).
 *
 * Covers: aligned plan (green), duplicate milestone, canonical blocklist
 * hits (phase + task), canonical phase missing from plan.json, duplicate
 * task titles, unknown phaseId, fail-open skips (missing plan.json,
 * ZELARI_DRIFT_CHECK=0, no canonical doc), and the drift-report.json
 * artifact.
 *
 * @since v1.15.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanDriftCheck } from './planDriftCheck.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zelari-drift-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['ZELARI_DRIFT_CHECK'];
});

function zelari(): string {
  const z = join(dir, '.zelari');
  mkdirSync(z, { recursive: true });
  return z;
}

function seedPlan(phases: unknown[], tasks: unknown[], milestones: unknown[]): string {
  const z = zelari();
  writeFileSync(
    join(z, 'plan.json'),
    JSON.stringify({ phases, tasks, milestones }),
    'utf8',
  );
  return z;
}

function seedCanonical(text: string): void {
  mkdirSync(join(dir, '.zelari', 'docs'), { recursive: true });
  writeFileSync(join(dir, '.zelari', 'docs', 'plan-canonical-v9-9-9.md'), text, 'utf8');
}

const CANONICAL = [
  '# Piano canonico',
  '## Regola',
  'Duplicati: `p0-parit-*`, `p0-safety-gate-observability-*`.',
  '### P0 — `p0-safety-observability`',
  '### P1 — `p1-session-ux-extensibility`',
].join('\n');

function phase(id: string): { kind: string; id: string; name: string } {
  return { kind: 'phase', id, name: id };
}

function task(id: string, name: string, phaseId: string): Record<string, unknown> {
  return { kind: 'task', id, name, phaseId, status: 'pending', priority: 'high' };
}

describe('runPlanDriftCheck', () => {
  it('is green when plan.json matches the canonical doc', async () => {
    const z = seedPlan(
      [phase('p0-safety-observability'), phase('p1-session-ux-extensibility')],
      [
        task('p0-safety-observability-lifecyclehookrunner-1', 'LifecycleHookRunner', 'p0-safety-observability'),
        task('p1-session-ux-extensibility-fork-rewind-2', 'Fork e rewind', 'p1-session-ux-extensibility'),
      ],
      [{ kind: 'milestone', id: 'm-1', name: 'v0.10.0', targetVersion: 'v0.10.0' }],
    );
    seedCanonical(CANONICAL);

    const result = await runPlanDriftCheck(z);

    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.canonicalDoc).toBe('plan-canonical-v9-9-9.md');
    expect(result.reportPath).toBe(join(z, 'drift-report.json'));
    const report = JSON.parse(readFileSync(result.reportPath!, 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ phases: 2, tasks: 2, milestones: 1 });
  });

  it('flags duplicate milestones targeting the same version', async () => {
    const z = seedPlan(
      [phase('p0-safety-observability')],
      [task('t-1', 'Solo task', 'p0-safety-observability')],
      [
        { kind: 'milestone', id: 'm-1', name: 'v0.10.0 A', targetVersion: 'v0.10.0' },
        { kind: 'milestone', id: 'm-2', name: 'v0.10.0 B', targetVersion: '0.10.0' },
      ],
    );
    seedCanonical(CANONICAL);

    const result = await runPlanDriftCheck(z);

    expect(result.ok).toBe(false);
    const dup = result.findings!.filter((f) => f.code === 'DUPLICATE_MILESTONE');
    expect(dup).toHaveLength(1);
    expect(dup[0].severity).toBe('error');
    expect(dup[0].message).toContain('m-1');
    expect(dup[0].message).toContain('m-2');
  });

  it('flags phases and tasks matching a canonical duplicate/descope prefix', async () => {
    const z = seedPlan(
      [phase('p0-safety-observability'), phase('p0-parit-sicurezza')],
      [
        task('p0-parit-sicurezza-hook-1', 'Hook runner', 'p0-parit-sicurezza'),
        task('p0-safety-gate-observability-hook-2', 'Altro hook', 'p0-safety-observability'),
      ],
      [],
    );
    seedCanonical(CANONICAL);

    const result = await runPlanDriftCheck(z);

    expect(result.ok).toBe(false);
    const codes = result.findings!.map((f) => f.code);
    expect(codes).toContain('PHASE_IN_CANONICAL_BLOCKLIST');
    expect(codes).toContain('TASK_IN_CANONICAL_BLOCKLIST');
  });

  it('flags canonical phases missing from plan.json', async () => {
    const z = seedPlan(
      [phase('p0-safety-observability')],
      [task('t-1', 'Task', 'p0-safety-observability')],
      [],
    );
    seedCanonical(CANONICAL);

    const result = await runPlanDriftCheck(z);

    expect(result.ok).toBe(false);
    const missing = result.findings!.filter((f) => f.code === 'CANONICAL_PHASE_MISSING');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('p1-session-ux-extensibility');
  });

  it('warns (non-blocking) on duplicate titles and unknown phaseId', async () => {
    const z = seedPlan(
      [phase('p0-safety-observability'), phase('p1-session-ux-extensibility')],
      [
        task('a-1', 'Lifecycle hook runner', 'p0-safety-observability'),
        task('b-2', 'Lifecycle  Hook Runner!', 'p1-session-ux-extensibility'),
        task('c-3', 'Task orfano', 'fase-inesistente'),
      ],
      [],
    );
    seedCanonical(CANONICAL);

    const result = await runPlanDriftCheck(z);

    expect(result.ok).toBe(true); // warnings only
    const codes = result.findings!.map((f) => f.code).sort();
    expect(codes).toEqual(['DUPLICATE_TASK_TITLE', 'TASK_IN_UNKNOWN_PHASE']);
  });

  it('runs structural checks only when no canonical doc exists', async () => {
    const z = seedPlan(
      [phase('p0-safety-observability')],
      [task('t-1', 'Task', 'p0-safety-observability')],
      [{ kind: 'milestone', id: 'm-1', name: 'v1', targetVersion: 'v1.0.0' }],
    );

    const result = await runPlanDriftCheck(z);

    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.canonicalDoc).toBeUndefined();
    expect(result.reason).toContain('no canonical doc');
  });

  it('is skipped when plan.json is missing', async () => {
    const z = zelari();
    const result = await runPlanDriftCheck(z);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain('missing');
  });

  it('is skipped when plan.json is corrupt', async () => {
    const z = zelari();
    writeFileSync(join(z, 'plan.json'), '{not json', 'utf8');
    const result = await runPlanDriftCheck(z);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain('corrupt');
  });

  it('is disabled via ZELARI_DRIFT_CHECK=0', async () => {
    seedPlan([phase('p0')], [], []);
    process.env['ZELARI_DRIFT_CHECK'] = '0';
    const result = await runPlanDriftCheck(join(dir, '.zelari'));
    expect(result.ran).toBe(false);
    expect(result.reason).toContain('disabled');
    expect(existsSync(join(dir, '.zelari', 'drift-report.json'))).toBe(false);
  });
});
