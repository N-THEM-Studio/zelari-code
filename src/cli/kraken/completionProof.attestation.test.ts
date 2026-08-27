/**
 * completionProof attestation + transactional persistence tests (t20 §P1.B).
 *
 * Hermetic contract: proofs are written with `skipProbes` (no git/fs repo
 * probes) into mkdtemp dirs; failure modes use filesystem shapes that fail
 * identically on win32 and POSIX (a regular FILE as baseDir → ENOTDIR).
 * Coverage map:
 *   (a) atomic write — no `.tmp` leftovers, overwrite-safe, valid JSON;
 *   (b) v2 wrapper shape — spine payload verbatim under `evaluation`;
 *   (c) proofDigest self-check — fresh proofs validate; one-byte tampering
 *       flips validateCompletionProof to invalid;
 *   (d) required mode — failed write ⇒ BLOCKED outcome surfaced;
 *   (e) best-effort mode — failed write stays non-blocking;
 *   (f) ZELARI_PROOF_PERSISTENCE resolution precedence.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAttestedWrapper,
  canonicalJson,
  PROOF_KIND,
  PROOF_VERSION,
  sha256Hex,
} from './completionProofAttestation.js';
import { harnessManifest } from './completionProofProbe.js';
import {
  enforceRequiredProofPersistence,
  PROOF_PERSISTENCE_ENV,
  resolveProofPersistenceMode,
  validateCompletionProof,
  writeFileAtomic,
  type ProofPersistenceSurface,
} from './completionProofPersist.js';
import {
  renderCompletionProof,
  writeCompletionProofDetailed,
} from './completionProof.js';
import { strictGateEventPayload, type StrictBuildGateEvaluation } from './verificationBridge.js';

const OPEN_GATE = { total: 0, passed: 0, failedChecks: [], unknownChecks: [], blocked: false, selectionUsed: false };

function passEvaluation(): StrictBuildGateEvaluation {
  return {
    gate: { ...OPEN_GATE, selectionUsed: true, total: 1, passed: 1 },
    strict: true,
    evaluation: {
      verdict: 'PASS',
      satisfied: ['check-1-x'],
      unsatisfied: [],
      evidenceComplete: true,
      eventBackedEvidenceComplete: true,
      summary: 'every required criterion passes with evidence',
    },
    native: null,
    blocked: false,
    summary: 'open (strict PASS)',
  };
}

/** A sealed wrapper built hermetically (no git/fs probes). */
async function sealedWrapper(evaluation = passEvaluation()) {
  return buildAttestedWrapper(strictGateEventPayload(evaluation), { skipProbes: true });
}

describe('canonical hashing primitives', () => {
  it('sha256Hex matches the FIPS vector and is lowercase hex', () => {
    const digest = sha256Hex('abc');
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonicalJson sorts keys recursively so equal trees hash equal', () => {
    const a = canonicalJson({ b: 1, a: { d: [2, 1], c: null } });
    const b = canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 });
    expect(a).toBe(b);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it('harnessManifest pins identity: version, pack id, adapter order, policy modes', async () => {
    const manifest = await harnessManifest({});
    const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(manifest.harnessVersion).toBe(pkg.version);
    expect(manifest.packId).toBe('zelari-coding/v1');
    expect(manifest.adapters).toEqual(['node', 'python', 'rust', 'go', 'java', 'dotnet']);
    expect(['restrict-only', 'legacy']).toContain(manifest.policyPrecedence);
    expect(['strict', 'permissive']).toContain(manifest.policyLoadMode);
  });
});

describe('v2 wrapper shape — the spine payload is wrapped, never rewritten', () => {
  it('(b) evaluation is byte-identical to strictGateEventPayload; attestation present', async () => {
    const evaluation = passEvaluation();
    const wrapper = await sealedWrapper(evaluation);
    expect(wrapper.kind).toBe(PROOF_KIND);
    expect(wrapper.version).toBe(PROOF_VERSION);
    // Byte identity survives a stringify round-trip: writer preserves the
    // original insertion order of the payload.
    expect(JSON.stringify(wrapper.evaluation)).toBe(JSON.stringify(strictGateEventPayload(evaluation)));
    expect(wrapper.attestation.harnessManifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(wrapper.attestation.proofDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('optional inputs seal in; absent inputs stay omitted', async () => {
    const wrapper = await buildAttestedWrapper(
      strictGateEventPayload(passEvaluation()),
      { taskContract: { version: 1 }, verificationPlan: { packId: 'p', commands: {} }, git: { commitSha: 'deadbeef'.repeat(8), diffText: '+ x\n' } },
    );
    expect(wrapper.attestation.commitSha).toBe('deadbeef'.repeat(8));
    expect(wrapper.attestation.diffDigest).toBe(sha256Hex('+ x\n'));
    expect(wrapper.attestation.taskContractDigest).toBe(sha256Hex(canonicalJson({ version: 1 })));
    expect(wrapper.attestation.verificationPlanDigest).toBe(sha256Hex(canonicalJson({ packId: 'p', commands: {} })));
  });

  it('markdown derives from the SAME sealed attestation (short table + full fence)', async () => {
    const { markdown } = renderCompletionProof(passEvaluation(), {}, (await sealedWrapper()).attestation);
    expect(markdown).toContain('## Attestation');
    expect(markdown).toContain('| proofDigest |');
    expect(markdown).toContain((await sealedWrapper()).attestation.proofDigest.slice(0, 12));
    expect(markdown).toContain((await sealedWrapper()).attestation.proofDigest); // full hex in the fenced block
  });
});

describe('offline validation — re-verifies seals WITHOUT repo access', () => {
  it('(c) a freshly WRITTEN proof on disk parses AND validates', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kraken-proof-v2-'));
    try {
      const outcome = await writeCompletionProofDetailed(passEvaluation(), {
        baseDir: dir,
        attestation: { skipProbes: true },
        persistenceMode: 'best-effort',
      });
      expect(outcome.paths).not.toBeNull();
      const onDisk = JSON.parse(await readFile(outcome.paths!.jsonPath, 'utf8')) as unknown;
      expect(validateCompletionProof(onDisk)).toEqual({ valid: true, errors: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('(c) tampering ONE byte of the evaluation breaks the self-seal', async () => {
    const wrapper = await sealedWrapper();
    const tampered = JSON.parse(JSON.stringify(wrapper)) as typeof wrapper;
    tampered.evaluation.summary += '!'; // a single flipped character of evidence
    const result = validateCompletionProof(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('proofDigest'))).toBe(true);
  });

  it('structural drift is rejected: kind, version, bad hex, unknown attestation keys', async () => {
    const wrapper = await sealedWrapper();
    const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

    const wrongKind = clone(wrapper);
    (wrongKind as { kind: string }).kind = 'other';
    expect(validateCompletionProof(wrongKind).errors.join(' ')).toContain('kind');

    const wrongVersion = clone(wrapper);
    (wrongVersion as { version: number }).version = 1;
    expect(validateCompletionProof(wrongVersion).valid).toBe(false);

    const badHex = clone(wrapper);
    badHex.attestation.diffDigest = 'not-hex';
    expect(validateCompletionProof(badHex).errors.join(' ')).toContain('sha256 hex');

    const withOptional = await buildAttestedWrapper(strictGateEventPayload(passEvaluation()), {
      skipProbes: true,
      taskContract: { version: 1 },
    });
    const staleSeal = clone(withOptional);
    delete (staleSeal.attestation as Record<string, unknown>).taskContractDigest;
    // removing an OPTIONAL field changes the sealed bytes → stale proofDigest
    expect(validateCompletionProof(staleSeal).valid).toBe(false);

    const unknownKey = clone(wrapper);
    (unknownKey.attestation as Record<string, unknown>).evilExtra = 'x';
    expect(validateCompletionProof(unknownKey).errors.join(' ')).toContain('known field');

    for (const junk of [null, 42, [], '{}']) {
      expect(validateCompletionProof(typeof junk === 'string' ? JSON.parse(junk) : junk).valid).toBe(false);
    }
  });
});

describe('atomic persistence (tmp → fsync → rename)', () => {
  it('(a) writeCompletionProofDetailed leaves NO .tmp litter and overwrites cleanly', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kraken-proof-atomic-'));
    try {
      const first = await writeCompletionProofDetailed(passEvaluation(), {
        baseDir: dir,
        attestation: { skipProbes: true },
        persistenceMode: 'best-effort',
      });
      expect(first.paths).not.toBeNull();
      // Overwrite with DIFFERENT evaluation (rename-over-existing path).
      const second = await writeCompletionProofDetailed(
        { ...passEvaluation(), summary: 'the LAST evaluation wins' },
        { baseDir: dir, attestation: { skipProbes: true }, persistenceMode: 'best-effort' },
      );
      expect(second.paths).not.toBeNull();

      const entries = await readdir(path.join(dir, '.zelari'));
      expect(entries.filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(entries.sort()).toEqual(['completion-proof.json', 'completion-proof.md']);
      const json = await readFile(second.paths!.jsonPath, 'utf8');
      const parsed = JSON.parse(json) as { evaluation: { verdict: string } };
      expect(parsed.evaluation.verdict).toBe('PASS'); // valid JSON survives both publishes
      expect(await readFile(second.paths!.markdownPath, 'utf8')).toContain('the LAST evaluation wins');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writeFileAtomic replaces an existing target and cleans its own tmp', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kraken-proof-wfa-'));
    try {
      const target = path.join(dir, 'artifact.txt');
      await writeFile(target, 'stale', 'utf8');
      await writeFileAtomic(target, 'fresh');
      await writeFileAtomic(target, 'fresher');
      expect(await readFile(target, 'utf8')).toBe('fresher');
      expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect((await stat(target)).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('proof persistence mode (t20 required-vs-best-effort)', () => {
  /** Any write against this baseDir fails (ENOTDIR on mkdir) on all platforms. */
  let blocker = '';
  beforeEach(async () => {
    blocker = path.join(os.tmpdir(), `kraken-required-${process.pid}`);
    await writeFile(blocker, 'regular file — .zelari cannot exist below here', 'utf8');
  });
  afterEach(async () => {
    await rm(blocker, { force: true });
  });

  it('(d) required mode + unwritable target ⇒ BLOCKED outcome with the failure reason', async () => {
    const evaluation = passEvaluation(); // verification itself PASSES
    const outcome = await writeCompletionProofDetailed(evaluation, {
      baseDir: blocker,
      attestation: { skipProbes: true },
      persistenceMode: 'required',
    });
    expect(outcome.mode).toBe('required');
    expect(outcome.paths).toBeNull();
    expect(outcome.requiredBlockReason).toBeTruthy();

    // Gate flip — the exit-4 family consumes THIS shape downstream.
    expect(enforceRequiredProofPersistence(evaluation, outcome)).toBe(true);
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.summary).toContain('[required-proof-persist]');
    expect(evaluation.summary).toContain(outcome.requiredBlockReason!);
    // strictGateExitCode semantics come free: strict && blocked ⇒ 4.
    expect(evaluation.strict && evaluation.blocked).toBe(true);
  });

  it('(d) required enforcement leaves an ALREADY-BLOCKED gate untouched but firing', () => {
    const gate = { blocked: true, summary: 'blocked for real reasons' };
    expect(enforceRequiredProofPersistence(gate, { mode: 'required', requiredBlockReason: 'boom' })).toBe(true);
    expect(gate.blocked).toBe(true);
    expect(gate.summary).toBe('blocked for real reasons'); // no double-append noise
  });

  it('(e) best-effort mode + same failure ⇒ no block (P0.3 behavior preserved)', async () => {
    const evaluation = passEvaluation();
    const outcome = await writeCompletionProofDetailed(evaluation, {
      baseDir: blocker,
      attestation: { skipProbes: true },
      persistenceMode: 'best-effort',
    });
    expect(outcome.paths).toBeNull();
    expect(outcome.requiredBlockReason).toBeNull();
    expect(enforceRequiredProofPersistence(evaluation, outcome)).toBe(false);
    expect(evaluation.blocked).toBe(false);
  });
});

describe(`${PROOF_PERSISTENCE_ENV} resolution precedence`, () => {
  const resolve = (
    surface: ProofPersistenceSurface,
    override?: string,
    ci?: string,
  ) => resolveProofPersistenceMode({ ...(override !== undefined ? { [PROOF_PERSISTENCE_ENV]: override } : {}) }, { surface, ci });

  it('(f) explicit env override beats every surface default (both directions)', () => {
    expect(resolve('headless', 'best-effort')).toBe('best-effort');
    expect(resolve('mission', 'BEST-EFFORT')).toBe('best-effort'); // case-insensitive
    expect(resolve('tui', 'required')).toBe('required');
  });

  it('(f) unattended surfaces default REQUIRED; interactive TUI defaults BEST-EFFORT', () => {
    expect(resolve('headless')).toBe('required');
    expect(resolve('mission')).toBe('required');
    expect(resolve('tui')).toBe('best-effort');
    // CI conditions consume proofs (PW §7): ambient CI tightens even the TUI.
    expect(resolve('tui', undefined, 'true')).toBe('required');
    expect(resolve('tui', undefined, '0')).toBe('best-effort');
  });

  it('(f) an INVALID override warns-and-defaults — never silently flips durability', () => {
    expect(resolve('headless', 'maybe')).toBe('required');
    expect(resolve('tui', 'sometimes')).toBe('best-effort');
  });

  it('active-surface seam mirrors policyLoadMode registration', async () => {
    const { activeProofPersistenceMode, setActiveProofPersistenceSurface, activeProofPersistenceSurface } =
      await import('./completionProofPersist.js');
    try {
      setActiveProofPersistenceSurface('mission');
      expect(activeProofPersistenceSurface()).toBe('mission');
      expect(activeProofPersistenceMode({})).toBe('required');
      expect(activeProofPersistenceMode({ [PROOF_PERSISTENCE_ENV]: 'best-effort' })).toBe('best-effort');
      setActiveProofPersistenceSurface('headless');
      expect(activeProofPersistenceMode({})).toBe('required');
    } finally {
      setActiveProofPersistenceSurface('tui'); // restore the TUI default for other suites
    }
    expect(activeProofPersistenceMode({})).toBe('best-effort');
  });
});
