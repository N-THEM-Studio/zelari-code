/**
 * completionProofProbe — t20 (§P1.B): environment-derived attestation
 * inputs for the completion proof. Everything here is BEST-EFFORT and
 * read-only: a missing git binary, a non-repo cwd, a disabled criteria
 * pack or an unreadable package.json simply omits the corresponding
 * attestation field (they are optional by design). Kept apart from the
 * sealing core so that core stays pure and instantly testable.
 *
 * Owns:
 * - harnessManifest: deterministic harness identity (version, pack,
 *   adapters, policy precedence/load mode) — PW §7;
 * - gatherGitAttestation: HEAD sha + staged/unstaged `git diff` text;
 * - defaultVerificationPlanSnapshot: the t19 adapter-resolved plan
 *   ({packId, commands}) canonically shaped for verificationPlanDigest.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// t22: the active contract-scope seam feeds the live taskContractDigest.
import { activeContractScope } from './contractCompiler.js';
import type { HarnessManifest } from './completionProofAttestation.js';

const HARNESS_VERSION_FALLBACK = '2.13.0';
/**
 * Mirrors verificationAdapters/index.ts REGISTRY ORDER IS CONTRACT. Kept a
 * literal (adapters carry no id field); completionProofProbe.test.ts locks
 * it to the live registry length so a registry extension without a mirror
 * sync fails the suite instead of silently mis-attesting.
 */
const ADAPTER_IDS = ['node', 'python', 'rust', 'go', 'java', 'dotnet'] as const;
let cachedHarnessVersion: string | null = null;

async function readHarnessVersion(): Promise<string> {
  if (cachedHarnessVersion !== null) return cachedHarnessVersion;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const parsed = JSON.parse(await readFile(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return (cachedHarnessVersion = parsed.version);
    }
  } catch {
    /* fall through to the pinned constant */
  }
  return (cachedHarnessVersion = HARNESS_VERSION_FALLBACK);
}

/**
 * The deterministic identity of the harness that produced a proof: which
 * binary, which criteria pack, which adapters COULD have bound, and how
 * policies were layered/loaded. Constant per configuration — cheap, and
 * enough to detect cross-environment drift.
 */
export async function harnessManifest(env: NodeJS.ProcessEnv = process.env): Promise<HarnessManifest> {
  const [{ policyPrecedenceFromEnv }, { activePolicyLoadMode }, { ZELARI_CODING_PACK_ID }] = await Promise.all([
    import('../safety/policyEngine.js'),
    import('../safety/policyLoadMode.js'),
    import('@zelari/core/verification'),
  ]);
  return {
    harnessVersion: await readHarnessVersion(),
    packId: ZELARI_CODING_PACK_ID,
    adapters: ADAPTER_IDS,
    policyPrecedence: policyPrecedenceFromEnv(),
    policyLoadMode: activePolicyLoadMode(env),
  };
}

const execFileAsync = promisify(execFile);

/** Best-effort `git -C <cwd> <args>` → stdout | null (never throws). */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

export interface GitAttestationInputs {
  commitSha?: string;
  /** Raw `git diff` (+ `--cached`) text; hashed into diffDigest. */
  diffText?: string;
}

/**
 * Resolve commit + working-tree-diff inputs (staged + unstaged vs HEAD).
 * Any failure omits both fields; never throws.
 */
export async function gatherGitAttestation(cwd: string = process.cwd()): Promise<GitAttestationInputs> {
  const [head, stagedDiff, unstagedDiff] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['diff', '--cached']),
    git(cwd, ['diff']),
  ]);
  const inputs: GitAttestationInputs = {};
  const sha = head?.trim();
  if (sha) inputs.commitSha = sha;
  if (stagedDiff !== null && unstagedDiff !== null) {
    inputs.diffText = [stagedDiff, unstagedDiff].filter((s) => s.length > 0).join('\n');
  }
  return inputs;
}

/**
 * Snapshot of the resolved native verification plan for THIS repo (t19
 * adapters + env overrides), shaped canonically for verificationPlanDigest.
 * undefined when the pack is disabled / nothing binds / resolution fails.
 * Never throws.
 */
export async function defaultVerificationPlanSnapshot(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  try {
    const { nativePackEnabled, resolvePackCommandsForRoot } = await import('./nativeVerification.js');
    const { ZELARI_CODING_PACK_ID } = await import('@zelari/core/verification');
    if (!nativePackEnabled(env)) return undefined;
    const commands = await resolvePackCommandsForRoot(env, cwd);
    if (!commands.typecheckCommand && !commands.testCommand && !commands.buildCommand) return undefined;
    return { packId: ZELARI_CODING_PACK_ID, commands };
  } catch {
    return undefined;
  }
}

/**
 * t22 (PW §8): the LIVE TaskContract of the active turn, read from the
 * contract-scope seam (kraken/contractCompiler.setActiveContractScope).
 * Hosts re-register after every accepted steer, so a proof written after a
 * steer hashes version N+1 — `taskContractDigest` always tracks the CURRENT
 * contract. undefined when no scoped contract is registered; never throws.
 */
export function activeTaskContractSnapshot(): unknown {
  try {
    return activeContractScope()?.contract;
  } catch {
    return undefined;
  }
}
