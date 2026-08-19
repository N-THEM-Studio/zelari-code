/**
 * verification/engine.ts — deterministic VerificationEngine (ADR-0023).
 *
 * Zero LLM: criteria with a deterministic check are evaluated via the
 * injected Shell/Fs providers; everything else (no check, provider missing,
 * timeout) is honestly `unknown`. Every result carries EvidenceRef with a
 * sha256 digest of the captured output, and a `verification.run` event is
 * appended to the session spine when an emitter is configured.
 */

import { createHash } from 'node:crypto';
import type { FsProvider, ShellProvider } from '../runtime/providers.js';
import type { SessionEventInput } from '../session/types.js';
import type { Criterion, EvidenceRef, VerificationResult } from './types.js';

export interface VerificationServices {
  shell?: ShellProvider;
  fs?: FsProvider;
}

export interface VerificationEngineOptions {
  /** Session spine emitter (ExecutionContext.appendSessionEvent). */
  emit?: (input: SessionEventInput) => Promise<unknown>;
  now?: () => number;
  sha256?: (input: string) => string;
}

function defaultSha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function tail(text: string, max = 400): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

export class VerificationEngine {
  constructor(
    private readonly services: VerificationServices = {},
    private readonly options: VerificationEngineOptions = {},
  ) {}

  /** Evaluate criteria deterministically; optionally emit the spine event. */
  async evaluate(criteria: readonly Criterion[], context: { packId?: string } = {}): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const criterion of criteria) {
      results.push(await this.evaluateOne(criterion));
    }
    if (this.options.emit) {
      await this.options.emit({
        kind: 'verification.run',
        actor: { type: 'system', role: 'verification' },
        data: {
          source: 'deterministic-engine',
          packId: context.packId,
          results: results.map((r) => ({
            criterionId: r.criterionId,
            status: r.status,
            evidence: r.evidence.map((e) => ({ tier: e.tier, ref: e.ref, digest: e.digest })),
          })),
        },
      });
    }
    return results;
  }

  private async evaluateOne(criterion: Criterion): Promise<VerificationResult> {
    const started = this.options.now?.() ?? Date.now();
    const base = {
      criterionId: criterion.id,
      source: 'deterministic-engine' as const,
      evaluatedAt: started,
    };
    const done = (patch: Pick<VerificationResult, 'status' | 'evidence'> & { detail?: string }): VerificationResult => ({
      ...base,
      ...patch,
      durationMs: Math.max(0, (this.options.now?.() ?? Date.now()) - started),
    });

    const check = criterion.check;
    if (!check || check.kind === 'none') {
      return done({
        status: 'unknown',
        evidence: [],
        detail:
          check?.kind === 'none' && check.reason
            ? check.reason
            : 'no deterministic check bound — unknown ≠ pass',
      });
    }

    switch (check.kind) {
      case 'command':
        return await this.evalCommand(check, done);
      case 'file-exists':
        return await this.evalFileExists(check, done);
      case 'file-contains':
        return await this.evalFileContains(check, done);
      case 'file-absent':
        return await this.evalFileAbsent(check, done);
    }
  }

  private async evalCommand(
    check: { command: string; expectExit?: number; expectStdoutIncludes?: string; timeoutMs?: number },
    done: (patch: Pick<VerificationResult, 'status' | 'evidence'> & { detail?: string }) => VerificationResult,
  ): Promise<VerificationResult> {
    const sha256 = this.options.sha256 ?? defaultSha256;
    const shell = this.services.shell;
    if (!shell) {
      return done({ status: 'unknown', evidence: [], detail: 'shell provider unavailable' });
    }
    const result = await shell.exec(check.command, { timeoutMs: check.timeoutMs });
    const evidence: EvidenceRef[] = [
      {
        tier: 'command-output',
        ref: `${check.command} → exit ${result.exitCode ?? 'signal'}`,
        capturedAt: Date.now(),
        digest: sha256(result.stdout),
      },
    ];
    if (result.timedOut) {
      return done({ status: 'unknown', evidence, detail: `command timed out (${check.timeoutMs ?? 'default'}ms)` });
    }
    const expectExit = check.expectExit ?? 0;
    if (result.exitCode !== expectExit) {
      return done({
        status: 'fail',
        evidence,
        detail: `exit ${result.exitCode} (expected ${expectExit}) — stderr: ${tail(result.stderr)}`,
      });
    }
    if (check.expectStdoutIncludes && !result.stdout.includes(check.expectStdoutIncludes)) {
      return done({
        status: 'fail',
        evidence,
        detail: `stdout missing "${check.expectStdoutIncludes}" — got: ${tail(result.stdout)}`,
      });
    }
    return done({ status: 'pass', evidence });
  }

  private fsEvidence(path: string, content: string, sha256: (s: string) => string): EvidenceRef {
    return { tier: 'fs-observation', ref: path, capturedAt: Date.now(), digest: sha256(content) };
  }

  private async evalFileExists(
    check: { path: string },
    done: (patch: Pick<VerificationResult, 'status' | 'evidence'> & { detail?: string }) => VerificationResult,
  ): Promise<VerificationResult> {
    const sha256 = this.options.sha256 ?? defaultSha256;
    const fs = this.services.fs;
    if (!fs) return done({ status: 'unknown', evidence: [], detail: 'fs provider unavailable' });
    const exists = await fs.exists(check.path);
    if (!exists) return done({ status: 'fail', evidence: [], detail: `file not found: ${check.path}` });
    const content = await fs.readFile(check.path).catch(() => '');
    return done({ status: 'pass', evidence: [this.fsEvidence(check.path, content, sha256)] });
  }

  private async evalFileAbsent(
    check: { path: string },
    done: (patch: Pick<VerificationResult, 'status' | 'evidence'> & { detail?: string }) => VerificationResult,
  ): Promise<VerificationResult> {
    const fs = this.services.fs;
    if (!fs) return done({ status: 'unknown', evidence: [], detail: 'fs provider unavailable' });
    const exists = await fs.exists(check.path);
    return exists
      ? done({ status: 'fail', evidence: [], detail: `file still present: ${check.path}` })
      : done({ status: 'pass', evidence: [{ tier: 'fs-observation', ref: check.path, capturedAt: Date.now() }] });
  }

  private async evalFileContains(
    check: { path: string; pattern: string },
    done: (patch: Pick<VerificationResult, 'status' | 'evidence'> & { detail?: string }) => VerificationResult,
  ): Promise<VerificationResult> {
    const sha256 = this.options.sha256 ?? defaultSha256;
    const fs = this.services.fs;
    if (!fs) return done({ status: 'unknown', evidence: [], detail: 'fs provider unavailable' });
    let content: string;
    try {
      content = await fs.readFile(check.path);
    } catch {
      return done({ status: 'fail', evidence: [], detail: `file not readable: ${check.path}` });
    }
    const evidence = [this.fsEvidence(check.path, content, sha256)];
    let hit: boolean;
    try {
      hit = new RegExp(check.pattern, 'm').test(content);
    } catch {
      hit = content.includes(check.pattern);
    }
    return hit
      ? done({ status: 'pass', evidence })
      : done({ status: 'fail', evidence, detail: `pattern not found in ${check.path}: ${tail(check.pattern)}` });
  }
}
