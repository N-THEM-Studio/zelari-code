/**
 * contractCompiler tests — t22 (§P1.C × PW §8).
 * Locks: forbidden→deny; allowedPaths⇒allow+catch-all deny; RESTRICT-ONLY
 * (a contract allow NEVER overrides a global/project deny; a contract deny
 * survives every base decision); hint commands join the SAME CompletionPolicy
 * evaluation as the native pack; PW §8 steer ⇒ version+1 AND new proof digest.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShellProvider, ShellResult } from '@zelari/core/runtime';
import { applyTaskContractUpdate, type TaskContract } from '@zelari/core';
import {
  activeContractCriteria,
  activeContractScope,
  compileCapabilityRules,
  compileVerificationCriteria,
  contractCapabilityLayer,
  contractCriteriaFor,
  evaluateContractCriteria,
  matchContractCapabilityRule,
  setActiveContractScope,
} from './contractCompiler.js';
import {
  buildAttestedWrapper,
  canonicalJson,
  sha256Hex,
} from './completionProofAttestation.js';
import { activeTaskContractSnapshot } from './completionProofProbe.js';
import { writeCompletionProofDetailed } from './completionProof.js';
import { evaluateStrictBuildGate, strictGateEventPayload } from './verificationBridge.js';
import { resetKrakenCandidates } from './candidateRegistry.js';
import { intersectEffects, matchAgentPolicyRuleLayered } from '../safety/policyLayers.js';
import { mergeRuleEffect, matchAgentPolicyRule, EMPTY_POLICY_RULE_SET } from '../safety/policyEngine.js';

const WRITE = ['write'] as const;

function mkContract(over: Partial<TaskContract> = {}): TaskContract {
  return {
    version: 1,
    goal: 'ship the feature',
    constraints: [],
    acceptanceCriteria: [{ id: 'ac-1', text: 'tests pass', source: 'user', required: true }],
    source: { userSeq: 2 },
    ...over,
  };
}

function stubShell(byCommand: Record<string, { exit?: number; stdout?: string }>): ShellProvider {
  return {
    async exec(command: string): Promise<ShellResult> {
      const canned = byCommand[command] ?? { exit: 0, stdout: '' };
      return {
        exitCode: canned.exit ?? 0,
        stdout: canned.stdout ?? '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      };
    },
  };
}

afterEach(() => {
  // Never leak an active scope into other suites.
  setActiveContractScope(undefined);
  resetKrakenCandidates();
});

describe('compileCapabilityRules', () => {
  it('compiles each forbiddenPath glob into a deny rule', () => {
    const rules = compileCapabilityRules(
      mkContract({ scope: { forbiddenPaths: ['vendor/**', '.zelari/secrets/**'] } }),
    );
    expect(rules.map((r) => r.effect)).toEqual(['deny', 'deny']);
    expect(rules.map((r) => r.reason)).toEqual(['contract:forbiddenPath', 'contract:forbiddenPath']);
    expect(rules[0]).toMatchObject({ match: 'vendor/**', effect: 'deny' });
  });

  it('allowedPaths ⇒ allow inside + catch-all deny outside (first-match-wins order)', () => {
    const rules = compileCapabilityRules(mkContract({ scope: { allowedPaths: ['src/**', 'docs/**'] } }));
    expect(rules[0]).toMatchObject({ match: 'src/**', effect: 'allow', reason: 'contract:allowedPath' });
    expect(rules[1]?.match).toBe('docs/**');
    expect(rules[rules.length - 1]).toMatchObject({ match: '**', effect: 'deny', reason: 'contract:outsideAllowedPaths' });
  });

  it('overlaps stay conservative: forbidden denies come BEFORE allowed allows', () => {
    const rules = compileCapabilityRules(
      mkContract({ scope: { allowedPaths: ['src/**'], forbiddenPaths: ['src/generated/**'] } }),
    );
    expect(rules[0]).toMatchObject({ match: 'src/generated/**', effect: 'deny' });
  });

  it('no scope / blank globs ⇒ no rules at all', () => {
    expect(compileCapabilityRules(mkContract())).toEqual([]);
    expect(contractCapabilityLayer(mkContract())).toEqual({ shell: [], edit: [] });
    expect(compileCapabilityRules(mkContract({ scope: { allowedPaths: [''], forbiddenPaths: ['  '] } }))).toEqual([]);
  });
});

describe('capability layer is RESTRICT-ONLY (non-overridable)', () => {
  const scoped = mkContract({ scope: { allowedPaths: ['src/**'], forbiddenPaths: ['vendor/**'] } });
  const layer = contractCapabilityLayer(scoped);

  it('contract allow never relaxes a global deny (layered intersection)', () => {
    const globalDenyAll = { shell: [], edit: [{ match: '**', effect: 'deny' as const }] };
    // The global+project layers say DENY everywhere…
    const layeredHit = matchAgentPolicyRuleLayered(
      { global: globalDenyAll, project: EMPTY_POLICY_RULE_SET },
      'restrict-only',
      WRITE,
      { path: 'src/a.ts' },
      'E:/repo',
    );
    // …the contract layer says ALLOW for src/**…
    const contractHit = matchAgentPolicyRule(layer, WRITE, { path: 'src/a.ts' }, 'E:/repo');
    expect(contractHit?.effect).toBe('allow');
    // …and the combined verdict is STILL deny (rank lattice, t14/t16 intact).
    expect(intersectEffects(layeredHit?.effect, contractHit?.effect)).toBe('deny');
  });

  it('a contract deny wins against EVERY possible base decision', () => {
    for (const base of ['allow', 'ask', 'deny'] as const) {
      const outside = matchAgentPolicyRule(layer, WRITE, { path: 'docs/x.md' }, 'E:/repo');
      expect(outside?.reason).toBe('contract:outsideAllowedPaths');
      expect(mergeRuleEffect(base, outside)).toBe('deny');
    }
    // Even stacked over another ask/deny it stays deny — never narrowed.
    expect(intersectEffects('ask', matchAgentPolicyRule(layer, WRITE, { path: 'vendor/k.txt' }, 'E:/repo')?.effect)).toBe('deny');
  });

  it('matches root-relative and absolute Windows-style paths alike', () => {
    expect(matchAgentPolicyRule(layer, WRITE, { path: 'E:\\repo\\src\\deep\\x.ts' }, 'E:\\repo')?.effect).toBe('allow');
    expect(matchAgentPolicyRule(layer, WRITE, { path: 'E:\\repo\\notes.txt' }, 'E:\\repo')?.effect).toBe('deny');
  });

  it('seam registers/clears the ACTIVE scope; inert when unset', () => {
    expect(activeContractScope()).toBeUndefined();
    expect(matchContractCapabilityRule(WRITE, { path: 'src/a.ts' }, 'E:/repo')).toBeNull();
    setActiveContractScope(scoped);
    expect(activeContractScope()?.contract.version).toBe(1);
    expect(matchContractCapabilityRule(WRITE, { path: 'vendor/k.txt' }, 'E:/repo')?.effect).toBe('deny');
    setActiveContractScope(undefined);
    expect(matchContractCapabilityRule(WRITE, { path: 'vendor/k.txt' }, 'E:/repo')).toBeNull();
  });
});

describe('compileVerificationCriteria', () => {
  const hinted = mkContract({
    acceptanceCriteria: [
      { id: 'ac-1', text: 'npm test', source: 'user', required: true, verificationHint: { kind: 'command', value: 'npm test --silent' } },
      { id: 'ac-2', text: 'manual look', source: 'user', required: false, verificationHint: { kind: 'semantic' } },
      { id: 'ac-3', text: 'no hint', source: 'agent-derived', required: false },
      { id: 'ac-4', text: 'blank value', source: 'user', required: true, verificationHint: { kind: 'command', value: '   ' } },
    ],
  });

  it('hinted shell commands become deterministic criteria (id contract:<id>)', () => {
    const criteria = compileVerificationCriteria(hinted);
    expect(criteria).toHaveLength(1);
    expect(criteria[0]).toMatchObject({
      id: 'contract:ac-1',
      text: 'npm test',
      source: 'task',
      required: true,
      check: { kind: 'command', command: 'npm test --silent' },
    });
  });

  it('non-command hints, missing hints and blank values contribute nothing', () => {
    const quiet = mkContract();
    expect(contractCriteriaFor(quiet)).toEqual([]);
    expect(activeContractCriteria()).toEqual([]); // no scope registered
    expect(compileVerificationCriteria(hinted).map((c) => c.id)).not.toContain('contract:ac-2');
    expect(compileVerificationCriteria(hinted).map((c) => c.id)).not.toContain('contract:ac-4');
  });
});

describe('evaluateContractCriteria', () => {
  const hinted = mkContract({
    acceptanceCriteria: [
      { id: 'ac-1', text: 'pass cmd', source: 'user', required: true, verificationHint: { kind: 'command', value: 'ok-cmd' } },
      { id: 'ac-2', text: 'fail cmd', source: 'user', required: true, verificationHint: { kind: 'command', value: 'bad-cmd' } },
    ],
  });

  it('runs through the core engine: exit codes + digested evidence', async () => {
    const evaluation = await evaluateContractCriteria(hinted, {
      shell: stubShell({ 'bad-cmd': { exit: 3 } }),
    });
    expect(evaluation?.criteria.map((c) => c.id)).toEqual(['contract:ac-1', 'contract:ac-2']);
    const byId = new Map(evaluation!.results.map((r) => [r.criterionId, r]));
    expect(byId.get('contract:ac-1')?.status).toBe('pass');
    expect(byId.get('contract:ac-2')?.status).toBe('fail');
    expect(byId.get('contract:ac-2')?.evidence[0]?.tier).toBe('command-output');
    expect(typeof byId.get('contract:ac-2')?.evidence[0]?.digest).toBe('string');
  });

  it('null when the contract binds no commands or none is given', async () => {
    expect(await evaluateContractCriteria(mkContract(), { shell: stubShell({}) })).toBeNull();
    expect(await evaluateContractCriteria(undefined, { shell: stubShell({}) })).toBeNull();
  });
});

describe('PW §8: steer bumps version AND the proof digest', () => {
  it('taskContractDigest tracks the CURRENT contract across steers', async () => {
    const v1 = mkContract({
      scope: { allowedPaths: ['src/**'], forbiddenPaths: ['vendor/**'] },
      acceptanceCriteria: [{ id: 'ac-1', text: 'npm test', source: 'user', required: true, verificationHint: { kind: 'command', value: 'ok-cmd' } }],
    });
    const D1 = sha256Hex(canonicalJson(v1));

    const sealedV1 = await buildAttestedWrapper({}, { skipProbes: true, taskContract: v1 });
    expect(sealedV1.attestation.taskContractDigest).toBe(D1);

    // Steer: the scope must SURVIVE and the version bump changes the seal.
    const v2 = applyTaskContractUpdate(v1, {
      goal: 'steered goal',
      nextUserSeq: 9,
      addCriteria: [{ id: 'ac-2', text: 'lint clean', source: 'user', required: true, verificationHint: { kind: 'command', value: 'npm run lint' } }],
    });
    expect(v2.version).toBe(2);
    expect(v2.scope).toEqual(v1.scope);
    const D2 = sha256Hex(canonicalJson(v2));
    expect(D2).not.toBe(D1);

    // Live-seam path: register v2 → the written proof carries D2. No
    // skipProbes: the writer must default to the CURRENT seam contract.
    setActiveContractScope(v2);
    expect(activeTaskContractSnapshot()).toEqual(v2);
    const baseDir = mkdtempSync(path.join(tmpdir(), 'zelari-t22-proof-'));
    try {
      const outcome = await writeCompletionProofDetailed(
        {
          gate: { total: 0, passed: 0, failedChecks: [], unknownChecks: [], blocked: false, selectionUsed: false } as never,
          strict: false,
          evaluation: null,
          native: null,
          blocked: false,
          summary: 'open',
        } as Parameters<typeof writeCompletionProofDetailed>[0],
        { baseDir },
      );
      expect(outcome.paths?.jsonPath).toBeTruthy();
      const proof = JSON.parse(readFileSync(outcome.paths!.jsonPath, 'utf8')) as {
        attestation?: { taskContractDigest?: string };
      };
      expect(proof.attestation?.taskContractDigest).toBe(D2);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe('join with the CompletionPolicy (same evaluation as the pack)', () => {
  it('contract-only turn: a failing Verify command blocks the strict gate', async () => {
    const envPrev = process.env.ZELARI_STRICT_DONE;
    process.env.ZELARI_STRICT_DONE = '1';
    try {
      const contract = mkContract({
        acceptanceCriteria: [
          { id: 'ac-1', text: 'tests pass', source: 'user', required: true, verificationHint: { kind: 'command', value: 't22-failing-cmd' } },
        ],
      });
      const evaluation = await evaluateStrictBuildGate('build', {
        env: { ZELARI_VERIFY_PACK: '0', ZELARI_STRICT_DONE: '1' },
        shell: stubShell({ 't22-failing-cmd': { exit: 1 } }),
        taskContract: contract,
      });
      expect(evaluation.compiled?.results[0]?.status).toBe('fail');
      expect(evaluation.evaluation?.verdict).toBe('REPAIR_REQUIRED');
      expect(evaluation.blocked).toBe(true);
      // Same evaluation surfaces in the spine payload (additive key only).
      const payload = strictGateEventPayload(evaluation);
      expect((payload as { compiled?: { results: Array<{ status: string }> } }).compiled?.results[0]?.status).toBe('fail');
    } finally {
      if (envPrev === undefined) delete process.env.ZELARI_STRICT_DONE;
      else process.env.ZELARI_STRICT_DONE = envPrev;
    }
  });
});

describe('payload compatibility', () => {
  it('strictGateEventPayload omits the compiled key when there is no contribution', () => {
    expect(strictGateEventPayload({
      gate: { total: 0, passed: 0, failedChecks: [], unknownChecks: [], blocked: false, selectionUsed: false } as never,
      strict: false,
      evaluation: null,
      native: null,
      compiled: null,
      blocked: false,
      summary: 'open',
    } as never)).not.toHaveProperty('compiled');
  });
});
