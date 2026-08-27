/**
 * nativeVerification — F2 / Exit-2.4: the Zelari Coding Criteria Pack v1
 * runs NATIVELY in the Kraken strict-build path.
 *
 * Migration context (ADR-0023): the strict gate previously evaluated only
 * the Kraken selection criteria via the verify-report bridge (LLM notes as
 * pseudo-evidence). This module adds the pack's real deterministic checks —
 * `npm run typecheck` / `test` / `build` actually execute through the core
 * VerificationEngine and their exit codes + output digests become evidence.
 *
 * Composition rule (unchanged): blockers add up. Pack criteria join the SAME
 * CompletionPolicy evaluation as the selection criteria — a failing
 * typecheck is REPAIR_REQUIRED no matter what the verify tentacle reported,
 * and an unrunnable command is honestly `unknown`, never `pass`.
 *
 * Repo-adaptive defaults: a pack criterion whose npm script does not exist
 * in package.json is DROPPED (a required-but-unrunnable criterion would be a
 * permanently-unknown blocker on repos without that script). Optional
 * advisory criteria are kept — they surface as `unknown` without gating.
 *
 * Multi-ecosystem (P1.A / t19): command resolution delegates to the adapter
 * registry (./verificationAdapters) — package.json/npm is now the node
 * adapter, and Cargo.toml / go.mod / pyproject.toml repos get native plans
 * too (highest detect score wins; unrecognized roots contribute nothing).
 * The same repo-adaptive honesty holds everywhere: an unbindable slot → null.
 *
 * Env surface (all optional, flags documented in GUIDA):
 *   ZELARI_VERIFY_PACK=0|off|false   disable the native pack (ON by default
 *                                     since P0.2; repo-adaptive binding keeps
 *                                     repos without npm scripts unaffected)
 *   ZELARI_VERIFY_TYPECHECK_CMD      override typecheck command ('' disables)
 *   ZELARI_VERIFY_TEST_CMD           override test command ('' disables)
 *   ZELARI_VERIFY_BUILD_CMD          override build command ('' disables)
 *   ZELARI_VERIFY_TIMEOUT_MS         per-command timeout (default 600000)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalWorkspace, NodeShellProvider, type ShellProvider } from '@zelari/core/runtime';
import type { SessionEventInput } from '@zelari/core/session';
import {
  VerificationEngine,
  ZELARI_CODING_PACK_ID,
  codingCriteriaPack,
  type Criterion,
  type VerificationResult,
} from '@zelari/core/verification';
import { resolveAdapterForRoot } from './verificationAdapters/index.js';

type Env = Record<string, string | undefined>;

export interface NativePackCommands {
  typecheckCommand: string | null;
  testCommand: string | null;
  buildCommand: string | null;
}

/**
 * ON by default since harness-hardening P0.2 — the native criteria pack joins
 * every strict evaluation unless explicitly disabled. Explicit opt-out:
 * `ZELARI_VERIFY_PACK=0|off|false`.
 */
export function nativePackEnabled(env: Env = process.env): boolean {
  const v = env.ZELARI_VERIFY_PACK?.toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return false;
  return true;
}

/** Empty baseline plan: an adapter-less root still honors env overrides. */
const EMPTY_PLAN: NativePackCommands = {
  typecheckCommand: null,
  testCommand: null,
  buildCommand: null,
};

/**
 * Env override surface, applied ON TOP of whatever an adapter produced
 * (semantics preserved exactly from F2): an override replaces the bound
 * command — even a null one (so pure-override setups work on any repo) —
 * and the empty string explicitly disables that slot. Unset → keep the
 * adapter's binding.
 */
export function applyEnvOverridesToPlan(env: Env, plan: NativePackCommands): NativePackCommands {
  const pick = (override: string | undefined, bound: string | null): string | null => {
    if (override !== undefined) {
      const trimmed = override.trim();
      return trimmed === '' ? null : trimmed;
    }
    return bound;
  };
  return {
    typecheckCommand: pick(env.ZELARI_VERIFY_TYPECHECK_CMD, plan.typecheckCommand),
    testCommand: pick(env.ZELARI_VERIFY_TEST_CMD, plan.testCommand),
    buildCommand: pick(env.ZELARI_VERIFY_BUILD_CMD, plan.buildCommand),
  };
}

/**
 * Legacy F2 resolver kept for compatibility: env overrides over implicit
 * node-script bindings (`npm run <script>` when package.json declares it).
 * The ecosystem-aware path is resolvePackCommandsForRoot below.
 */
export function resolvePackCommands(
  env: Env,
  scripts: Record<string, unknown>,
): NativePackCommands {
  const npmScript = (scriptName: string): string | null => {
    const script = scripts[scriptName];
    return typeof script === 'string' && script.length > 0 ? `npm run ${scriptName}` : null;
  };
  return applyEnvOverridesToPlan(env, {
    typecheckCommand: npmScript('typecheck'),
    testCommand: npmScript('test'),
    buildCommand: npmScript('build'),
  });
}

/**
 * P1.A (t19): ecosystem-aware resolver — pick the highest-scoring adapter
 * for `cwd` (resolveAdapterForRoot), take its build plan, then layer env
 * overrides on top. An unrecognized root degrades to the empty plan, so a
 * pure-override setup keeps working exactly as it did before adapters.
 */
export async function resolvePackCommandsForRoot(
  env: Env,
  cwd: string,
): Promise<NativePackCommands> {
  const adapter = await resolveAdapterForRoot(cwd);
  const plan = adapter ? await adapter.buildPlan(cwd) : EMPTY_PLAN;
  return applyEnvOverridesToPlan(env, plan);
}

/** Per-command timeout (default mirrors the core pack: 10 minutes). */
export function packTimeoutMs(env: Env = process.env): number {
  const raw = Number(env.ZELARI_VERIFY_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 600_000;
  return Math.min(Math.floor(raw), 3_600_000);
}

/** Package.json `scripts` of `cwd`; `{}` on any read/parse failure. */
export async function readPackageScripts(cwd: string = process.cwd()): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(cwd, 'package.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { scripts?: unknown }).scripts === 'object') {
      return (parsed as { scripts: Record<string, unknown> }).scripts;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Pack criteria adapted to this repo: required criteria without a bound
 * deterministic check are dropped (unknown ≠ pass would block forever);
 * optional advisories are kept and surface honestly as `unknown`.
 */
export function buildNativeCriteria(commands: NativePackCommands, timeoutMs: number): Criterion[] {
  const pack = codingCriteriaPack({ ...commands, commandTimeoutMs: timeoutMs });
  return pack.criteria.filter(
    (c) => !(c.required && (!c.check || c.check.kind === 'none')),
  );
}

export interface NativePackEvaluation {
  packId: string;
  criteria: Criterion[];
  results: VerificationResult[];
}

export interface NativePackDeps {
  /** Workspace root used for package.json detection and command cwd. */
  cwd?: string;
  /** Env source (tests inject a snapshot); defaults to process.env. */
  env?: Env;
  /** Shell seam (tests inject a stub); defaults to the core NodeShellProvider. */
  shell?: ShellProvider;
  /**
   * F3 (ADR-0023 §5): session spine emitter — every engine observation is
   * appended as a `verification.evidence` event and the assigned seq
   * anchors the EvidenceRef. Absent → unanchored evidence (legacy).
   */
  emit?: (input: SessionEventInput) => Promise<unknown>;
}

/**
 * Evaluate the native criteria pack. Returns null when the pack is disabled
 * or the repo binds no deterministic command at all (nothing to add — the
 * legacy bridge contract remains the only strict evidence).
 */
export async function evaluateNativePack(deps: NativePackDeps = {}): Promise<NativePackEvaluation | null> {
  const env = deps.env ?? process.env;
  if (!nativePackEnabled(env)) return null;
  const cwd = deps.cwd ?? process.cwd();
  // P1.A: ecosystem-aware resolution — adapter build plan + env overrides.
  const commands = await resolvePackCommandsForRoot(env, cwd);
  // No bound command at all → nothing deterministic to add; advisories alone
  // would only pollute the contract with permanently-unknown results.
  if (!commands.typecheckCommand && !commands.testCommand && !commands.buildCommand) return null;
  const criteria = buildNativeCriteria(commands, packTimeoutMs(env));
  if (criteria.length === 0) return null;
  const shell = deps.shell ?? new NodeShellProvider(new LocalWorkspace(cwd));
  const engine = deps.emit
    ? new VerificationEngine({ shell }, { emit: deps.emit })
    : new VerificationEngine({ shell });
  const results = await engine.evaluate(criteria, { packId: ZELARI_CODING_PACK_ID });
  return { packId: ZELARI_CODING_PACK_ID, criteria, results };
}
