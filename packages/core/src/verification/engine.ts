/**
 * verification/engine.ts — deterministic VerificationEngine (ADR-0023).
 *
 * Zero LLM: criteria with a deterministic check are evaluated via the
 * injected Shell/Fs providers; everything else (no check, provider missing,
 * timeout) is honestly `unknown`. Every result carries EvidenceRef with a
 * sha256 digest of the captured output, and a `verification.run` event is
 * appended to the session spine when an emitter is configured.
 *
 * F3 (ADR-0023 §5): every executed observation is ALSO appended as a single
 * `verification.evidence` state event (command line, exit code, digest,
 * output tails) and, when the emitter resolves to the appended envelope, the
 * assigned seq anchors the EvidenceRef — evidence is traceable to the
 * session event that captured it, not to a narrated summary.
 */

import { createHash } from 'node:crypto';
import type { FsProvider, ShellProvider } from '../runtime/providers.js';
import type { SessionEventInput } from '../session/types.js';
import type { Criterion, EvidenceRef, VerificationResult } from './types.js';
import { analyzeScope, type ScopeAnalysisInput } from './scopeDiscipline.js';

export interface VerificationServices {
  shell?: ShellProvider;
  fs?: FsProvider;
}

export interface VerificationEngineOptions {
  /**
   * Session spine emitter (ExecutionContext.appendSessionEvent). May resolve
   * to the appended envelope (or any `{ seq }`) — the seq anchors the
   * EvidenceRef; a void/absent result leaves the ref unanchored.
   */
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
  async evaluate(
    criteria: readonly Criterion[],
    context: { packId?: string; scope?: ScopeAnalysisInput } = {},
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const criterion of criteria) {
      results.push(await this.evaluateOne(criterion, context.scope));
    }
    if (this.options.emit) {
      // Degrade-and-stop discipline: a failing spine must never fail
      // verification — the results stand, the run summary is simply not logged.
      try {
        await this.options.emit({
        kind: 'verification.run',
        actor: { type: 'system', role: 'verification' },
        data: {
          source: 'deterministic-engine',
          packId: context.packId,
          results: results.map((r) => ({
            criterionId: r.criterionId,
            status: r.status,
            evidence: r.evidence.map((e) => ({
              tier: e.tier,
              ref: e.ref,
              digest: e.digest,
              ...(e.seq !== undefined ? { seq: e.seq } : {}),
            })),
          })),
        },
        });
      } catch {
        /* spine unreachable — results stand, summary not logged */
      }
    }
    return results;
  }

  /**
   * F3: append one `verification.evidence` state event with the raw
   * observation and resolve to its session seq when the emitter returns it.
   * Spine failures degrade to `undefined` — an unreachable log must never
   * fail verification, it only leaves the evidence unanchored.
   */
  private async emitEvidence(data: Record<string, unknown>): Promise<number | undefined> {
    if (!this.options.emit) return undefined;
    try {
      const out = await this.options.emit({
        kind: 'verification.evidence',
        actor: { type: 'system', role: 'verification' },
        data,
      });
      if (out && typeof out === 'object' && typeof (out as { seq?: unknown }).seq === 'number') {
        return (out as { seq: number }).seq;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async evaluateOne(
    criterion: Criterion,
    scope?: ScopeAnalysisInput,
  ): Promise<VerificationResult> {
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

    if (criterion.id === 'quality.scope-discipline' && scope) {
      const analysis = analyzeScope(scope);
      // Advisory: concern is not a deterministic fail (plan §8.3).
      const status = analysis.status === 'pass' ? 'pass' : 'unknown';
      return done({
        status,
        evidence: [],
        detail: analysis.reasons.join('; ') || analysis.status,
      });
    }

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
    const digest = sha256(result.stdout);
    // F3: the raw observation lands on the spine; its seq anchors the ref.
    const seq = await this.emitEvidence({
      observation: 'command',
      command: check.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      digest,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    });
    const evidence: EvidenceRef[] = [
      {
        tier: 'command-output',
        ref: `${check.command} → exit ${result.exitCode ?? 'signal'}`,
        capturedAt: Date.now(),
        digest,
        ...(seq !== undefined ? { seq } : {}),
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

  /**
   * F3: the fs observation is logged to the spine (path, existence, optional
   * content digest) and the returned ref carries the event seq when the
   * emitter resolved one.
   */
  private async fsEvidence(
    observation: string,
    path: string,
    sha256?: (s: string) => string,
    content?: string,
    extra: Record<string, unknown> = {},
  ): Promise<EvidenceRef> {
    const digest = sha256 && content !== undefined ? sha256(content) : undefined;
    const seq = await this.emitEvidence({ observation, path, ...extra, ...(digest ? { digest } : {}) });
    return {
      tier: 'fs-observation',
      ref: path,
      capturedAt: Date.now(),
      ...(digest ? { digest } : {}),
      ...(seq !== undefined ? { seq } : {}),
    };
  }

  private async evalFileExists(
    check: { path: string },
    done: (patch: Pick<VerificationResult, 'status' | 'evidence'> & { detail?: string }) => VerificationResult,
  ): Promise<VerificationResult> {
    const sha256 = this.options.sha256 ?? defaultSha256;
    const fs = this.services.fs;
    if (!fs) return done({ status: 'unknown', evidence: [], detail: 'fs provider unavailable' });
    const exists = await fs.exists(check.path);
    if (!exists) {
      await this.emitEvidence({ observation: 'file-exists', path: check.path, exists: false });
      return done({ status: 'fail', evidence: [], detail: `file not found: ${check.path}` });
    }
    const content = await fs.readFile(check.path).catch(() => '');
    return done({
      status: 'pass',
      evidence: [await this.fsEvidence('file-exists', check.path, sha256, content, { exists: true })],
    });
  }

  private async evalFileAbsent(
    check: { path: string },
    done: (patch: Pick<VerificationResult, 'status' | 'evidence'> & { detail?: string }) => VerificationResult,
  ): Promise<VerificationResult> {
    const fs = this.services.fs;
    if (!fs) return done({ status: 'unknown', evidence: [], detail: 'fs provider unavailable' });
    const exists = await fs.exists(check.path);
    if (exists) {
      await this.emitEvidence({ observation: 'file-absent', path: check.path, exists: true });
      return done({ status: 'fail', evidence: [], detail: `file still present: ${check.path}` });
    }
    return done({
      status: 'pass',
      evidence: [await this.fsEvidence('file-absent', check.path, undefined, undefined, { exists: false })],
    });
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
      await this.emitEvidence({ observation: 'file-contains', path: check.path, readable: false });
      return done({ status: 'fail', evidence: [], detail: `file not readable: ${check.path}` });
    }
    const evidence = [await this.fsEvidence('file-contains', check.path, sha256, content)];
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
