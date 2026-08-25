/**
 * tools/eval/arms/runner.ts — experiment runner (upgrade doc §82–§86).
 *
 * Spawns the headless CLI once per case × arm with the arm's env diff,
 * captures NDJSON stdout, extracts metrics, checks the case expectation and
 * assembles a reproducible manifest (git commit, CLI version, env diff,
 * fixture hash, timestamp — §86).
 *
 * runExperiment() needs a real provider → integration only. The pure pieces
 * (composeArmEnv, hashFixture, buildManifest) are unit-tested.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  ArmRunRecord,
  EvalArm,
  EvalCase,
  ExperimentManifest,
} from './types.ts';
import { metricsFromNdjson } from './metrics.ts';

/**
 * Apply an arm's env diff over the base env (§83): value '' REMOVES the key
 * so arms can clear inherited routing (e.g. ZELARI_KRAKEN_EXPLORE_MODEL).
 */
export function composeArmEnv(
  base: Record<string, string>,
  arm: EvalArm,
): Record<string, string> {
  const env: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(arm.env)) {
    if (value === '') delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Deterministic content hash of a fixture directory (sorted rel paths). */
export function hashFixture(cwdFixture: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      } catch {
        // unreadable entry — skip, hash stays deterministic on readable set
      }
    }
  };
  walk(cwdFixture);

  const hasher = createHash('sha256');
  if (files.length === 0) {
    hasher.update(`empty:${cwdFixture}`);
    return hasher.digest('hex').slice(0, 16);
  }
  for (const full of files) {
    const rel = relative(cwdFixture, full).split(sep).join('/');
    let content = '';
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      content = '<unreadable>';
    }
    hasher.update(rel);
    hasher.update('\0');
    hasher.update(content);
    hasher.update('\0');
  }
  return hasher.digest('hex').slice(0, 16);
}

/** Pure manifest assembly — reproducibility fields are inputs, not probed. */
export function buildManifest(input: {
  experimentId: string;
  createdAt: string;
  gitCommit: string;
  cliVersion: string;
  provider?: string;
  model?: string;
  arms: EvalArm[];
  cases: EvalCase[];
  runs: ArmRunRecord[];
}): ExperimentManifest {
  return {
    version: 1,
    experimentId: input.experimentId,
    createdAt: input.createdAt,
    gitCommit: input.gitCommit,
    cliVersion: input.cliVersion,
    provider: input.provider,
    model: input.model,
    arms: input.arms.map((a) => ({ id: a.id, envDiff: { ...a.env } })),
    cases: input.cases.map((c) => ({ id: c.id, fixtureHash: hashFixture(c.cwdFixture) })),
    runs: input.runs,
  };
}

function checkExpectation(caseDef: EvalCase): boolean {
  const exp = caseDef.expected;
  if (!exp) return true;
  if (exp.files) {
    for (const f of exp.files) {
      try {
        statSync(join(caseDef.cwdFixture, f));
      } catch {
        return false;
      }
    }
  }
  if (exp.command) {
    const res = spawnSync(exp.command.cmd, {
      shell: true,
      cwd: caseDef.cwdFixture,
      encoding: 'utf8',
    });
    if ((res.status ?? -1) !== (exp.command.expectExit ?? 0)) return false;
  }
  return true;
}

/**
 * Run the full case × arm matrix. INTEGRATION ONLY (real CLI + provider).
 * Failures never throw: they are recorded as error/passed=false so the
 * manifest always lands (partial captures stay comparable).
 */
export function runExperiment(input: {
  experimentId: string;
  cases: EvalCase[];
  arms: EvalArm[];
  baseEnv?: Record<string, string>;
  cliEntry?: string;
  provider?: string;
  model?: string;
  now?: () => string;
}): ExperimentManifest {
  const {
    experimentId,
    cases,
    arms,
    baseEnv = {},
    cliEntry = 'bin/zelari-code.js',
  } = input;

  const runs: ArmRunRecord[] = [];
  for (const caseDef of cases) {
    for (const arm of arms) {
      const res = spawnSync(process.execPath, [cliEntry, '--headless', '--task', caseDef.prompt, '--output', 'json'], {
        cwd: caseDef.cwdFixture,
        env: composeArmEnv(baseEnv, arm),
        encoding: 'utf8',
        timeout: caseDef.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      const stdout = typeof res.stdout === 'string' ? res.stdout : '';
      const lines = stdout.split(/\r?\n/);
      const error =
        res.error?.message ??
        (res.status !== 0 && stdout.trim().length === 0
          ? `cli exited ${String(res.status)}`
          : undefined);
      const passed = error === undefined && checkExpectation(caseDef);
      runs.push({
        armId: arm.id,
        caseId: caseDef.id,
        metrics: metricsFromNdjson(lines, passed),
        ndjsonLines: lines.filter((l) => l.trim().length > 0).length,
        error,
      });
    }
  }

  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const version = spawnSync(process.execPath, [cliEntry, '--version'], { encoding: 'utf8' });

  return buildManifest({
    experimentId,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
    gitCommit: (git.stdout ?? '').trim() || 'unknown',
    cliVersion: (version.stdout ?? '').trim() || 'unknown',
    provider: input.provider,
    model: input.model,
    arms,
    cases,
    runs,
  });
}
