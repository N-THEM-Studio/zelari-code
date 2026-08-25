/**
 * FailureSignatureGuard — detect the same test/build failure recurring after
 * multiple attempts (Frontier upgrade, PHASE 1B).
 *
 * The agent may edit different files yet `npm test` keeps failing with the
 * same error. Fingerprinting the *command* alone is not enough; this guard
 * hashes the command together with a normalized tail of the failure output so
 * that volatile noise (timestamps, durations, PIDs, UUIDs, temp paths,
 * progress lines) does not mask an identical failure.
 *
 * Reaction: inject a root-cause reassessment message at `warnAfter` identical
 * failure signatures, stop the run at `stopAfter`. A later *successful* run of
 * the same command clears its counters.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../../core/requestSnapshot.js';
import { CONTINUE } from '../observers/types.js';
import type {
  AgentObserver,
  ObserverResult,
  ToolCallEvent,
  ToolResultEvent,
} from '../observers/types.js';
import { toolCallFingerprint } from './RepetitionGuard.js';

export interface FailureSignature {
  commandHash: string;
  exitCode?: number;
  normalizedTailHash: string;
}

export interface FailureSignatureGuardConfig {
  /** Inject a reassessment message at this many identical failures (default 2). */
  warnAfter?: number;
  /** Stop the run at this many identical failures (default 5). */
  stopAfter?: number;
  /** How many chars of normalized output tail feed the hash (default 2000). */
  tailChars?: number;
}

/** Shell-like result shape produced by the builtin shell tool. */
interface ShellResultLike {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  output?: string;
  content?: string;
  message?: string;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Normalize a failure-output tail: replace volatile tokens with stable
 * placeholders and drop pure progress lines, so identical root failures map
 * to identical text.
 */
export function normalizeFailureTail(text: string, tailChars = 2000): string {
  const tail = stripAnsi(text).slice(-tailChars);
  const lines = tail.split(/\r?\n/).map((line) =>
    line
      // ISO timestamps and wall-clock times
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
      .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, '<time>')
      // durations
      .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|secs|seconds|min|mins|minutes)\b/gi, '<dur>')
      // UUIDs
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      // PIDs
      .replace(/\b(?:pid|process)\s*[:=]?\s*\d+\b/gi, '<pid>')
      // temp paths (posix + windows)
      .replace(/(?:\/tmp\/|\/var\/tmp\/|\b[A-Za-z]:\\Users\\[^\\]*\\AppData\\Local\\Temp\\)[^\s"']*/gi, '<tmp>'),
  );
  const meaningful = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // success/progress glyphs (✓ ✔ ● ○ ◐ ◑ ◌) mark progress lines — drop;
    // failure glyphs (✗ ✘ ×) are kept: they carry failure information.
    if (/^\s*[✓✔●○◐◑◌]/.test(line)) return false;
    // pure spinner / counter lines
    if (/^\s*[|/\\-–—]\s*$/.test(line)) return false;
    if (/^\s*\d+\s*\/\s*\d+\s*$/.test(line)) return false;
    return true;
  });
  return meaningful.join('\n');
}

/** Extract { exitCode, text } from an unknown tool result, if shape known. */
function extractFailure(result: unknown): { exitCode?: number; text: string } | undefined {
  if (typeof result === 'string') return { text: result };
  if (result && typeof result === 'object') {
    const r = result as ShellResultLike;
    const parts = [r.stdout, r.stderr, r.output, r.content, r.message]
      .filter((p): p is string => typeof p === 'string');
    if (typeof r.exitCode === 'number' || parts.length > 0) {
      return { exitCode: r.exitCode, text: parts.join('\n') };
    }
    return { text: stableStringify(result).slice(0, 4000) };
  }
  return undefined;
}

const REASSESS_MESSAGE = [
  'The same failure signature has persisted across multiple attempts.',
  'Do not repeat the previous edit strategy. Re-evaluate the root cause,',
  'inspect upstream state, or delegate a fresh verification/exploration task.',
].join('\n');

/** Cap on remembered pending tool-call args (FIFO beyond this). */
const MAX_PENDING = 256;

export class FailureSignatureGuard implements AgentObserver {
  private readonly counts = new Map<string, number>();
  private readonly pendingArgs = new Map<string, string>();
  private readonly warnAfter: number;
  private readonly stopAfter: number;
  private readonly tailChars: number;

  constructor(config: FailureSignatureGuardConfig = {}) {
    this.warnAfter = config.warnAfter ?? 2;
    this.stopAfter = config.stopAfter ?? 5;
    this.tailChars = config.tailChars ?? 2000;
  }

  /** Track per-call command hashes so onToolResult can bind args → result. */
  async onToolCall(event: ToolCallEvent): Promise<ObserverResult> {
    const { argsHash } = toolCallFingerprint(event.toolName, event.args);
    if (this.pendingArgs.size >= MAX_PENDING) {
      const oldest = this.pendingArgs.keys().next().value;
      if (oldest !== undefined) this.pendingArgs.delete(oldest);
    }
    this.pendingArgs.set(event.toolCallId, `${event.toolName}\u0000${argsHash}`);
    return CONTINUE;
  }

  async onToolResult(event: ToolResultEvent): Promise<ObserverResult> {
    const commandHash = this.pendingArgs.get(event.toolCallId) ?? event.toolName;
    this.pendingArgs.delete(event.toolCallId);

    const failure = extractFailure(event.result);
    if (!failure || !failure.text.trim()) return CONTINUE;

    const failed = failure.exitCode !== undefined ? failure.exitCode !== 0 : event.ok === false;
    if (!failed) {
      // The command succeeded — clear any accumulated failure counts for it.
      for (const key of this.counts.keys()) {
        if (key.startsWith(`${commandHash}\u0000`)) this.counts.delete(key);
      }
      return CONTINUE;
    }

    const tailHash = createHash('sha256')
      .update(normalizeFailureTail(failure.text, this.tailChars))
      .digest('hex');
    const key = `${commandHash}\u0000${failure.exitCode ?? 'x'}\u0000${tailHash}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);

    if (count >= this.stopAfter) {
      return {
        action: 'stop',
        reason: `same failure signature (exit ${failure.exitCode ?? 'n/a'}) recurred ${count} times after edits`,
        code: 'repeated_failure',
      };
    }
    if (count >= this.warnAfter) {
      return {
        action: 'inject',
        message: { role: 'user', kind: 'runtime-warning', content: REASSESS_MESSAGE },
      };
    }
    return CONTINUE;
  }

  reset(): void {
    this.counts.clear();
    this.pendingArgs.clear();
  }
}
