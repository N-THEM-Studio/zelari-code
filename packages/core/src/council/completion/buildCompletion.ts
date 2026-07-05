import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationReport } from '../verification/types.js';
import type {
  CouncilCompletion,
  CompletionOpenFail,
  CompletionTaskScope,
} from './types.js';

export interface BuildCompletionInput {
  verification?: {
    ran: boolean;
    ok?: boolean;
    report?: VerificationReport;
  };
  smoke?: {
    ran: boolean;
    ok?: boolean;
    script?: string;
    exitCode?: number;
  };
  degradedRun?: boolean;
  degradedReasons?: string[];
  synthesisText?: string;
  scope?: CompletionTaskScope;
}

function openFailsFromReport(report: VerificationReport | undefined): CompletionOpenFail[] {
  if (!report) return [];
  return report.results
    .filter((r) => !r.ok)
    .map((r) => ({
      id: r.id,
      severity: r.severity,
      message: r.message,
      ...(r.tier ? { tier: r.tier } : {}),
    }));
}

function blockingIds(fails: CompletionOpenFail[]): string[] {
  const ids = fails.filter((f) => f.severity === 'error').map((f) => f.id);
  return [...new Set(ids)];
}

function tierSummary(report: VerificationReport | undefined): Record<string, string> | undefined {
  if (!report) return undefined;
  const out: Record<string, string> = {};
  for (const r of report.results) {
    if (r.tier) out[r.id] = r.tier;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function promptSummaryFrom(synthesisText: string | undefined): string | undefined {
  if (!synthesisText?.trim()) return undefined;
  const oneLine = synthesisText.replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

/** Aggregate hook results into a single completion artifact. */
export function buildCouncilCompletion(input: BuildCompletionInput): CouncilCompletion {
  const openFails = openFailsFromReport(input.verification?.report);
  const blocking = blockingIds(openFails);
  const degraded = input.degradedRun ?? false;

  const verificationOk = input.verification?.ran ? input.verification.ok === true : true;
  const buildOk = input.smoke?.ran ? input.smoke.ok === true : true;

  const readyToCommit =
    !degraded &&
    blocking.length === 0 &&
    verificationOk &&
    buildOk;

  return {
    ok: readyToCommit,
    readyToCommit,
    degraded,
    ...(input.degradedReasons?.length ? { degradedReasons: input.degradedReasons } : {}),
    blocking,
    openFails,
    verification: input.verification?.ran
      ? { ok: input.verification.ok === true, ran: true }
      : { ok: true, ran: false },
    build: input.smoke?.ran
      ? {
          ok: input.smoke.ok === true,
          ran: true,
          ...(input.smoke.script ? { script: input.smoke.script } : {}),
          ...(input.smoke.exitCode !== undefined ? { exitCode: input.smoke.exitCode } : {}),
        }
      : { ok: true, ran: false },
    tiers: tierSummary(input.verification?.report),
    promptSummary: promptSummaryFrom(input.synthesisText),
    ...(input.scope ? { scope: input.scope } : {}),
    generatedAt: new Date().toISOString(),
  };
}

export function writeCouncilCompletion(
  zelariRoot: string,
  completion: CouncilCompletion,
): string {
  const outPath = join(zelariRoot, 'completion.json');
  writeFileSync(outPath, JSON.stringify(completion, null, 2), 'utf8');
  return outPath;
}
