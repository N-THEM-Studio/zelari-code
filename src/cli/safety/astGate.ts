/**
 * astGate — ADR-0033 (t76): post-write AST gate with AUTO-REVERT on the
 * write path (`write_file` / `edit`).
 *
 * Flow: BEFORE a write to a TS/JS file, snapshot the pre-content; after an
 * ok result, re-read and syntax-check the file. A syntax error REVERTS the
 * write (pre-content restored; a file that did not exist is unlinked) and
 * the tool result becomes a LOUD structured error (`ast_gate_reverted` +
 * WriteReject `parse_error`) — the model must SEE that the write was
 * cancelled and why. Never silence, never fake pass.
 *
 * Inert (result passes through untouched) for: non write-path tools, kill
 * switch `ZELARI_AST_GATE=0`, outside-root paths, post-write re-read failures
 * (file removed), and any gate infrastructure error (try/catch → passthrough).
 * A SUCCESSFUL write to a non-TS/JS extension (or with TypeScript unavailable)
 * is a LOUD SKIP: a stderr warning is emitted, the write is KEPT, nothing is
 * reverted (t76: "skip LOUD esplicito — mai silenzio, mai finto pass").
 * Infrastructure gaps never block a write.
 *
 * Deviation from the letter of the spec (kept, documented): the syntax check
 * reads `sourceFile.parseDiagnostics` via a lazy `import('typescript')` —
 * `parseFileSymbolsDiag` only reports `parse-error` when `createSourceFile`
 * THROWS, which the TS parser essentially never does for syntax errors (they
 * land in parseDiagnostics and parsing continues). Relying on that status
 * alone would make the gate a silent no-op for exactly the case it exists
 * for; `isAstSupported` from the same engine is reused for extension gating.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  typedErr,
  type ToolDefinition,
  type ToolContext,
  type TypedResult,
} from '@zelari/core/harness/tools/toolTypes';
import { snapshotIdOf } from '@zelari/core/harness/tools/builtin/filesystem';
import { isAstSupported } from '../ast/engine.js';

/** Write-path tools the gate wraps (ADR-0033 t76). */
const AST_GATE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit']);

export interface AstGateOptions {
  /** Workspace root — `args.path` arrives sandbox-resolved (absolute) upstream. */
  root: string;
}

/** Kill switch: default ON; `ZELARI_AST_GATE=0` disables the gate. */
export function astGateEnabled(): boolean {
  return process.env.ZELARI_AST_GATE !== '0';
}

// Lazy, memoized TypeScript load (same pattern as ast/engine.ts). Null when
// unavailable → gate inert, never blocking.
let tsPromise: Promise<typeof import('typescript') | null> | undefined;
function loadTs(): Promise<typeof import('typescript') | null> {
  if (!tsPromise) {
    tsPromise = import('typescript')
      .then((m) => (m.default ?? m) as typeof import('typescript'))
      .catch(() => null);
  }
  return tsPromise;
}

interface SyntaxDiag {
  message: string;
  line: number;
  character: number;
}

/** First TS parse diagnostic with 1-based line/col. Null when the file parses clean. */
export function firstSyntaxError(
  ts: typeof import('typescript'),
  fileName: string,
  content: string,
): SyntaxDiag | null {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const diags = (
    source as unknown as { parseDiagnostics?: readonly import('typescript').Diagnostic[] }
  ).parseDiagnostics;
  const first = diags?.[0];
  if (!first) return null;
  const { line, character } = source.getLineAndCharacterOfPosition(first.start ?? 0);
  const flattened =
    typeof ts.flattenDiagnosticMessageText === 'function'
      ? ts.flattenDiagnosticMessageText(first.messageText, ' ')
      : String(first.messageText);
  const code = typeof first.code === 'number' ? `TS${first.code}: ` : '';
  return { message: `${code}${flattened}`, line: line + 1, character: character + 1 };
}

/**
 * Short unified diff of the REJECTED write (ADR-0033 WriteReject.minimalDiff:
 * "unified corto, solo il conflitto") — the offending line vs the revert.
 */
function minimalDiffOf(pathLabel: string, brokenContent: string, line: number): string {
  const brokenLine = (brokenContent.split(/\r?\n/)[line - 1] ?? '').slice(0, 160);
  return [
    `--- a/${pathLabel}`,
    `+++ b/${pathLabel}`,
    `@@ -${line},1 +${line},1 @@`,
    `- ${brokenLine}`,
    '+ (write REVERTED — pre-write content restored)',
  ].join('\n');
}

/**
 * Wrap a tool definition with the post-write AST gate. Non write-path tools
 * pass through unchanged (same object).
 */
export function wrapWithAstGate<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  opts: AstGateOptions,
): ToolDefinition<I, O> {
  if (!AST_GATE_TOOLS.has(original.name)) return original;

  // In-root absolute path this call writes to (null = no path arg / outside
  // root — the sandbox's territory, never ours). Extension support is NOT
  // folded in here: the gate must distinguish "not gated at all" from
  // "successful write that cannot be syntax-checked" (LOUD skip, below).
  const containedPathOf = (args: I): string | null => {
    const raw = (args as Record<string, unknown>)['path'];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // The sandbox wrap rewrote args.path to an absolute contained path;
    // belt-and-braces: outside-root paths are NOT gated (never block on
    // infrastructure weirdness — the sandbox already denied them).
    const absPath = path.isAbsolute(raw) ? raw : path.join(opts.root, raw);
    const rel = path.relative(opts.root, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return absPath;
  };

  return {
    ...original,
    execute: async (args: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      // Pre-flight: decide gating + snapshot the pre-write content.
      // preContent: string = existing bytes to restore; null = file absent
      // (revert = unlink); undefined = not snapshot-gated this call.
      let preContent: string | null | undefined;
      let gateTarget: string | null = null;
      try {
        if (astGateEnabled()) gateTarget = containedPathOf(args);
        if (gateTarget !== null && isAstSupported(gateTarget)) {
          try {
            preContent = await fs.readFile(gateTarget, 'utf8');
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') preContent = null;
            // other read failures → preContent stays undefined (inert)
          }
        }
      } catch {
        gateTarget = null;
        preContent = undefined;
      }

      const result = await original.execute(args, ctx);
      if (!result.ok) return result;
      // t76 LOUD SKIP: a SUCCESSFUL write the gate cannot syntax-check is
      // announced on stderr — write KEPT, nothing reverted, no silent pass.
      if (gateTarget !== null && !isAstSupported(gateTarget)) {
        process.stderr.write(
          `[ast_gate] LOUD SKIP (unsupported-extension): ${original.name} ${gateTarget} — ` +
            `${path.extname(gateTarget) || '(no extension)'} is outside the AST surface; ` +
            'write KEPT, NOT syntax-gated.\n',
        );
        return result;
      }
      if (preContent === undefined) return result; // gate off / outside root / pre-read failed
      try {
        const absPath = gateTarget as string;
        const ts = await loadTs();
        if (!ts) {
          process.stderr.write(
            `[ast_gate] LOUD SKIP (typescript-unavailable): ${original.name} ${absPath} — ` +
              'TypeScript is not loadable in this runtime; write KEPT, NOT syntax-gated.\n',
          );
          return result;
        }
        const post = await fs.readFile(absPath, 'utf8'); // ENOENT here → catch → inert
        const syntaxError = firstSyntaxError(ts, path.basename(absPath), post);
        if (!syntaxError) return result;

        // AUTO-REVERT: restore the exact pre-write bytes (or remove a file
        // the write created). Revert failure still fails LOUD below.
        const parseError = `${syntaxError.message} (line ${syntaxError.line}, col ${syntaxError.character})`;
        let revertedTo: string;
        if (preContent === null) {
          await fs.unlink(absPath).catch(() => undefined);
          revertedTo = 'absent';
        } else {
          await fs.writeFile(absPath, preContent, 'utf8');
          revertedTo = snapshotIdOf(preContent);
        }
        const relLabel = path.relative(opts.root, absPath) || path.basename(absPath);
        return typedErr(
          `[ast_gate_reverted] ${original.name}: ${absPath} written but the file no longer parses — ` +
            `write REVERTED (revertedTo=${revertedTo}). ${parseError}. ` +
            'Fix the syntax and re-apply (read_file first for a fresh snapshotId).',
          {
            status: 'failed',
            warnings: ['AST_GATE_REVERTED'],
            // WriteReject (ADR-0033 schema): conforming payload — the parse
            // detail lives in the error string + minimalDiff/span.
            reject: {
              ok: false as const,
              status: 'parse_error' as const,
              path: absPath,
              minimalDiff: minimalDiffOf(relLabel, post, syntaxError.line),
              next: { action: 're-read' as const, path: absPath },
              span: { startLine: syntaxError.line, endLine: syntaxError.line },
            },
          },
        );
      } catch {
        // Gate infrastructure failure must never break the turn: passthrough.
        return result;
      }
    },
  };
}
