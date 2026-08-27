/**
 * completionProofPersist — t20 (§P1.B): the durability contract behind the
 * completion proof artifact.
 *
 * Three responsibilities, kept out of completionProof.ts to hold every file
 * under the 300-LOC discipline:
 *
 * 1. ATOMIC WRITES — tmp → fsync(file) → rename over the final name, with a
 *    win32 fallback (EPERM/ENOTEMPTY under AV/indexer locks → rm + rename)
 *    and a guarantee that no `.tmp` litter survives success OR failure.
 * 2. PERSISTENCE MODE — `ZELARI_PROOF_PERSISTENCE` env override over
 *    surface defaults (headless/mission/CI ⇒ `required`, interactive TUI ⇒
 *    `best-effort`), mirroring safety/policyLoadMode's pure-resolver +
 *    registered-active-surface pattern.
 * 3. REQUIRED ENFORCEMENT — the pure gate flip: PASS + un-writable proof ⇒
 *    BLOCKED (completionGate exit-4 family), with the failure reason
 *    appended to the summary so NDJSON/headless surfaces see WHY.
 */
import { open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  canonicalJson,
  computeProofDigest,
  isSha256Hex,
  PROOF_KIND,
  PROOF_VERSION,
  sha256Hex,
  type ProofAttestation,
} from './completionProofAttestation.js';
import type { CompletionProofPaths } from './completionProof.js';

// ── Persistence mode ─────────────────────────────────────────────────────

/** How a failed proof write is treated by the owning host. */
export type ProofPersistenceMode = 'best-effort' | 'required';

/** Host that persists proofs (drives the default). */
export type ProofPersistenceSurface = 'headless' | 'mission' | 'tui';

/** Env override accepted by resolveProofPersistenceMode. */
export const PROOF_PERSISTENCE_ENV = 'ZELARI_PROOF_PERSISTENCE';

export interface ResolveProofPersistenceInput {
  /** Which host is about to persist (drives the default). */
  surface: ProofPersistenceSurface;
  /** Raw ZELARI_PROOF_PERSISTENCE value (undefined/unset = no override). */
  override?: string | undefined;
  /** Raw CI env value (undefined = unset). Truthy flags demand proofs too. */
  ci?: string | undefined;
}

function isTruthyFlag(v: string | undefined): boolean {
  const n = v?.trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes' || n === 'on';
}

const warnedInvalidOverrides = new Set<string>();

/**
 * Emit ONE warning per distinct invalid override value (hosts surface it;
 * repeat evaluations stay quiet).
 */
function warnInvalidOverride(raw: string, fallback: ProofPersistenceMode): void {
  if (warnedInvalidOverrides.has(raw)) return;
  warnedInvalidOverrides.add(raw);
  try {
    process.stderr.write(
      `[zelari] ignoring invalid ${PROOF_PERSISTENCE_ENV}=${JSON.stringify(raw)} ` +
        `(expected "best-effort" or "required") — defaulting to ${fallback}\n`,
    );
  } catch {
    /* stderr unavailable — resolution continues */
  }
}

/**
 * Pure mode resolution — precedence mirrors safety/policyLoadMode:
 *   1. ZELARI_PROOF_PERSISTENCE=best-effort|required (any other value is
 *      IGNORED with a warning and falls through — no typo flips durability);
 *   2. headless and mission surfaces default to `required`: an unattended
 *      run without its durable witness is not verifiable-complete;
 *   3. the interactive TUI defaults to `best-effort` (a read-only checkout
 *      must not brick chat), tightening to `required` under ambient CI
 *      because CI consumes proofs as a pass condition (PW §7).
 */
export function resolveProofPersistenceMode(
  env: Record<string, string | undefined>,
  ctx: ResolveProofPersistenceInput,
): ProofPersistenceMode {
  const fallback: ProofPersistenceMode =
    ctx.surface === 'headless' || ctx.surface === 'mission' || isTruthyFlag(ctx.ci) ? 'required' : 'best-effort';
  const raw = env[PROOF_PERSISTENCE_ENV];
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === 'best-effort') return 'best-effort';
    if (v === 'required') return 'required';
    warnInvalidOverride(raw.trim(), fallback);
  }
  return fallback;
}

// ── Active-surface seam (registered once by the host, like policyLoadMode)

let activeSurface: ProofPersistenceSurface = 'tui';

/** Register the host BEFORE any proof write (runHeadless pre-flight). */
export function setActiveProofPersistenceSurface(surface: ProofPersistenceSurface): void {
  activeSurface = surface;
}

/** Current registration (read-mostly; exposed for tests/diagnostics). */
export function activeProofPersistenceSurface(): ProofPersistenceSurface {
  return activeSurface;
}

/**
 * Resolve the ACTIVE persistence mode from the registered surface + env.
 * `env` is injectable so callers/tests avoid touching process.env.
 */
export function activeProofPersistenceMode(env: Record<string, string | undefined> = process.env): ProofPersistenceMode {
  return resolveProofPersistenceMode(env, {
    surface: activeSurface,
    ...(typeof env.CI === 'string' ? { ci: env.CI } : {}),
  });
}

// ── Atomic file write (tmp → fsync → rename) ─────────────────────────────

/** win32 rename-over-existing can hit transient AV/indexer locks. */
function isWindowsRenameBlock(err: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EEXIST';
}

/**
 * Transaction-grade replacement for writeFile: data lands in
 * `<target>.<random>.tmp`, gets fsync'd (`fh.sync()`), closes, and is
 * renamed over the final name — readers never observe a half-written
 * artifact. win32 fallback: EPERM/ENOTEMPTY → rm the previous file, rename
 * again. On ANY failure the tmp file is removed; no `.tmp` litter survives
 * success OR failure.
 */
export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let fh: FileHandle | null = null;
  try {
    fh = await open(tmp, 'w');
    await fh.writeFile(data, 'utf8');
    await fh.sync(); // flush contents BEFORE the rename publishes them
    await fh.close();
    fh = null;
    try {
      await rename(tmp, target);
    } catch (err) {
      if (!isWindowsRenameBlock(err)) throw err;
      await rm(target, { force: true }); // drop the stale artifact, retry
      await rename(tmp, target);
    }
  } finally {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        /* already closed */
      }
    }
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

// ── Required-mode enforcement ────────────────────────────────────────────

export interface ProofPersistenceOutcome {
  /** Written artifact paths; null when nothing was persisted. */
  paths: CompletionProofPaths | null;
  /** Effective persistence mode for this call (resolved + override applied). */
  mode: ProofPersistenceMode;
  /**
   * Non-null iff mode === 'required' AND the write failed — the exact
   * reason a PASS must be downgraded to BLOCKED (feeds the gate flip).
   */
  requiredBlockReason: string | null;
}

/**
 * t20 required-persistence contract, kept PURE so hosts wire it themselves:
 * PASS + unwritable proof ⇒ blocked=true, with the failure reason appended
 * to the summary (visible in NDJSON/log surfacing and any later re-render).
 * An already-BLOCKED gate just records the extra cause. Mutates `gate` in
 * place; returns true when enforcement fired.
 */
export function enforceRequiredProofPersistence<G extends { blocked: boolean; summary: string }>(
  gate: G,
  outcome: Pick<ProofPersistenceOutcome, 'mode' | 'requiredBlockReason'>,
): boolean {
  if (!outcome.requiredBlockReason) return false;
  if (!gate.blocked) {
    gate.summary = `${gate.summary} [required-proof-persist]: ${outcome.requiredBlockReason}`;
  }
  gate.blocked = true;
  return true;
}

// ── Offline validation (PW §7 — usable as a CI condition) ───────────────

export interface ProofValidationResult {
  valid: boolean;
  errors: string[];
}

const ATTESTATION_KEYS = [
  'commitSha',
  'diffDigest',
  'taskContractDigest',
  'verificationPlanDigest',
  'harnessManifestDigest',
  'proofDigest',
] as const;

/**
 * Offline validator for a written proof — structural + integrity checks
 * ONLY, no repo access (that is what makes it usable in CI). Re-seals the
 * parsed proof via canonical hashing (order-insensitive) and compares the
 * stored `proofDigest`; every present digest must be well-formed sha256
 * hex. Never throws.
 */
export function validateCompletionProof(proofJson: unknown): ProofValidationResult {
  const errors: string[] = [];
  if (!proofJson || typeof proofJson !== 'object' || Array.isArray(proofJson)) {
    return { valid: false, errors: ['proof must be a JSON object'] };
  }
  const proof = proofJson as CompletionProofWrapperLike;
  if (proof.kind !== PROOF_KIND) errors.push(`kind must be "${PROOF_KIND}"`);
  if (proof.version !== PROOF_VERSION) errors.push(`version must be ${PROOF_VERSION}`);
  if (!proof.evaluation || typeof proof.evaluation !== 'object' || Array.isArray(proof.evaluation)) {
    errors.push('evaluation must be a JSON object');
  }
  if (!proof.attestation || typeof proof.attestation !== 'object' || Array.isArray(proof.attestation)) {
    return { valid: false, errors: [...errors, 'attestation must be a JSON object'] };
  }

  const att = proof.attestation as unknown as Record<string, unknown>;
  for (const key of Object.keys(att)) {
    if (!(ATTESTATION_KEYS as readonly string[]).includes(key)) errors.push(`attestation.${key} is not a known field`);
  }
  for (const key of ATTESTATION_KEYS) {
    const v = att[key];
    if (v === undefined || v === null) {
      if (key === 'harnessManifestDigest' || key === 'proofDigest') errors.push(`attestation.${key} is required`);
      continue;
    }
    if (key === 'commitSha') {
      if (typeof v !== 'string' || v.trim().length === 0) {
        errors.push('attestation.commitSha must be a non-empty git sha string');
      }
      continue;
    }
    if (!isSha256Hex(v)) errors.push(`attestation.${key} must be sha256 hex`);
  }

  // Integrity seal: recompute over the parsed tree and compare.
  if (isSha256Hex(att.proofDigest) && !errors.some((e) => e.startsWith('kind') || e.startsWith('version'))) {
    const recomputed = computeProofDigest({
      kind: proof.kind as string,
      version: proof.version as number,
      evaluation: proof.evaluation,
      attestation: att as unknown as ProofAttestation,
    });
    if (recomputed !== att.proofDigest) {
      errors.push('proofDigest does not match the sealed content (tampered or stale proof)');
    }
  }
  return { valid: errors.length === 0, errors };
}

interface CompletionProofWrapperLike {
  kind?: unknown;
  version?: unknown;
  evaluation?: unknown;
  attestation?: unknown;
}
