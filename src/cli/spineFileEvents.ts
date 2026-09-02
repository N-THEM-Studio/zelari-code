/**
 * spineFileEvents — ADR-0033 (t75): compact file-lifecycle spine events
 * derived from tool results, right AFTER the matching `tool.result` lands.
 *
 * Kinds (additive, ADR-0021 tolerant replay; never model-surface):
 *   - `file.read`     {path, snapshotId}                 ← read_file ok
 *   - `file.applied`  {path, snapshotId | created}       ← edit / write_file ok
 *   - `file.rejected` {path, status}                     ← edit WriteReject
 *
 * PURE and total: never touches disk, never throws, returns [] on any
 * payload it cannot confidently decode (ADR-0033: no event beats a wrong
 * event). The harness stringifies ok values as JSON but rejects as prose,
 * so both channels are handled defensively.
 */

export type DerivedFileEventKind = 'file.read' | 'file.applied' | 'file.rejected';

export interface DerivedFileEvent {
  kind: DerivedFileEventKind;
  data: Record<string, unknown>;
}

const FILE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'write_file', 'edit']);

/** WriteReject.status channel (ADR-0033) — deterministic `edit` prose prefix. */
const EDIT_REJECT_RE = /^edit: (stale_snapshot|hunk_mismatch|parse_error|file_exists): (.+?)(?: \(|\n|$)/;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Structured WriteReject from a TypedResult-shaped payload ({ok:false,
 * meta.reject}) or a bare WriteReject record. Never JSON-parses strings:
 * the reject channel on the spine is prose, not JSON.
 */
function extractReject(output: unknown): Record<string, unknown> | null {
  const rec = asRecord(output);
  if (!rec) return null;
  if (rec.ok !== false) return null;
  const meta = asRecord(rec.meta);
  const reject = asRecord(meta?.reject) ?? asRecord(rec.reject);
  if (reject) return reject;
  return asString(rec.status) && asString(rec.path) ? rec : null;
}

/** Decode an ok value: object passthrough or defensive JSON.parse of strings. */
function decodeValue(output: unknown): Record<string, unknown> | null {
  let rec: Record<string, unknown> | null;
  if (typeof output !== 'string') {
    rec = asRecord(output);
  } else {
    try {
      rec = asRecord(JSON.parse(output));
    } catch {
      return null;
    }
  }
  // TypedResult ok envelope → unwrap to the value payload.
  if (rec && rec.ok === true) return asRecord(rec.value);
  return rec;
}

/**
 * Derive the file-lifecycle events for one tool result. Unknown tools,
 * non-file tools and undecodable payloads yield NO events (never crash).
 */
export function deriveFileEvents(toolName: unknown, output: unknown): DerivedFileEvent[] {
  if (typeof toolName !== 'string' || !FILE_TOOLS.has(toolName)) return [];

  // Structured reject channel first (TypedResult / WriteReject objects).
  const reject = toolName === 'edit' ? extractReject(output) : null;
  if (reject) {
    const status = asString(reject.status);
    const rejectPath = asString(reject.path);
    return status && rejectPath
      ? [{ kind: 'file.rejected', data: { path: rejectPath, status } }]
      : [];
  }

  const rec = decodeValue(output);
  if (toolName === 'edit') {
    if (!rec) {
      // Prose channel: the harness emits rejects as the `error` message plus
      // a metaFooter — the `edit:` prefix is owned by the core (deterministic).
      const m = typeof output === 'string' ? EDIT_REJECT_RE.exec(output) : null;
      return m ? [{ kind: 'file.rejected', data: { path: m[2], status: m[1] } }] : [];
    }
    if (rec.applied !== true) return [];
    const p = asString(rec.path);
    const snapshotId = asString(rec.snapshotId);
    if (!p || !snapshotId) return [];
    const occurrences =
      typeof rec.occurrencesReplaced === 'number' && Number.isFinite(rec.occurrencesReplaced)
        ? rec.occurrencesReplaced
        : null;
    return [
      {
        kind: 'file.applied',
        data: { path: p, snapshotId, ...(occurrences !== null ? { occurrencesReplaced: occurrences } : {}) },
      },
    ];
  }
  if (!rec) return [];
  switch (toolName) {
    case 'read_file': {
      const p = asString(rec.path);
      const snapshotId = asString(rec.snapshotId);
      return p && snapshotId ? [{ kind: 'file.read', data: { path: p, snapshotId } }] : [];
    }
    case 'write_file': {
      // Value-shaped payloads only (path + bytesWritten): rejects/prose never match.
      const p = asString(rec.path);
      if (!p || typeof rec.bytesWritten !== 'number') return [];
      // `created` rides only when the payload exposes it (write result is
      // {path, bytesWritten} today — no invented telemetry).
      const created = typeof rec.created === 'boolean' ? rec.created : null;
      return [{ kind: 'file.applied', data: { path: p, ...(created !== null ? { created } : {}) } }];
    }
    default:
      return [];
  }
}
