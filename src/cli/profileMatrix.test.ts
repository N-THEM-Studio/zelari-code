/**
 * profileMatrix — F7 (Exit-3.2, doc §10) profile × phase smoke matrix.
 *
 * Cells (§10 minimum): minimal+plan/build, kraken+plan/build, council+plan,
 * mission+build. For each cell the smoke walks the three real wiring legs:
 *
 *   1. profile loader   — mode/--profile resolves to the expected versioned
 *      profile (ADR-0022); explicit ids win over mode defaults
 *   2. session metadata — the spine `session.started` header records profile +
 *      toolManifestHash of the declared profile, so same-task/same-profile
 *      runs stay comparable
 *   3. capability gate  — the REAL registry built for that phase: plan strips
 *      every PLAN_BLOCKED_TOOLS mutator while keeping the plan-domain tools
 *      (task_create/update/list + explore-only `task`); build registers the
 *      full mutator set; declared profile tools are a subset of the build
 *      registry (declarative 2.0 manifest ⊆ real 1.x registry)
 *
 * Wiring invariants that live inside runHeadless (mission slices never run in
 * plan; kraken/council registries derive planMode from the phase) are locked
 * as source assertions — same pattern as legacyContextIsolation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readSessionLog } from '@zelari/core/session';
import { MINIMAL_V1, KRAKEN_V1, MISSION_V1, toolManifestHash } from '@zelari/core/runtime';
import { openHeadlessSpine, resolveHeadlessProfileId } from './headlessSpine.js';
import { createBuiltinToolRegistry } from './toolRegistry.js';
import { PLAN_BLOCKED_TOOLS } from './phase.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readCli(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, 'src', 'cli', rel), 'utf8');
}

type Cell = {
  mode: 'kraken' | 'council' | 'zelari';
  /** Profile id the cell must resolve to. */
  profile: string;
  /** Explicit --profile flag for the loader leg (undefined = mode default). */
  explicitProfile?: string;
  phase: 'plan' | 'build';
  /** Declared capability set recorded in the session header. */
  declaredTools: readonly string[];
};

const MATRIX: readonly Cell[] = [
  { mode: 'kraken', profile: 'minimal/v1', explicitProfile: 'minimal/v1', phase: 'plan', declaredTools: MINIMAL_V1.tools },
  { mode: 'kraken', profile: 'minimal/v1', explicitProfile: 'minimal/v1', phase: 'build', declaredTools: MINIMAL_V1.tools },
  { mode: 'kraken', profile: 'kraken/v1', phase: 'plan', declaredTools: KRAKEN_V1.tools },
  { mode: 'kraken', profile: 'kraken/v1', phase: 'build', declaredTools: KRAKEN_V1.tools },
  { mode: 'council', profile: 'council/v1', phase: 'plan', declaredTools: [...MINIMAL_V1.tools, 'write_file'] },
  // §10 + mission contract: mission runs BUILD only (slices implement on disk).
  { mode: 'zelari', profile: 'mission/v1', phase: 'build', declaredTools: MISSION_V1.tools },
];

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-profile-matrix-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('F7 profile × phase smoke matrix (Exit-3.2)', () => {
  it.each(MATRIX)(
    'cell $mode/$phase → $profile: loader, session metadata and phase capability gate',
    async (cell) => {
      // Leg 1 — profile loader: explicit id wins, otherwise the mode default.
      expect(resolveHeadlessProfileId(cell.mode, cell.explicitProfile)).toBe(cell.profile);

      // Leg 2 — session metadata on the spine header.
      const sessionId = `mx-${cell.mode}-${cell.phase}`;
      const handle = await openHeadlessSpine({ sessionId, mode: cell.mode, profile: cell.explicitProfile, baseDir: tmp, quiet: true });
      expect(handle.profileId).toBe(cell.profile);
      const report = await readSessionLog(path.join(tmp, sessionId, 'events.jsonl'));
      expect(report.ok).toBe(true);
      const started = report.events.find((e) => e.kind === 'session.started');
      expect(started).toBeDefined();
      const startedData = (started?.data ?? {}) as Record<string, unknown>;
      expect(startedData.profile).toBe(cell.profile);
      // The manifest hash is the DECLARED profile tool set (ADR-0022) — the
      // comparability contract, distinct from the phase-gated live registry.
      expect(startedData.toolManifestHash).toBe(toolManifestHash(cell.declaredTools));

      // Leg 3 — real registry for the phase (no tool is invoked: zero side effects).
      const { registry } = createBuiltinToolRegistry({
        root: tmp,
        sessionId,
        planMode: cell.phase === 'plan',
        lifecycleHooks: null,
        lspProvider: null,
      });
      const names = new Set(registry.list());

      // Observe builtins exist in BOTH phases.
      for (const observe of ['read_file', 'grep_content', 'list_files']) {
        expect(names.has(observe), `${observe} must exist in ${cell.phase}`).toBe(true);
      }

      if (cell.phase === 'plan') {
        // No mutating builtin survives plan (no unauthorized side effects).
        for (const blocked of PLAN_BLOCKED_TOOLS) {
          expect(names.has(blocked), `${blocked} must be stripped in plan`).toBe(false);
        }
        // Plan-domain tools stay: durable plan tasks + explore-only delegation.
        for (const planTool of ['task_create', 'task_update', 'task_list', 'task']) {
          expect(names.has(planTool), `${planTool} must exist in plan`).toBe(true);
        }
      } else {
        // Build: the full mutator set is available.
        for (const mutator of ['write_file', 'edit_file', 'apply_diff', 'bash', 'task']) {
          expect(names.has(mutator), `${mutator} must exist in build`).toBe(true);
        }
        // Declared 2.0 profile tools are a subset of the real build registry.
        for (const declared of cell.declaredTools) {
          expect(names.has(declared), `declared tool ${declared} missing from build registry`).toBe(true);
        }
      }
    },
    30_000,
  );

});

describe('F7 wiring invariants (source-level, legacyContextIsolation pattern)', () => {
  it('kraken and council registries derive planMode from the resolved phase', () => {
    const src = readCli('runHeadless.ts') + '\n' + readCli('headless/runOneTurn.ts');
    // Kraken parent registry (headless hot path).
    expect(src).toContain('planMode: planModeFromOpts(opts),');
    // Council pipelines: explicit phase (design leg) and soft-gated variant.
    expect(src).toContain('planModeFromOpts(opts) || softGated,');
    expect(src).toContain('planModeFromOpts(opts),');
    // planModeFromOpts is the single phase→planMode derivation.
    expect(src).toContain("return (opts.phase ?? 'build') === 'plan';");
  });

  it('mission implementation slices are hard-wired to BUILD (never planMode)', () => {
    const src = readCli('runHeadless.ts');
    const lines = src.split(/\r?\n/);
    const idx = lines.findIndex((l) => l.includes('const { registry: agentRegistry } = createBuiltinToolRegistry({'));
    expect(idx).toBeGreaterThan(-1);
    const window = lines.slice(idx, idx + 12).join('\n');
    expect(window).toContain('planMode: false');
    expect(window).not.toContain('planMode: true');
  });

  it('PLAN_BLOCKED_TOOLS stays exactly the mutating builtins', () => {
    // If a new mutator lands without a plan gate, this reminds the author.
    expect([...PLAN_BLOCKED_TOOLS].sort()).toEqual(['apply_diff', 'bash', 'edit_file', 'write_file']);
  });
});
