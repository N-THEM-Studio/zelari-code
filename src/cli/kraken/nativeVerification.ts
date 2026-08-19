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
 * Env surface (all optional, alpha flags documented in GUIDA):
 *   ZELARI_VERIFY_PACK=1|on|true     enable the native pack (alpha: opt-in,
 *                                     default off — mirrors ZELARI_STRICT_DONE)
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

type Env = Record<string, string | undefined>;

export interface NativePackCommands {
  typecheckCommand: string | null;
  testCommand: string | null;
  buildCommand: string | null;
}

/** Opt-in during the alpha: the native pack runs only when explicitly enabled. */
export function nativePackEnabled(env: Env = process.env): boolean {
  const v = env.ZELARI_VERIFY_PACK?.toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

/**
 * Resolve pack commands: env override wins (empty string = explicit
 * disable), otherwise bind `npm run <script>` only when the repo declares
 * the script. Unbound → null → the criterion is dropped downstream.
 */
export function resolvePackCommands(
  env: Env,
  scripts: Record<string, unknown>,
): NativePackCommands {
  const pick = (override: string | undefined, scriptName: string): string | null => {
    if (override !== undefined) {
      const trimmed = override.trim();
      return trimmed === '' ? null : trimmed;
    }
    const script = scripts[scriptName];
    return typeof script === 'string' && script.length > 0 ? `npm run ${scriptName}` : null;
  };
  return {
    typecheckCommand: pick(env.ZELARI_VERIFY_TYPECHECK_CMD, 'typecheck'),
    testCommand: pick(env.ZELARI_VERIFY_TEST_CMD, 'test'),
    buildCommand: pick(env.ZELARI_VERIFY_BUILD_CMD, 'build'),
  };
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
  const commands = resolvePackCommands(env, await readPackageScripts(cwd));
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
