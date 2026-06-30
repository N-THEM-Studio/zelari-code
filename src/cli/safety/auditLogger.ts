/**
 * auditLogger — append-only JSONL log of every tool invocation.
 *
 * Task A2 of AnathemaCoder v3-A. Persists to
 * `~/.tmp/anathema-coder/audit.jsonl` by default (override via
 * ANATHEMA_AUDIT_LOG env). Each entry is one line of JSON with:
 *   ts, sessionId, tool, args (summary), ok, resultSummary, durationMs, error?
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3.md (Task A2)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface AuditEntry {
  /** ISO timestamp. */
  ts: string;
  /** Session that originated the call (CLI session id). */
  sessionId: string;
  /** Tool name (e.g. 'read_file', 'bash'). */
  tool: string;
  /** Args passed (truncated to keep entries small). */
  args: Record<string, unknown>;
  /** Whether the tool succeeded. */
  ok: boolean;
  /** Result summary (first ~120 chars or error message). */
  resultSummary: string;
  /** Wall-clock duration of the invocation in ms. */
  durationMs: number;
  /** Present only when ok=false. */
  error?: string;
}

export class AuditLogger {
  private readonly logPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(logPath?: string) {
    this.logPath = logPath ?? defaultAuditPath();
  }

  /** Path to the JSONL file. */
  get path(): string {
    return this.logPath;
  }

  /**
   * Append one entry to the log. Serialized through a queue so concurrent
   * invocations do not interleave their writes.
   */
  async append(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      await fs.appendFile(this.logPath, line, 'utf-8');
    });
    return this.writeQueue;
  }

  /**
   * Run a tool invocation and write an audit entry capturing the result.
   * Returns the tool result unchanged so callers can compose it as
   * `const r = await audit.runTool({ tool: 'bash', args: {...}, sessionId, fn })`.
   */
  async runTool<T>(params: {
    tool: string;
    args: Record<string, unknown>;
    sessionId: string;
    fn: () => Promise<T>;
    /** Map the tool return value to a string summary for the log. */
    summarize?: (result: T) => string;
    /** Map an error to a string summary. */
    summarizeError?: (err: unknown) => string;
  }): Promise<T> {
    const start = Date.now();
    let ok = true;
    let error: string | undefined;
    let resultSummary = '';
    try {
      const result = await params.fn();
      resultSummary = (params.summarize?.(result) ?? safeStringify(result)).slice(0, 200);
      return result;
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
      resultSummary = (params.summarizeError?.(err) ?? error).slice(0, 200);
      throw err;
    } finally {
      const entry: AuditEntry = {
        ts: new Date(start).toISOString(),
        sessionId: params.sessionId,
        tool: params.tool,
        args: redactArgs(params.args),
        ok,
        resultSummary,
        durationMs: Date.now() - start,
        ...(error !== undefined ? { error } : {}),
      };
      // Fire-and-forget: do not block the caller on disk I/O, but still
      // serialize writes through the queue.
      void this.append(entry).catch((err) => {
        // Best-effort logging — never throw from inside the finally.
        console.error('[auditLogger] failed to append entry:', err);
      });
    }
  }
}

function defaultAuditPath(): string {
  const override = process.env.ANATHEMA_AUDIT_LOG;
  if (override && override.trim().length > 0) return override;
  return path.join(os.tmpdir(), 'anathema-coder', 'audit.jsonl');
}

/**
 * Redact sensitive args (anything that looks like an API key or secret)
 * before writing to the audit log. Conservative: replaces long random
 * strings and env-var-style 'key' / 'apiKey' fields.
 */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (/(api[_-]?key|secret|token|password)/i.test(k) && typeof v === 'string') {
      redacted[k] = '***';
    } else if (typeof v === 'string' && v.length > 64) {
      redacted[k] = v.slice(0, 60) + '…';
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}