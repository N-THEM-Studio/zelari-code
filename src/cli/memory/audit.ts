/**
 * src/cli/memory/audit.ts — confidence decay + contradiction detection (W4.2).
 *
 * P1 applied to memory: these are READ-ONLY analytics over immutable history.
 * They never mutate, retract, or auto-promote nodes — contradictions are
 * flagged for human/council review (Minosse), decay is an effective ranking
 * signal computed on the fly. Deterministic, zero LLM, zero deps (P2/P5).
 *
 * Decay model: exponential half-life from `updatedAt` — a node nobody has
 * reconfirmed for `halfLifeDays` carries half its declared confidence. Stale
 * beliefs lose retrieval weight without being deleted (history is append-only).
 */

export interface AuditNode {
  id: string;
  kind: string;
  content: string;
  confidence: number;
  status: string;
  updatedAt: string;
}

export const DECAY_HALF_LIFE_DAYS = 30;
/** Floor: even ancient nodes keep a trace of confidence for ranking. */
export const DECAY_FLOOR = 0.05;

const MS_PER_DAY = 86_400_000;

/** Effective confidence after temporal decay (clamped to [DECAY_FLOOR, 1]). */
export function decayedConfidence(node: AuditNode, now: Date = new Date(), halfLifeDays = DECAY_HALF_LIFE_DAYS): number {
  const updated = Date.parse(node.updatedAt);
  if (!Number.isFinite(updated)) return node.confidence;
  const ageDays = Math.max(0, (now.getTime() - updated) / MS_PER_DAY);
  const decayed = node.confidence * Math.pow(0.5, ageDays / halfLifeDays);
  return Math.min(1, Math.max(DECAY_FLOOR, decayed));
}

/** Kinds whose statements can logically contradict each other. */
const CONTRADICTABLE = new Set(['fact', 'decision', 'constraint']);

const NEGATIONS = new Set(['not', 'no', 'non', 'never', "isn't", "aren't", "won't", "can't", 'dont', "don't", 'without']);

/** Lowercase alphanum tokens; punctuation is noise for subject matching. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Stable subject key: the leading tokens of a statement, negations stripped. */
function subjectKey(tokens: string[]): string {
  const meaningful = tokens.filter((t) => !NEGATIONS.has(t));
  return meaningful.slice(0, 5).join(' ');
}

function hasNegation(tokens: string[]): boolean {
  return tokens.some((t) => NEGATIONS.has(t));
}

export interface ContradictionPair {
  a: string;
  b: string;
  subject: string;
  reason: 'mirror-negation';
}

/**
 * Deterministic contradiction heuristic: two active contradictable nodes
 * sharing the same subject key where exactly one side negates the predicate
 * ("X is Y" vs "X is not Y"). O(n²) over the contradictable subset only —
 * memory sets are small (hundreds), fine without an index (P5).
 */
export function detectContradictions(nodes: AuditNode[]): ContradictionPair[] {
  const eligible = nodes.filter(
    (n) => n.status === 'active' && CONTRADICTABLE.has(n.kind) && n.content.trim().length > 0,
  );
  const parsed = eligible.map((n) => ({ node: n, tokens: tokenize(n.content) }));
  const pairs: ContradictionPair[] = [];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const left = parsed[i];
      const right = parsed[j];
      if (left.tokens.length === 0 || right.tokens.length === 0) continue;
      const keyL = subjectKey(left.tokens);
      const keyR = subjectKey(right.tokens);
      if (!keyL || keyL !== keyR) continue;
      const negL = hasNegation(left.tokens);
      const negR = hasNegation(right.tokens);
      if (negL !== negR) {
        pairs.push({ a: left.node.id, b: right.node.id, subject: keyL, reason: 'mirror-negation' });
      }
    }
  }
  return pairs;
}

export interface DecayReportItem {
  id: string;
  declared: number;
  effective: number;
  ageDays: number;
}

/** Nodes whose decay materially lowered their confidence, worst first. */
export function decayReport(nodes: AuditNode[], now: Date = new Date(), minDrop = 0.2): DecayReportItem[] {
  return nodes
    .filter((n) => n.status === 'active')
    .map((n) => {
      const effective = decayedConfidence(n, now);
      const updated = Date.parse(n.updatedAt);
      const ageDays = Number.isFinite(updated) ? Math.max(0, (now.getTime() - updated) / MS_PER_DAY) : 0;
      return { id: n.id, declared: n.confidence, effective, ageDays };
    })
    .filter((r) => r.declared - r.effective >= minDrop)
    .sort((x, y) => x.effective - y.effective);
}
