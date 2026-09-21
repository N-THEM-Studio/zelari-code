/**
 * commands/evolve — `zelari-code evolve shadow [sessionId] [--json] [--limit N]`
 * (Evolution Controller v0).
 *
 * WHAT IT READS: one spine (`<sessionsDir>/<sessionId>/events.jsonl`, ADR-0016)
 * parsed with the CORE tolerant reader — same discipline as commands/replay.
 * Over the parsed events runs DETECTOR v0, then the controller policy
 * (evolution/controller.ts) turns proposals into `shadow`/`hold` verdicts.
 *
 * DETECTOR v0 is deliberately NARROWER than the eval operator: it pairs a
 * write call and a BY-NAME verify call (verify/run_tests/typecheck/test/task
 * agent=verify) sitting ACROSS a turn boundary. Shell-command verifies
 * (`npx vitest …` inside bash/exec_process) and `reopen_with_minimal_diff`
 * stay in tools/eval/operators/fuseEditVerify.ts — that is the judge surface
 * (ADR-0036 JUDGE_PATHS) and it is not imported here (strip-types module).
 * The detector's limits are printed with the report, never implied.
 *
 * READ-ONLY, absolutely (replay parity): it opens the spine for reading and
 * writes NOTHING — no spine append, no ledger line, no state file, no
 * network. Applying a fusion (running the verify inside the writer's turn) is
 * a later, separately gated slice; v0 only reports what a fused harness
 * WOULD have collapsed, and only when ZELARI_EVOLUTION=shadow says so.
 *
 * Exit codes: 0 the spine was resolved and reported (even with zero
 * proposals); 1 usage error or nothing to read (unknown id / no sessions).
 *
 * @since v2.59.0 (Evolution Controller v0 / shadow)
 */
import { readFileSync } from 'node:fs';
import {
  parseSessionLogText,
  type ReplayReport,
  type SessionEventEnvelope,
} from '@zelari/core/session';
import { resolveSpineSession } from './spineSession.js';
import { evolutionMode } from '../evolution/ledger.js';
import {
  evaluateProposals,
  summarizeVerdicts,
  type ControllerPolicy,
  type ControllerProposal,
  type ControllerVerdict,
} from '../evolution/controller.js';

/** Same write-tool list as the operator (real tally over 1002 local spines). */
const WRITE_TOOLS: readonly string[] = [
  'edit', 'write_file', 'edit_file', 'apply_diff',
  'mcp_filesystem_edit_file', 'mcp_filesystem_write_file',
];

/** By-name verify only — the shell-command predicate is the operator's job. */
const VERIFY_TOOL_RE = /^(verify|run_tests|typecheck|test)(_|$)/;

/** Detector limits, printed with every report (never implied). */
export const DETECTOR_LIMITS: readonly string[] = [
  'detector v0: by-name verifies only — shell-command verifies (vitest/npm regex) are detected by tools/eval/operators/fuseEditVerify.ts, not here',
  'reopen_with_minimal_diff is not detected in v0 (operator-only)',
];

const DETECTOR_NOTE = 'detector v0 (by-name verify only; full predicate lives in tools/eval/operators)';

interface DetCall {
  seq: number;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  path: string;
  ok?: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function callIdOf(call: DetCall): string {
  return call.callId.length > 0 ? call.callId : `seq:${call.seq}`;
}

function isVerify(call: DetCall): boolean {
  if (VERIFY_TOOL_RE.test(call.tool)) return true;
  if (call.tool === 'task') return asString(call.args.agent) === 'verify';
  return false;
}

/**
 * Pure detector over parsed envelopes: write call → turn boundary → by-name
 * verify call. Mirrors the operator's adjacency rule; deliberately narrower
 * (see DETECTOR_LIMITS).
 */
export function detectFuseProposals(
  events: readonly SessionEventEnvelope[],
  limit: number,
): { proposals: ControllerProposal[]; calls: number; turnBoundaries: number } {
  const calls: DetCall[] = [];
  const turns: number[] = [];
  const byCallId = new Map<string, DetCall>();
  for (const e of events) {
    if (e.kind === 'tool.call') {
      const raw = e.data.args;
      const args = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
      const call: DetCall = {
        seq: e.seq,
        callId: asString(e.data.callId),
        tool: asString(e.data.tool),
        args,
        path: asString(args.path),
      };
      calls.push(call);
      if (call.callId.length > 0) byCallId.set(call.callId, call);
    } else if (e.kind === 'tool.result') {
      const call = byCallId.get(asString(e.data.callId));
      if (call !== undefined && typeof e.data.ok === 'boolean') call.ok = e.data.ok;
    } else if (e.kind === 'assistant.message' || e.kind === 'user.message') {
      turns.push(e.seq);
    }
  }

  const proposals: ControllerProposal[] = [];
  for (let i = 0; i + 1 < calls.length; i++) {
    const w = calls[i]!;
    const v = calls[i + 1]!;
    if (proposals.length >= limit) break;
    if (!WRITE_TOOLS.includes(w.tool) || !isVerify(v) || w.ok === false) continue;
    const boundary = turns.filter((s) => s > w.seq && s < v.seq).sort((a, b) => a - b)[0];
    if (boundary === undefined) continue; // same decision batch: already fused
    const wId = callIdOf(w);
    const vId = callIdOf(v);
    proposals.push({
      kind: 'fuse_edit_verify',
      callIds: [wId, vId],
      estSavedCalls: 1,
      evidence: [
        { kind: 'tool.call', ref: `call:${wId}` },
        { kind: 'assistant.message', ref: `seq:${boundary}` },
        { kind: 'tool.call', ref: `call:${vId}` },
      ],
      ...(w.path.length > 0 ? { path: w.path } : {}),
      decisiveSeq: v.seq,
      note: DETECTOR_NOTE,
    });
  }
  return { proposals, calls: calls.length, turnBoundaries: turns.length };
}

export interface EvolveFlags {
  help?: boolean;
  json?: boolean;
  limit?: number;
  cwd?: string;
  subcommand?: string;
  /** Second positional (after the subcommand): the session id, when present. */
  sessionId?: string;
  error?: string;
}

/** Parse `evolve` flags. Never throws; unknown subcommands come back as error. */
export function parseEvolveFlags(argv: readonly string[]): EvolveFlags {
  const args = argv[0] === 'evolve' ? argv.slice(1) : [...argv];
  const out: EvolveFlags = {};
  if (args.includes('--help') || args.includes('-h')) out.help = true;
  out.json = args.includes('--json');
  const limitIndex = args.indexOf('--limit');
  const limitRaw = limitIndex >= 0 ? args[limitIndex + 1] : undefined;
  if (limitRaw !== undefined && /^\d+$/.test(limitRaw)) out.limit = Math.max(1, Number(limitRaw));
  const cwdIndex = args.indexOf('--cwd');
  const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;
  if (cwd !== undefined && cwd.trim() !== '' && !cwd.startsWith('--')) out.cwd = cwd;
  const positionals = args.filter(
    (a, idx) => !a.startsWith('-') && args[idx - 1] !== '--limit' && args[idx - 1] !== '--cwd',
  );
  const [subcommand, sessionId] = positionals;
  if (subcommand !== undefined) out.subcommand = subcommand;
  if (sessionId !== undefined) out.sessionId = sessionId;
  if (!out.help && subcommand !== undefined && subcommand !== 'shadow') {
    out.error = `unknown evolve subcommand '${subcommand}' (v0 ships only 'shadow')`;
  }
  return out;
}

export function evolveHelpText(): string {
  return (
    'zelari-code evolve shadow — Evolution Controller v0 (read-only, no LLM, no network)\n' +
    '\n' +
    'Re-reads one session spine, pairs write→verify call sequences across a turn\n' +
    'boundary (detector v0: by-name verifies only) and prints the controller\n' +
    'verdicts. Verdicts are shadow (report-only) or hold — v0 never applies,\n' +
    'never promotes, never writes (ADR-0036: the proposer is not the measurer).\n' +
    '\n' +
    'Usage:\n' +
    '  zelari-code evolve shadow [sessionId] [--json] [--limit N] [--cwd DIR]\n' +
    '\n' +
    'Options:\n' +
    '  sessionId   explicit session id (default: current marker, then newest)\n' +
    '  --json      machine-readable report (proposals + verdicts + summary)\n' +
    '  --limit N   max proposals reported (default 50)\n' +
    '  --cwd DIR   workspace root for the sessions dir\n' +
    '\n' +
    'Env: ZELARI_EVOLUTION=shadow opts the controller IN (default off — every\n' +
    'verdict is hold with the reason spelled out).\n' +
    'Exit: 0 reported (even with zero proposals) · 1 usage / no spine.\n'
  );
}

function verdictLine(v: ControllerVerdict): string {
  if (v.proposal === undefined) {
    return `  [hold  ] ${v.reason}`;
  }
  const at = `@seq ${v.proposal.decisiveSeq}`;
  const path = v.proposal.path !== undefined ? ` · ${v.proposal.path}` : '';
  const saved = v.action === 'shadow' ? ` · saves ~${v.proposal.estSavedCalls} call` : '';
  return `  [${v.action === 'shadow' ? 'shadow' : 'hold  '}] ${v.proposal.kind} ${at}${path}${saved}${v.action === 'shadow' ? '' : ` — ${v.reason}`}`;
}

/** Entry point (mirrors runReplayCommand: takes the FULL argv, returns exit). */
export async function runEvolveCommand(argv: readonly string[]): Promise<number> {
  const flags = parseEvolveFlags(argv);
  if (flags.help) {
    process.stdout.write(evolveHelpText());
    return 0;
  }
  if (flags.error !== undefined) {
    process.stderr.write(`[zelari-code evolve] ${flags.error}\n${evolveHelpText()}`);
    return 1;
  }

  const target = resolveSpineSession({
    ...(flags.sessionId !== undefined ? { sessionId: flags.sessionId } : {}),
    ...(flags.cwd !== undefined ? { cwd: flags.cwd } : {}),
  });
  if ('error' in target) {
    process.stderr.write(`[zelari-code evolve] ${target.error}\n`);
    return 1;
  }

  let parsed: ReplayReport;
  try {
    parsed = parseSessionLogText('events.jsonl', readFileSync(target.eventsPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[zelari-code evolve] cannot read ${target.eventsPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const limit = flags.limit ?? 50;
  const { proposals, calls, turnBoundaries } = detectFuseProposals(parsed.events, limit);
  const policy: ControllerPolicy = { evolutionMode: evolutionMode(), minEvidence: 3, maxVerdicts: limit };
  const verdicts = evaluateProposals(proposals, policy);
  const summary = summarizeVerdicts(verdicts);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          controller: 'v0-shadow',
          sessionId: target.sessionId,
          path: target.eventsPath,
          events: parsed.events.length,
          issues: parsed.issues.length,
          toolCalls: calls,
          turnBoundaries,
          policy,
          proposals,
          verdicts,
          summary,
          detectorLimits: DETECTOR_LIMITS,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines: string[] = [
    `zelari-code evolve shadow — controller v0 (read-only)`,
    `session ${target.sessionId} · ${target.eventsPath}`,
    `events ${parsed.events.length} (${parsed.issues.length} issues) · tool calls ${calls} · turn boundaries ${turnBoundaries}`,
    `policy: evolution=${policy.evolutionMode} minEvidence=${policy.minEvidence} maxVerdicts=${policy.maxVerdicts}`,
    `verdicts (${verdicts.length}):`,
  ];
  if (verdicts.length === 0) lines.push('  (none — no write→verify pair across a turn boundary)');
  for (const v of verdicts) lines.push(verdictLine(v));
  lines.push(
    `summary: ${summary.shadow} shadow · ${summary.hold} hold · est saved calls ${summary.estSavedCalls} (shadow only)`,
  );
  for (const l of DETECTOR_LIMITS) lines.push(`limit: ${l}`);
  lines.push('apply: none — v0 is report-only; promotion is the eval gate\'s job (ADR-0036)');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
