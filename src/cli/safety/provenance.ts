/**
 * Context provenance fingerprints (W3.1 / t46).
 *
 * Deterministic, zero-LLM provenance tracking at the tool choke-point:
 * results of NON-mutating tools (reads, network fetches, MCP calls) are
 * normalized into a bounded ring buffer; when a write/execute tool later
 * receives arguments that EMBED one of those fingerprints, the permission
 * wrapper escalates `allow` → `ask` (see toolRegistry.ts). This is the
 * deterministic half of the THREAT_MODEL vector "non-user content steering
 * tool calls": an instruction injected via a web page / MCP output / file
 * can no longer sail through on category defaults.
 *
 * Scope of escalation (tested):
 *   - `web` / `mcp` content embedded in write OR execute args → escalate;
 *   - `file` content embedded in EXECUTE args → escalate (file → write is
 *     legitimate refactoring — edits legitimately re-embed file content —
 *     so only the execute path escalates for files);
 *   - everything else: no opinion.
 *
 * Fail-open by design (a fingerprinting bug must never break a tool call),
 * bounded memory (ring of MAX_ENTRIES excerpts), `ZELARI_PROVENANCE=0`
 * disables both recording and matching.
 */
export type ProvenanceSource = 'user' | 'file' | 'tool' | 'web' | 'mcp';

export interface ProvenanceHit {
  source: ProvenanceSource;
  /** Tool whose result was fingerprinted. */
  tool: string;
  /** First matching fragment (normalized, for logs/tests only). */
  snippet: string;
}

const MAX_ENTRIES = 40;
const MAX_EXCERPT = 8192;
/** Minimum contiguous normalized chars for a match. */
export const PROVENANCE_MIN_MATCH = 48;
const SHINGLE_STEP = 24;
/** Shingle budget per entry (head region) — keeps matching cheap. */
const MAX_SHINGLES = 32;

interface Entry {
  source: ProvenanceSource;
  tool: string;
  excerpt: string;
  at: number;
}

const ring: Entry[] = [];

export function provenanceEnabled(): boolean {
  return process.env.ZELARI_PROVENANCE !== '0';
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Record non-user content for later provenance matching. Never throws. */
export function recordNonUserContent(
  source: ProvenanceSource,
  text: unknown,
  tool: string,
): void {
  try {
    if (!provenanceEnabled() || source === 'user') return;
    const raw = typeof text === 'string' ? text : safeJson(text);
    const excerpt = normalize(raw).slice(0, MAX_EXCERPT);
    if (excerpt.length < PROVENANCE_MIN_MATCH * 2) return; // too small to be distinctive
    ring.push({ source, tool, excerpt, at: Date.now() });
    if (ring.length > MAX_ENTRIES) ring.splice(0, ring.length - MAX_ENTRIES);
  } catch {
    /* fail-open by design */
  }
}

/**
 * Observe a tool result from inside the permission wrapper: mutating tools
 * (write/execute categories) are never recorded — only the channels an
 * attacker can control (web fetch, MCP output, file reads) become
 * fingerprints. Maps tool → provenance source deterministically.
 */
export function recordResultForProvenance(
  toolName: string,
  required: readonly string[],
  result: unknown,
): void {
  try {
    if (!provenanceEnabled()) return;
    if (required.includes('write') || required.includes('execute')) return;
    const source: ProvenanceSource = toolName.startsWith('mcp_')
      ? 'mcp'
      : required.includes('network')
        ? 'web'
        : 'file';
    recordNonUserContent(source, result, toolName);
  } catch {
    /* fail-open by design */
  }
}

function shingles(excerpt: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + PROVENANCE_MIN_MATCH <= excerpt.length && out.length < MAX_SHINGLES; i += SHINGLE_STEP) {
    out.push(excerpt.slice(i, i + PROVENANCE_MIN_MATCH));
  }
  return out;
}

/**
 * Deterministic containment check: does `text` embed a sizable chunk of any
 * recorded non-user content? Newest entries win. Full-excerpt containment is
 * checked first (the common copy-paste case), then head shingles for partial
 * embedding. Null when nothing matches.
 */
export function provenanceMatchIn(text: unknown): ProvenanceHit | null {
  try {
    if (!provenanceEnabled()) return null;
    const raw = typeof text === 'string' ? text : safeJson(text);
    const hay = normalize(raw ?? '');
    if (!hay) return null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const e = ring[i];
      if (e.excerpt.length <= hay.length && hay.includes(e.excerpt)) {
        return { source: e.source, tool: e.tool, snippet: e.excerpt.slice(0, 80) };
      }
      for (const sh of shingles(e.excerpt)) {
        if (hay.includes(sh)) {
          return { source: e.source, tool: e.tool, snippet: sh };
        }
      }
    }
    return null;
  } catch {
    return null; // fail-open: a matcher bug must never block a tool
  }
}

/**
 * Escalation rule: which provenance sources escalate which tool categories.
 * web/mcp → write+execute; file → execute only (file→write is normal
 * refactoring: `edit` legitimately re-embeds file content).
 */
export function provenanceAppliesTo(
  source: ProvenanceSource,
  categories: readonly string[],
): boolean {
  if (source === 'web' || source === 'mcp') {
    return categories.includes('write') || categories.includes('execute');
  }
  if (source === 'file') return categories.includes('execute');
  return false;
}

export function clearProvenanceRing(): void {
  ring.length = 0;
}

export function provenanceRingSize(): number {
  return ring.length;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
