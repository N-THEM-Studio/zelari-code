/**
 * completionProofAttestation — t20 (§P1.B × PW §7): deterministic sealing
 * core for the completion proof artifact.
 *
 * The v2 proof JSON wraps the EXISTING spine `verification.run` payload
 * (`strictGateEventPayload`) under `evaluation` — verbatim, never
 * rewritten — and attaches an `attestation` block of sha256 seals:
 *
 *   { kind:'completion-proof', version:2,
 *     evaluation: <spine payload, untouched>,
 *     attestation: {
 *       commitSha?,                 // raw HEAD sha (not a digest), optional
 *       diffDigest?,                // sha256(`git diff` [+ --cached])
 *       taskContractDigest?,        // sha256(canonicalJson(contract))
 *       verificationPlanDigest?,    // sha256(canonicalJson({packId,commands}))
 *       harnessManifestDigest,      // sha256(canonicalJson(manifest))
 *       proofDigest } }             // self-seal over everything above minus itself
 *
 * Digests hash CANONICAL JSON (recursive key sort), so two structurally
 * equal trees hash identically regardless of on-disk property order.
 * Repo-dependent inputs (git, adapters, harness identity) resolve lazily in
 * ./completionProofProbe.js; offline RE-validation lives in
 * ./completionProofPersist.js (validateCompletionProof). Zero deps beyond
 * node:crypto.
 */

/** Artifact identity — checked first by every consumer. */
export const PROOF_KIND = 'completion-proof';
/** v2 introduces the wrapper + attestation block (t20). */
export const PROOF_VERSION = 2;

import { createHash } from 'node:crypto';

/** sha256 as lowercase hex. */
export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays ordered,
 * `undefined` values dropped, non-finite numbers honestly `null`. This is
 * the ONE serialization admitted to any digest here — never used for
 * writing files (the writer preserves payload key order byte-for-byte).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonicalValue(v);
    }
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value ?? null;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A well-formed lowercase sha256 hex digest. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

// ── Wrapper construction ─────────────────────────────────────────────────

export interface HarnessManifest {
  /** Harness version — package.json `version`, fallback constant below. */
  harnessVersion: string;
  /** Native criteria pack id (@zelari/core/verification ZELARI_CODING_PACK_ID). */
  packId: string;
  /** Ecosystem adapters eligible for native verification (registry order). */
  adapters: readonly string[];
  /** policyLayers precedence mode active for this run. */
  policyPrecedence: string;
  /** policyLoadMode mode active for this run (strict|permissive). */
  policyLoadMode: string;
}

/** Optional, host-supplied context sealed into the attestation. */
export interface ProofAttestationOptions {
  /** TaskContract of this run when one exists (hashed canonically). */
  taskContract?: unknown;
  /** Resolved verification plan ({packId, commands}) when one applies. */
  verificationPlan?: unknown;
  /** Pre-resolved git inputs (defaults to probing; see probe module). */
  git?: GitAttestationInputs;
  /** Skip all git/fs probing (hermetic tests, non-repo artifacts). */
  skipProbes?: boolean;
}

/** Raw git facts that FEED optional attestation digests. */
export interface GitAttestationInputs {
  commitSha?: string;
  /** Raw `git diff` (+ `--cached`) text; hashed into diffDigest. */
  diffText?: string;
}

export interface ProofAttestation {
  commitSha?: string;
  diffDigest?: string;
  taskContractDigest?: string;
  verificationPlanDigest?: string;
  harnessManifestDigest: string;
  proofDigest: string;
}

export interface CompletionProofWrapper {
  kind: typeof PROOF_KIND;
  version: typeof PROOF_VERSION;
  evaluation: Record<string, unknown>;
  attestation: ProofAttestation;
}

/**
 * Self-integrity seal: canonical sha256 over kind+version+evaluation plus
 * every OTHER attestation field (proofDigest itself always excluded, so a
 * fresh proof may pass its placeholder through). Order-insensitive.
 */
export function computeProofDigest(wrapper: {
  kind: string;
  version: number;
  evaluation?: unknown;
  attestation: Omit<ProofAttestation, 'proofDigest'> & { proofDigest?: string };
}): string {
  const { kind, version, evaluation, attestation } = wrapper;
  const { proofDigest: _seal, ...sealedFields } = attestation;
  void _seal;
  return sha256Hex(canonicalJson({ kind, version, evaluation: evaluation ?? null, attestation: sealedFields }));
}

/**
 * Build the full attestation for one evaluation: hashes every provided /
 * probed input, then seals the record with `proofDigest`. Probing (git +
 * verification-plan resolution) happens ONCE here when not supplied and
 * not skipped; failures just omit OPTIONAL fields (manifest + self-seal
 * are unconditional). Never throws.
 */
export async function buildAttestedWrapper(
  evaluation: Record<string, unknown>,
  options: ProofAttestationOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<CompletionProofWrapper> {
  const probe = await import('./completionProofProbe.js');
  const attestation: ProofAttestation = {
    harnessManifestDigest: sha256Hex(canonicalJson(await probe.harnessManifest(env))),
    proofDigest: '', // placeholder — sealed below
  };

  let gitInputs = options.git ?? {};
  if (!options.git && !options.skipProbes) {
    try {
      gitInputs = await probe.gatherGitAttestation(cwd);
    } catch {
      gitInputs = {};
    }
  }
  if (gitInputs.commitSha) attestation.commitSha = gitInputs.commitSha;
  if (!options.skipProbes && typeof gitInputs.diffText === 'string') {
    attestation.diffDigest = sha256Hex(gitInputs.diffText);
  }

  if (options.taskContract && typeof options.taskContract === 'object') {
    attestation.taskContractDigest = sha256Hex(canonicalJson(options.taskContract));
  }
  if (options.verificationPlan && typeof options.verificationPlan === 'object') {
    attestation.verificationPlanDigest = sha256Hex(canonicalJson(options.verificationPlan));
  }

  const wrapper: CompletionProofWrapper = {
    kind: PROOF_KIND,
    version: PROOF_VERSION,
    evaluation,
    attestation,
  };
  attestation.proofDigest = computeProofDigest(wrapper);
  return wrapper;
}

// ── Markdown view (derived from the SAME sealed object) ──────────────────

/** Short form used in the markdown table: first 12 hex chars + ellipsis. */
function short(v: string): string {
  return `${v.slice(0, 12)}…`;
}

/**
 * The `## Attestation` markdown body: a short-form digest table plus a
 * fenced block with every full value. Derived from the SAME sealed
 * attestation that seals the JSON wrapper — both views come from one
 * evaluation, so they can never disagree.
 */
export function attestationSection(attestation: ProofAttestation): string[] {
  const lines: string[] = [
    '## Attestation',
    '',
    "Deterministic sha256 seals over this evaluation's inputs (proof v2).",
    '`proofDigest` covers everything below except itself — re-verify offline',
    'with `validateCompletionProof`.',
    '',
    '| Field | Digest |',
    '| --- | --- |',
  ];
  if (attestation.commitSha) lines.push(`| commitSha | \`${short(attestation.commitSha)}\` |`);
  if (attestation.diffDigest) lines.push(`| diffDigest | \`${short(attestation.diffDigest)}\` |`);
  if (attestation.taskContractDigest) lines.push(`| taskContractDigest | \`${short(attestation.taskContractDigest)}\` |`);
  if (attestation.verificationPlanDigest) {
    lines.push(`| verificationPlanDigest | \`${short(attestation.verificationPlanDigest)}\` |`);
  }
  lines.push(`| harnessManifestDigest | \`${short(attestation.harnessManifestDigest)}\` |`);
  lines.push(`| proofDigest | \`${short(attestation.proofDigest)}\` |`);
  lines.push('', 'Full values (sha256 hex):', '', '```text');
  for (const [key, value] of Object.entries(attestation)) lines.push(`${key.padEnd(24)} ${value}`);
  lines.push('```');
  return lines;
}
