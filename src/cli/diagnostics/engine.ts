/**
 * diagnostics/engine — fast, file-scoped compiler/linter diagnostics.
 *
 * The "diagnostics loop": after the agent edits a file, we run a FAST,
 * file-scoped checker on just that file and feed the errors/warnings back
 * into the same turn (see `wrapWithDiagnostics` in toolRegistry.ts). This
 * turns blind string edits into compiler-verified edits — the single biggest
 * quality lever for a coding agent.
 *
 * Why not `tsc`? A full `tsc --noEmit` needs whole-project context and takes
 * seconds — far too slow to run after every edit. The per-edit loop uses
 * checkers that are genuinely fast and file-scoped:
 *   - ESLint (js/ts/jsx/tsx/mjs/cjs) — `eslint --format json <file>`
 *   - Ruff   (py)                     — `ruff check --output-format json <file>`
 * Project-wide `tsc` stays available on demand via the `/check` command.
 *
 * Everything here is best-effort and NEVER throws: a missing binary, a
 * timeout, or unparseable output all yield `[]` (no diagnostics) so a
 * broken/absent linter can never break the edit itself. The spawn is
 * injectable (`runner`) so the parsers + selection logic are unit-testable
 * without any linter installed.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { relativePosix } from '../utils/paths.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  /** File the diagnostic refers to (absolute or as reported by the tool). */
  file: string;
  /** 1-based line number (0 when the tool did not report one). */
  line: number;
  /** 1-based column (undefined when not reported). */
  column?: number;
  severity: DiagnosticSeverity;
  /** Human-readable message. */
  message: string;
  /** Rule id / error code (e.g. 'no-unused-vars', 'F401', 'E999'). */
  code?: string;
  /** Which checker produced this (e.g. 'eslint', 'ruff'). */
  source: string;
}

/** Result of a spawned checker process. */
export interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable process runner (defaults to a real child_process spawn). */
export type Runner = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<RunnerResult>;

export interface DiagnosticProvider {
  /** Checker name (also used as `Diagnostic.source`). */
  name: string;
  /** Binary to spawn (resolved on PATH). */
  bin: string;
  /** Lower-cased file extensions (with dot) this provider handles. */
  extensions: readonly string[];
  /** Build the argv for checking a single file. */
  args: (file: string) => string[];
  /** Parse the checker's stdout into diagnostics. Must never throw. */
  parse: (stdout: string, file: string) => Diagnostic[];
}

// ---------------------------------------------------------------------------
// Parsers (pure — the well-tested core)
// ---------------------------------------------------------------------------

/** Parse `eslint --format json` output (array of file result objects). */
export function parseEslintJson(stdout: string, _file: string): Diagnostic[] {
  const json = safeJson(stdout);
  if (!Array.isArray(json)) return [];
  const out: Diagnostic[] = [];
  for (const fileResult of json) {
    if (!fileResult || typeof fileResult !== 'object') continue;
    const fr = fileResult as {
      filePath?: unknown;
      messages?: unknown;
    };
    const filePath = typeof fr.filePath === 'string' ? fr.filePath : _file;
    if (!Array.isArray(fr.messages)) continue;
    for (const m of fr.messages) {
      if (!m || typeof m !== 'object') continue;
      const msg = m as {
        ruleId?: unknown;
        severity?: unknown;
        message?: unknown;
        line?: unknown;
        column?: unknown;
      };
      out.push({
        file: filePath,
        line: typeof msg.line === 'number' ? msg.line : 0,
        ...(typeof msg.column === 'number' ? { column: msg.column } : {}),
        // ESLint severity: 2 = error, 1 = warning.
        severity: msg.severity === 2 ? 'error' : 'warning',
        message: typeof msg.message === 'string' ? msg.message : '(no message)',
        ...(typeof msg.ruleId === 'string' && msg.ruleId ? { code: msg.ruleId } : {}),
        source: 'eslint',
      });
    }
  }
  return out;
}

/** Parse `ruff check --output-format json` output (array of issue objects). */
export function parseRuffJson(stdout: string, _file: string): Diagnostic[] {
  const json = safeJson(stdout);
  if (!Array.isArray(json)) return [];
  const out: Diagnostic[] = [];
  for (const issue of json) {
    if (!issue || typeof issue !== 'object') continue;
    const it = issue as {
      filename?: unknown;
      code?: unknown;
      message?: unknown;
      location?: { row?: unknown; column?: unknown };
    };
    const code = typeof it.code === 'string' ? it.code : undefined;
    out.push({
      file: typeof it.filename === 'string' ? it.filename : _file,
      line: typeof it.location?.row === 'number' ? it.location.row : 0,
      ...(typeof it.location?.column === 'number' ? { column: it.location.column } : {}),
      // Ruff has no severity field; E999 is a syntax error, everything else
      // is a lint warning.
      severity: code === 'E999' ? 'error' : 'warning',
      message: typeof it.message === 'string' ? it.message : '(no message)',
      ...(code ? { code } : {}),
      source: 'ruff',
    });
  }
  return out;
}

function safeJson(s: string): unknown {
  const trimmed = s.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDERS: readonly DiagnosticProvider[] = [
  {
    name: 'eslint',
    bin: 'eslint',
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
    args: (file) => ['--format', 'json', file],
    parse: parseEslintJson,
  },
  {
    name: 'ruff',
    bin: 'ruff',
    extensions: ['.py'],
    args: (file) => ['check', '--output-format', 'json', file],
    parse: parseRuffJson,
  },
];

/** Pick the provider that handles a file's extension, or null. */
export function providerForFile(
  file: string,
  providers: readonly DiagnosticProvider[] = DEFAULT_PROVIDERS,
): DiagnosticProvider | null {
  const ext = path.extname(file).toLowerCase();
  return providers.find((p) => p.extensions.includes(ext)) ?? null;
}

/**
 * Resolve a checker binary to the project-local `node_modules/.bin/<bin>`
 * when it exists (the common case — eslint/ruff are project deps, not on the
 * global PATH), falling back to the bare name for PATH resolution. Walks up
 * from `cwd` so it works from subdirectories of a workspace too.
 */
export function resolveBin(bin: string, cwd: string): string {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  let dir = cwd;
  for (let i = 0; i < 6; i += 1) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, 'node_modules', '.bin', `${bin}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return bin;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunnerResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // shell:true on win32 so `.cmd` shims (eslint.cmd) resolve; POSIX runs
      // the binary directly.
      child =
        process.platform === 'win32'
          ? spawn(`${cmd} ${args.join(' ')}`, { cwd: opts.cwd, shell: true })
          : spawn(cmd, args as string[], { cwd: opts.cwd });
    } catch {
      // Binary genuinely not launchable — treat as "no diagnostics".
      done({ code: null, stdout: '', stderr: '' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({ code: null, stdout, stderr });
    }, opts.timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      done({ code: null, stdout: '', stderr: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });

export interface RunDiagnosticsOptions {
  cwd?: string;
  timeoutMs?: number;
  runner?: Runner;
  providers?: readonly DiagnosticProvider[];
}

/**
 * Run the appropriate fast checker on a single file and return its
 * diagnostics. Best-effort: returns `[]` for unsupported file types, a
 * missing binary, a timeout, or unparseable output. Never throws.
 */
export async function runDiagnosticsForFile(
  file: string,
  options: RunDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
  const provider = providerForFile(file, options.providers);
  if (!provider) return [];
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 5000;
  const runner = options.runner ?? defaultRunner;
  try {
    // Prefer the project-local binary (node_modules/.bin) over PATH — only
    // matters for the real runner; injected test runners ignore the bin.
    const bin = options.runner ? provider.bin : resolveBin(provider.bin, cwd);
    const result = await runner(bin, provider.args(file), { cwd, timeoutMs });
    // A missing binary surfaces as code=null with empty stdout — nothing to
    // parse, so this naturally yields [].
    return provider.parse(result.stdout, file);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Render diagnostics as a compact block for injection into a tool result.
 * Errors first, then warnings; capped at `maxLines` with an overflow note.
 * Returns '' when there are no diagnostics (caller should inject nothing).
 */
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  opts: { maxLines?: number; relativeTo?: string } = {},
): string {
  if (diagnostics.length === 0) return '';
  const maxLines = opts.maxLines ?? 20;
  const rank: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...diagnostics].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line,
  );
  const errors = sorted.filter((d) => d.severity === 'error').length;
  const warnings = sorted.filter((d) => d.severity === 'warning').length;
  const header =
    `⚠ ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}` +
    ` (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'})` +
    ` — fix before continuing:`;
  const shown = sorted.slice(0, maxLines).map((d) => {
    const loc = opts.relativeTo ? relativePosix(opts.relativeTo, d.file) : d.file;
    const pos = d.column ? `${d.line}:${d.column}` : `${d.line}`;
    const tag = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warn' : 'info';
    const code = d.code ? ` [${d.code}]` : '';
    return `  ${loc}:${pos} ${tag}${code}: ${d.message} (${d.source})`;
  });
  const overflow =
    sorted.length > maxLines ? [`  … and ${sorted.length - maxLines} more`] : [];
  return [header, ...shown, ...overflow].join('\n');
}
