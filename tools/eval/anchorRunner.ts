/**
 * tools/eval/anchorRunner.ts — executes one historical anchor against a
 * harness candidate (2.6 Track A, doc §7).
 *
 * Deterministic by construction:
 *  - fixture files are written into a scratch workspace BEFORE the agent runs;
 *  - the agent runs via an injected `AgentRunner` (headless CLI in prod,
 *    a stub in tests) under the anchor's own budget;
 *  - success is ONLY the deterministic post-run command checks (exit codes);
 *  - the record carries verified outcome + RunCost, never LLM narrative.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addCost, zeroCost, type RunCost } from './cost.ts';
import {
  defaultResourcePolicy,
  resolveProfile,
  resourcePolicyHash,
  toolFingerprintHash,
} from '@zelari/core';
import type { AnchorManifest, AnchorRunRecord } from './types.ts';

export interface AgentRunOutcome {
  ok: boolean;
  toolCalls: number;
  wallMs: number;
  costUsd?: number;
  toolCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  detail?: string;
}

/** Injected executor: production wraps the headless CLI; tests use stubs. */
export type AgentRunner = (anchor: AnchorManifest, workspaceDir: string) => AgentRunOutcome | Promise<AgentRunOutcome>;

/**
 * 2.6.1 (plan §19): REAL provenance by default — computed from the anchor's
 * own profile + the canonical policy hash. Hosts may override (e.g. the
 * headless runner forwarding the live session hashes); records are never
 * allowed to carry empty strings.
 */
function defaultProvenance(anchor: AnchorManifest): { harnessManifestHash: string; resourcePolicyHash: string } {
  const profile = resolveProfile(anchor.profile);
  return {
    harnessManifestHash: toolFingerprintHash(profile.tools.map((name) => ({ name }))),
    resourcePolicyHash: resourcePolicyHash(defaultResourcePolicy(anchor.profile)),
  };
}

export interface AnchorRunnerOptions {
  runner: AgentRunner;
  /** Explicit provenance override (live session hashes). */
  provenance?: { harnessManifestHash?: string; resourcePolicyHash?: string };
  /** Parent scratch dir (created if missing). Defaults to os.tmpdir(). */
  workspaceRoot?: string;
  /** Shell used for fixture/setup/success commands (default: process shell). */
  shell?: string;
  now?: () => string;
}

function runCommand(cmd: string, cwd: string, shell: string): { code: number; stderr: string } {
  const res = spawnSync(cmd, { cwd, shell, encoding: 'utf8', timeout: 120_000 });
  return { code: res.status ?? -1, stderr: String(res.stderr ?? '') };
}

export async function runAnchor(
  anchor: AnchorManifest,
  options: AnchorRunnerOptions,
): Promise<AnchorRunRecord> {
  const runId = randomUUID();
  const recordedAt = (options.now ?? (() => new Date().toISOString()))();
  const prov = { ...defaultProvenance(anchor), ...(options.provenance ?? {}) };
  const workspaceDir = path.join(options.workspaceRoot ?? import.meta.dirname ?? '.', `anchor-${anchor.id}-${runId}`);
  let record: AnchorRunRecord;

  try {
    mkdirSync(workspaceDir, { recursive: true });
    // 1. Deterministic fixture: inline files first, then optional commands.
    for (const file of anchor.fixture.files) {
      const target = path.join(workspaceDir, ...file.path.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }
    const shell = options.shell ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
    for (const cmd of anchor.fixture.commands) {
      const r = runCommand(cmd, workspaceDir, shell);
      if (r.code !== 0) {
        return {
          runId,
          anchorId: anchor.id,
          anchorVersion: anchor.version,
          harnessManifestHash: prov.harnessManifestHash,
          resourcePolicyHash: prov.resourcePolicyHash,
          result: 'blocked',
          verified: false,
          cost: zeroCost(),
          exitCode: r.code,
          reason: 'setup-failed',
          detail: `fixture command failed: ${cmd}`,
          recordedAt,
        };
      }
    }

    // 2. Agent under the anchor's budget (host-enforced by the runner).
    const startedAt = Date.now();
    const outcome = await options.runner(anchor, workspaceDir);
    const agentWallMs = Date.now() - startedAt;

    // 3. Budget verdict (doc §7.4: tool/token/wall limits are hard).
    const overToolCalls = outcome.toolCalls > anchor.budget.maxToolCalls;
    const overWall = anchor.budget.maxWallMs !== undefined && outcome.wallMs > anchor.budget.maxWallMs;
    // 2.6.1 (plan §20): maxTokens is ENFORCED, not just declared.
    const tokenSum = (outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0);
    const overTokens = anchor.budget.maxTokens !== undefined && tokenSum >= anchor.budget.maxTokens;

    // 4. Deterministic success checks — the ONLY golden signal (§7.7).
    let checksOk = true;
    let firstFailure = '';
    let exitCode = 0;
    for (const check of anchor.success) {
      const r = runCommand(check.command, workspaceDir, shell);
      const expect = check.expectExit ?? 0;
      if (r.code !== expect) {
        checksOk = false;
        firstFailure = firstFailure || `${check.command} → exit ${r.code} (expected ${expect})`;
        exitCode = r.code;
      }
    }

    const cost: RunCost = addCost(zeroCost(), {
      ...zeroCost(),
      inputTokens: outcome.inputTokens ?? 0,
      outputTokens: outcome.outputTokens ?? 0,
      cacheHitTokens: outcome.cacheHitTokens ?? 0,
      toolCalls: outcome.toolCalls,
      wallMs: agentWallMs,
      modelCostUsd: outcome.costUsd ?? 0,
      toolCostUsd: outcome.toolCostUsd,
    });

    if (!outcome.ok) {
      record = {
        runId, anchorId: anchor.id, anchorVersion: anchor.version,
        harnessManifestHash: prov.harnessManifestHash, resourcePolicyHash: prov.resourcePolicyHash,
        result: 'fail', verified: false, cost, exitCode: 1,
        reason: 'agent-error', detail: outcome.detail, recordedAt,
      };
    } else if (overToolCalls) {
      record = {
        runId, anchorId: anchor.id, anchorVersion: anchor.version,
        harnessManifestHash: prov.harnessManifestHash, resourcePolicyHash: prov.resourcePolicyHash,
        result: 'blocked', verified: false, cost, exitCode: 0,
        reason: 'budget-exceeded-tool-calls',
        detail: `${outcome.toolCalls} > ${anchor.budget.maxToolCalls}`, recordedAt,
      };
    } else if (overWall) {
      record = {
        runId, anchorId: anchor.id, anchorVersion: anchor.version,
        harnessManifestHash: prov.harnessManifestHash, resourcePolicyHash: prov.resourcePolicyHash,
        result: 'blocked', verified: false, cost, exitCode: 0,
        reason: 'budget-exceeded-wall',
        detail: `${agentWallMs}ms > ${anchor.budget.maxWallMs}ms`, recordedAt,
      };
    } else if (overTokens) {
      record = {
        runId, anchorId: anchor.id, anchorVersion: anchor.version,
        harnessManifestHash: prov.harnessManifestHash, resourcePolicyHash: prov.resourcePolicyHash,
        result: 'blocked', verified: false, cost, exitCode: 0,
        reason: 'budget-exceeded-tokens',
        detail: `${tokenSum} >= ${anchor.budget.maxTokens}`, recordedAt,
      };
    } else if (!checksOk) {
      record = {
        runId, anchorId: anchor.id, anchorVersion: anchor.version,
        harnessManifestHash: prov.harnessManifestHash, resourcePolicyHash: prov.resourcePolicyHash,
        result: 'fail', verified: false, cost, exitCode,
        reason: 'checks-failed', detail: firstFailure, recordedAt,
      };
    } else {
      record = {
        runId, anchorId: anchor.id, anchorVersion: anchor.version,
        harnessManifestHash: prov.harnessManifestHash, resourcePolicyHash: prov.resourcePolicyHash,
        result: 'pass', verified: true, cost, exitCode: 0, recordedAt,
      };
    }
  } finally {
    // Restorable fixture: the scratch workspace is disposable.
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  return record;
}
