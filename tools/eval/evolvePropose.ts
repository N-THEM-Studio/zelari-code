/**
 * tools/eval/evolvePropose.ts — Fase 2.0 — evolution PROPOSAL engine
 * (evidence → proposal mapping; append-only store; ZERO auto-mutation).
 *
 * Maps Fase-1 EvidenceFindings (spineEvidence.ts / skillEvidence.ts) to
 * human-reviewable EvolutionProposals. The mapping is CLOSED and
 * deterministic: the same findings in → the same proposals out. The core
 * (buildProposals) is pure — no I/O, no Date.now/random; `id`/`createdAt`
 * are assigned by the append layer (appendProposals), the only impure
 * function in this file.
 *
 * This slice only WRITES proposal documents to an append-only JSONL store.
 * Applying a patch is explicitly out of scope: a proposal is an ask for
 * human review, never a mutation (human approval is structural). Dedupe is
 * fail-closed: an existing record with the same fingerprint blocks
 * re-proposal unless its status is exactly 'withdrawn' — an UNKNOWN stored
 * status also blocks (under-propose rather than spam).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type EvidenceFinding } from './spineEvidence.ts';

export type EvolutionOperator =
  | 'revise_tool_description'
  | 'revise_skill'
  | 'revise_context_policy'
  | 'needs_human_review'
  | 'stop';

export type ProposalStatus = 'proposed' | 'applied' | 'rejected' | 'withdrawn';

export interface EvolutionProposal {
  /** 'p-0001' monotonic per store — assigned by the append layer, never by the pure core. */
  id: string;
  /** ISO timestamp from the injected clock — assigned by the append layer. */
  createdAt: string;
  /** This slice only ever writes 'proposed'. */
  status: ProposalStatus;
  operator: EvolutionOperator;
  /** e.g. 'tool:read_file', 'skill:write-readme', 'policy:context-budget', 'agent:explorer'. */
  surface: string;
  /** `${operator}|${surface}|${primarySignal}` — stable as counts grow (dedupe key). */
  fingerprint: string;
  /** kinds sorted unique; sessions sorted unique union; count summed across the group. */
  evidence: { kinds: string[]; count: number; sessions: string[] };
  /** Deterministic template — never free-form prose. */
  rationale: string;
  /** Deterministic guidance per operator — NOT a fabricated patch. */
  patchHint: string;
  requiredValidation: string[];
}

/** StoredProposal tolerates unknown status strings — recorded as-is (fail-closed dedupe). */
export interface StoredProposal extends Omit<EvolutionProposal, 'status'> {
  status: ProposalStatus | string;
}

/** Deterministic proposal order: operator priority, then count desc, surface asc, primarySignal asc. */
const OPERATOR_PRIORITY: Record<EvolutionOperator, number> = {
  revise_skill: 0,
  revise_tool_description: 1,
  revise_context_policy: 2,
  needs_human_review: 3,
  stop: 4, // never forms a proposal — kept for exhaustiveness
};

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Where a finding maps to, or 'stop' (unmapped — counted, never proposed). */
export interface FindingMapping {
  operator: EvolutionOperator;
  surface: string;
  primarySignal: string;
}

/** Everything after `prefix:` in the finding id ('' suffix is still a match). */
function suffixAfter(id: string, prefix: string): string | undefined {
  return id.startsWith(`${prefix}:`) ? id.slice(prefix.length + 1) : undefined;
}

/**
 * Closed, deterministic mapping — surface keys are parsed from the finding
 * id ONLY (never from detail strings). Findings from many sessions can
 * share one id-shape (e.g. `resource-pressure:<sessionId>`): the constant
 * primarySignal makes them merge into ONE group downstream.
 */
export function mapFinding(f: EvidenceFinding): FindingMapping | 'stop' {
  const id = f.id;
  let rest = suffixAfter(id, 'tool-misuse');
  if (rest !== undefined) {
    return { operator: 'revise_tool_description', surface: `tool:${rest}`, primarySignal: rest };
  }
  rest = suffixAfter(id, 'repeated-tool-error');
  if (rest !== undefined) {
    // `<tool>:<sanitized-error-key>` — distinct root causes stay distinct proposals.
    const sep = rest.indexOf(':');
    const tool = sep >= 0 ? rest.slice(0, sep) : rest;
    const errorKey = sep >= 0 ? rest.slice(sep + 1) : '';
    return { operator: 'revise_tool_description', surface: `tool:${tool}`, primarySignal: `${tool}:${errorKey}` };
  }
  if (id === 'compaction-pressure') {
    return { operator: 'revise_context_policy', surface: 'policy:context-budget', primarySignal: 'compaction-pressure' };
  }
  rest = suffixAfter(id, 'resource-pressure');
  if (rest !== undefined) {
    // Per-session id, constant signal → many sessions merge into ONE proposal.
    return { operator: 'revise_context_policy', surface: 'policy:context-budget', primarySignal: 'resource-pressure' };
  }
  if (id === 'verification-failures') {
    return { operator: 'needs_human_review', surface: 'verification:outcomes', primarySignal: 'failures' };
  }
  if (id === 'verification-unknown') {
    return { operator: 'needs_human_review', surface: 'verification:outcomes', primarySignal: 'unknown' };
  }
  if (id === 'tool-interrupted') {
    return { operator: 'needs_human_review', surface: 'tool-boundary:interrupted', primarySignal: 'interrupted' };
  }
  rest = suffixAfter(id, 'graph-node-failures');
  if (rest !== undefined) {
    return { operator: 'needs_human_review', surface: `agent:${rest}`, primarySignal: rest };
  }
  rest = suffixAfter(id, 'skill-low-success');
  if (rest !== undefined) {
    return { operator: 'revise_skill', surface: `skill:${rest}`, primarySignal: rest };
  }
  return 'stop';
}

/** Validation ask by surface prefix; a review ask validates nothing ([]). */
export function requiredValidationFor(surface: string): string[] {
  if (surface.startsWith('tool:')) return ['npm run typecheck', 'npm run test:eval'];
  if (surface.startsWith('skill:')) return ['npm run test:eval'];
  if (surface.startsWith('policy:')) return ['npm run typecheck', 'npm run test:eval', 'npm run test'];
  return [];
}

function patchHintFor(operator: EvolutionOperator, kindsJoined: string, count: number, sessionCount: number): string {
  switch (operator) {
    case 'revise_tool_description':
      return `Re-read the description/zod schema of the tool; evidence: ${kindsJoined} x${count} across ${sessionCount} session(s). Clarify the argument contract; do not change semantics without eval.`;
    case 'revise_skill':
      return `Inspect this skill's instructions/template; ${count} recorded failure(s). Revise the prompt/template, then re-measure through usage.`;
    case 'revise_context_policy':
      return `Tune context/budget policy (ADR-0032 budget pipeline): ${kindsJoined} x${count}. Adjust budgets/compaction thresholds, then re-run npm run eval:measured.`;
    case 'needs_human_review':
      return 'No automated surface yet — human review of the evidence IS the operator.';
    case 'stop':
      return '';
  }
}

interface ProposalGroup {
  operator: EvolutionOperator;
  surface: string;
  primarySignal: string;
  kinds: Set<string>;
  sessions: Set<string>;
  count: number;
}

function compareGroups(a: ProposalGroup, b: ProposalGroup): number {
  return (
    OPERATOR_PRIORITY[a.operator] - OPERATOR_PRIORITY[b.operator] ||
    b.count - a.count ||
    cmp(a.surface, b.surface) ||
    cmp(a.primarySignal, b.primarySignal)
  );
}

/**
 * Event-sourced projection of the store: fold records by id, LAST record
 * in file order wins. Decisions (Fase 2.1) are appended as NEW records
 * repeating the id, so the effective status of an id is the status of its
 * latest record — the original 'proposed' record is never rewritten.
 * Pure: no I/O, no clock; single-record stores fold to identity.
 */
export function effectiveStatusById(records: StoredProposal[]): Map<string, { status: string; record: StoredProposal }> {
  const byId = new Map<string, { status: string; record: StoredProposal }>();
  for (const r of records) {
    if (typeof r.id !== 'string' || r.id === '') continue;
    byId.set(r.id, { status: r.status, record: r });
  }
  return byId;
}

/**
 * Pure core: findings + existing store records → proposals to write.
 * Grouping key is (operator, surface, primarySignal); count is summed,
 * sessions unioned+sorted, kinds unique+sorted. The fingerprint EXCLUDES
 * count, so dedupe stays stable as evidence accumulates. `deduped` counts
 * groups skipped because an existing record blocks them (same fingerprint,
 * EFFECTIVE status !== 'withdrawn' — last record per id wins, event-sourced;
 * unknown effective statuses block — fail-closed).
 * Proposals leave with empty id/createdAt — assigned by the append layer.
 */
export function buildProposals(
  findings: EvidenceFinding[],
  existing: StoredProposal[],
): { proposals: EvolutionProposal[]; deduped: number; unmapped: number } {
  const groups = new Map<string, ProposalGroup>();
  let unmapped = 0;
  for (const f of findings) {
    const mapped = mapFinding(f);
    if (mapped === 'stop') {
      unmapped += 1;
      continue;
    }
    const key = `${mapped.operator}\u0000${mapped.surface}\u0000${mapped.primarySignal}`;
    let group = groups.get(key);
    if (!group) {
      group = { operator: mapped.operator, surface: mapped.surface, primarySignal: mapped.primarySignal, kinds: new Set(), sessions: new Set(), count: 0 };
      groups.set(key, group);
    }
    group.kinds.add(f.kind);
    for (const s of f.sessions) group.sessions.add(s);
    group.count += f.count;
  }

  // Effective-status dedupe (event-sourced): a fingerprint blocks iff the
  // effective status of its id is not exactly 'withdrawn'; the fingerprint
  // is taken from the latest record of that id that has one. Unknown
  // effective statuses block (fail-closed: under-propose rather than spam).
  const effective = effectiveStatusById(existing);
  const fingerprintById = new Map<string, string>();
  for (const r of existing) {
    if (typeof r.id === 'string' && typeof r.fingerprint === 'string') fingerprintById.set(r.id, r.fingerprint);
  }
  const blocked = new Set<string>();
  for (const [id, eff] of effective) {
    if (eff.status !== 'withdrawn') {
      const fp = fingerprintById.get(id);
      if (fp !== undefined) blocked.add(fp);
    }
  }

  const proposals: EvolutionProposal[] = [];
  let deduped = 0;
  for (const g of [...groups.values()].sort(compareGroups)) {
    const fingerprint = `${g.operator}|${g.surface}|${g.primarySignal}`;
    if (blocked.has(fingerprint)) {
      deduped += 1;
      continue;
    }
    const kinds = [...g.kinds].sort();
    const sessions = [...g.sessions].sort();
    proposals.push({
      id: '',
      createdAt: '',
      status: 'proposed',
      operator: g.operator,
      surface: g.surface,
      fingerprint,
      evidence: { kinds, count: g.count, sessions },
      rationale: `${g.operator} on ${g.surface}: evidence ${kinds.join('+')} count ${g.count} across ${sessions.length} session(s)`,
      patchHint: patchHintFor(g.operator, kinds.join('+'), g.count, sessions.length),
      requiredValidation: requiredValidationFor(g.surface),
    });
  }
  return { proposals, deduped, unmapped };
}

const PROPOSAL_ID_PATTERN = /^p-(\d+)$/;

/** 'p-' + 4-digit zero-pad, max existing numeric suffix + 1; empty store → 'p-0001'. */
export function nextProposalId(records: StoredProposal[]): string {
  let max = 0;
  for (const r of records) {
    const m = PROPOSAL_ID_PATTERN.exec(typeof r.id === 'string' ? r.id : '');
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `p-${String(max + 1).padStart(4, '0')}`;
}

/**
 * Tolerant store reader: invalid JSON / non-object / missing id → counted
 * in `malformed` and skipped, never thrown. Blank lines carry no record and
 * are ignored silently (trailing-newline artifact of the append-only file).
 */
export function parseProposalStore(lines: string[]): { records: StoredProposal[]; malformed: number } {
  const records: StoredProposal[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (typeof line !== 'string' || line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformed += 1;
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id === '') {
      malformed += 1;
      continue;
    }
    records.push(rec as unknown as StoredProposal);
  }
  return { records, malformed };
}

export interface AppendProposalsOpts {
  /** Dry run: ids/createdAt are assigned in memory but NO fs write happens at all. */
  dryRun?: boolean;
  /** Injected clock (default `() => new Date().toISOString()`) — pure tests pass a fixed one. */
  now?: () => string;
}

/**
 * The append layer — the one impure function of the engine. Assigns
 * `id` (continuing the store's monotonic sequence) and `createdAt` (from the
 * injected clock) onto the passed proposal objects IN PLACE, so the caller
 * can print the persisted ids without re-reading, then appends one JSON line
 * per proposal (mkdir -p for the parent dir). Returns { written, path };
 * `written` is 0 for a dry run or an empty batch.
 */
export function appendProposals(
  storePath: string,
  proposals: EvolutionProposal[],
  opts: AppendProposalsOpts = {},
): { written: number; path: string } {
  const now = opts.now ?? ((): string => new Date().toISOString());
  let nextNum = 1;
  if (existsSync(storePath)) {
    try {
      const raw = readFileSync(storePath, 'utf-8');
      const { records } = parseProposalStore(raw.split(/\r?\n/));
      nextNum = Number.parseInt(nextProposalId(records).slice('p-'.length), 10);
    } catch {
      nextNum = 1; // unreadable store → start fresh; advisory append, never a crash
    }
  }
  for (const p of proposals) {
    p.id = `p-${String(nextNum).padStart(4, '0')}`;
    nextNum += 1;
    p.createdAt = now();
  }
  if (opts.dryRun === true || proposals.length === 0) {
    return { written: 0, path: storePath };
  }
  mkdirSync(path.dirname(storePath), { recursive: true });
  appendFileSync(storePath, `${proposals.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf-8');
  return { written: proposals.length, path: storePath };
}
