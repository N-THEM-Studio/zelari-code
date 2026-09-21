/**
 * argvClassifier — deterministic, flag-aware command safety tiers (t145).
 *
 * Shared ZERO-LLM classifier for command shapes, modeled after the memory
 * triggers pattern (structure + pure functions, no model calls).
 * Consumers:
 *  - core `bash` builtin: annotates every result with the tier (observability);
 *  - CLI destructiveCommands: classifier-first, conservative regex fallback;
 *  - CLI resourceClaims: imports `tokenizeCommandString` from here (single
 *    tokenizer, no duplication).
 *
 * Contract:
 *  - PURE: same input → same output, no I/O, no env, no cwd knowledge
 *    (workspace-relative judgments are deliberately OUT — the sandbox/
 *    workspace resolver layers own "where"; this module owns "what").
 *  - BEST-EFFORT by design: no full shell parser (documented repo constraint).
 *    Segments split on `&&` `;` `|` `&` outside quotes; tokens split
 *    quote-aware. Backslash escapes are deliberately NOT interpreted
 *    (Windows paths must survive tokenization verbatim).
 *  - Conservative ordering: safe < review < destructive < blocked; the final
 *    verdict of a multi-segment line is the max severity across segments.
 */

export type ArgvTier = 'safe' | 'review' | 'destructive' | 'blocked';

export interface ArgvVerdict {
  tier: ArgvTier;
  reasons: string[];
}

const TIER_RANK: Record<ArgvTier, number> = { safe: 0, review: 1, destructive: 2, blocked: 3 };

export function maxTier(a: ArgvTier, b: ArgvTier): ArgvTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** Version/help-only flags: any `<program> --version` is a safe fast path. */
const VERSIONISH_FLAGS = new Set(['--version', '-v', '--help', '-h']);

/**
 * Quote-aware whitespace tokenizer. Semantics are IDENTICAL to the tokenizer
 * that lived in src/cli/safety/resourceClaims.ts (single/double quotes are
 * dropped, no escape handling) so the CLI swap is behavior-preserving.
 */
export function tokenizeCommandString(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur !== '') out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur !== '') out.push(cur);
  return out;
}

/**
 * Split a raw command line into segments on `&&`, `;`, `|`, `&` OUTSIDE
 * quotes. Redirections (`>`, `>>`) stay inside the segment text (matched by
 * the textual rules below). Empty segments are dropped.
 */
export function splitCommandSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Normalize a program token: basename, lowercase, strip Windows extensions. */
function normalizeProgram(program: string): string {
  const base = program.replace(/\\/g, '/').split('/').pop() ?? program;
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

/** argv split into flags vs operands (flags keep their raw text, lowercased). */
function splitArgv(args: readonly string[]): { flags: string[]; operands: string[] } {
  const flags: string[] = [];
  const operands: string[] = [];
  for (const a of args) {
    if (a.startsWith('-') && a.length > 1) flags.push(a.toLowerCase());
    else operands.push(a);
  }
  return { flags, operands };
}

/** Short-cluster + long-form flag test. */
function hasFlag(
  flags: readonly string[],
  shortChars: readonly string[],
  longForms: readonly string[] = [],
): boolean {
  for (const f of flags) {
    if (f.startsWith('--')) {
      const name = f.slice(2).split('=')[0];
      if (longForms.includes(name)) return true;
    } else if (f.startsWith('-') && shortChars.length > 0) {
      if (shortChars.every((c) => f.slice(1).includes(c))) return true;
    }
  }
  return false;
}

/** Truly inert, read-only programs worth a zero-regex safe fast path.
 *  Deliberately EXCLUDES payload executors (sed/awk/xargs/find -delete):
 *  their arguments can be arbitrary programs, so they fall to 'review'. */
const SAFE_PROGRAMS = new Set([
  'ls', 'cat', 'pwd', 'echo', 'head', 'tail', 'wc', 'true', 'false', 'which', 'whoami',
  'uname', 'date', 'printenv', 'basename', 'dirname', 'sort', 'uniq', 'diff', 'grep',
  'rg', 'findstr', 'jq', 'column', 'less', 'more', 'stat', 'file', 'du', 'df', 'ps',
  'id', 'groups', 'hostname', 'sleep', 'exit', 'return', 'mkdir', 'touch', 'rmdir',
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'describe',
  'config', 'blame', 'shortlog', 'ls-files', 'ls-remote', 'tag', 'worktree',
]);

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'ksh', 'zsh']);
const DOWNLOADERS = new Set(['curl', 'wget']);

/**
 * Textual rules that need more than argv shape: fork bombs and root
 * filesystem redirects. Applied to BOTH the raw command line and each
 * segment — segmentation itself cuts `|`/`;`/`&`, which would otherwise
 * break the fork-bomb signature before the regex can see it. Aligned with
 * the CLI shellBlocklist so the classifier never disagrees on hard blocks.
 */
const TEXT_BLOCKED_RULES: readonly { re: RegExp; reason: string }[] = [
  { re: /:\(\)\s*\{\s*:\|:&\s*\}/, reason: 'fork bomb' },
  { re: />\s*\/etc\//, reason: 'redirect to /etc' },
  { re: />\s*\/boot\//, reason: 'redirect to /boot' },
  { re: />\s*\/usr\//, reason: 'redirect to /usr' },
];

function isEnvAssignment(token: string): boolean {
  const eq = token.indexOf('=');
  return eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq));
}

/**
 * Classify a single program + argv (already tokenized). Labels for shapes
 * covered by the CLI destructiveCommands regex list are kept IDENTICAL to
 * those labels so the classifier-first swap cannot change user-facing text.
 */
export function classifyArgv(program: string, args: readonly string[]): ArgvVerdict {
  const norm = normalizeProgram(program);
  if (!norm) return { tier: 'safe', reasons: [] };

  // `sh -c '<command string>'` / `bash -lc '<…>'`: classify what the
  // interpreter will actually run (mirrors stripRawShellLayer in the CLI).
  if (SHELL_INTERPRETERS.has(norm) && args.length >= 2 && /^-\w*c\w*$/.test(args[0])) {
    return classifyCommandString(args[1]);
  }

  // `env [VAR=val|-flag|--]* [--] <cmd> …`: positional scan — only the
  // LEADING env prefixes are skipped, the wrapped command keeps its own
  // flags (env CI=1 rm -rf dist must see '-rf').
  if (norm === 'env') {
    let i = 0;
    while (i < args.length && (isEnvAssignment(args[i]) || args[i].startsWith('-'))) i++;
    if (args[i] === '--') i++;
    if (i < args.length) {
      return classifyArgv(args[i], args.slice(i + 1));
    }
  }

  const { flags, operands } = splitArgv(args);

  // `<program> --version|-v|--help|-h` with nothing else: safe fast path.
  if (
    operands.length === 0 &&
    flags.length > 0 &&
    flags.every((f) => VERSIONISH_FLAGS.has(f))
  ) {
    return { tier: 'safe', reasons: [] };
  }

  if (norm === 'sudo') {
    return { tier: 'blocked', reasons: ['sudo without explicit consent'] };
  }
  if (norm === 'rm') {
    const recursive = hasFlag(flags, ['r'], ['recursive']);
    const force = hasFlag(flags, ['f'], ['force']);
    if (recursive && force) return { tier: 'destructive', reasons: ["'rm' recursive+force delete"] };
    if (recursive || force) return { tier: 'review', reasons: ["'rm' with recursive/force flag"] };
    return { tier: 'review', reasons: ["'rm' delete"] };
  }
  if (norm === 'del' || norm === 'rd') {
    // Windows switches use `/`, so they land in operands — test raw args.
    if (args.some((a) => /^\/s\b/i.test(a))) {
      return { tier: 'destructive', reasons: [`'${norm} /s' subtree delete`] };
    }
    return { tier: 'review', reasons: [`'${norm}' delete`] };
  }
  if (norm === 'remove-item' || norm === 'ri') {
    if (hasFlag(flags, ['r'], ['recurse', 'recurs'])) {
      return { tier: 'destructive', reasons: ["'Remove-Item -Recurse' recursive delete"] };
    }
    return { tier: 'review', reasons: ["'Remove-Item' delete"] };
  }
  if (norm === 'format') {
    if (operands.some((o) => /^[a-z]:/i.test(o))) {
      return { tier: 'destructive', reasons: ["'format <volume>:'"] };
    }
    return { tier: 'review', reasons: ["'format' volume format"] };
  }
  if (norm === 'mkfs' || norm.startsWith('mkfs.')) {
    return { tier: 'destructive', reasons: ["'mkfs' filesystem format"] };
  }
  if (norm === 'dd') {
    if (args.some((a) => /^of=\/dev\//i.test(a))) {
      return { tier: 'destructive', reasons: ["'dd' raw device write"] };
    }
    return { tier: 'review', reasons: ["'dd' raw copy"] };
  }
  if (norm === 'chmod' || norm === 'icacls' || norm === 'takeown') {
    if (hasFlag(flags, ['r'], ['recursive']) && operands[0] === '777' && operands[1] === '/') {
      return { tier: 'destructive', reasons: ["'chmod -R 777 /' root permission wipe"] };
    }
    return { tier: 'review', reasons: [`'${norm}' permission change`] };
  }
  if (norm === 'git') {
    const sub = (operands[0] ?? '').toLowerCase();
    if (sub === 'push') {
      // Prefix match keeps parity with the legacy regex, which counts
      // `--force-with-lease` too (conservative by design).
      const force =
        hasFlag(flags, ['f'], ['force']) || flags.some((f) => f.startsWith('--force'));
      if (force) return { tier: 'destructive', reasons: ["'git push --force'"] };
      return { tier: 'review', reasons: ["'git push'"] };
    }
    if (sub === 'branch' || sub === 'tag') {
      if (hasFlag(flags, ['d'], ['delete'])) {
        return { tier: 'review', reasons: [`'git ${sub}' delete`] };
      }
    }
    if (sub === 'reset' && hasFlag(flags, [], ['hard'])) {
      return { tier: 'review', reasons: ["'git reset --hard'"] };
    }
    if (sub === 'clean' && hasFlag(flags, ['f'], ['force'])) {
      return { tier: 'destructive', reasons: ["'git clean -f' untracked delete"] };
    }
    if (SAFE_GIT_SUBCOMMANDS.has(sub)) return { tier: 'safe', reasons: [] };
    return { tier: 'review', reasons: [`'git ${sub || '(none)'}'`] };
  }
  if (norm === 'npm' || norm === 'pnpm' || norm === 'yarn' || norm === 'bun') {
    const sub = (operands[0] ?? '').toLowerCase();
    if (sub === 'publish' || sub === 'unpublish') {
      return { tier: 'destructive', reasons: [`'${norm} ${sub}' registry write`] };
    }
    return { tier: 'review', reasons: [`'${norm} ${sub || '(none)'}'`] };
  }
  if (DOWNLOADERS.has(norm)) {
    return { tier: 'review', reasons: [`'${norm}' network download`] };
  }
  if (norm === 'mv' || norm === 'cp' || norm === 'rsync' || norm === 'move' || norm === 'robocopy') {
    return { tier: 'review', reasons: [`'${norm}' file move/copy`] };
  }
  if (SAFE_PROGRAMS.has(norm)) return { tier: 'safe', reasons: [] };
  // Unknown program: 'review' is the honest default. Nothing in this slice
  // escalates on 'review' (ask-escalation consumers act on destructive/
  // blocked only), so this cannot change existing behavior.
  return { tier: 'review', reasons: [`unknown program '${norm}'`] };
}

/**
 * Classify a whole raw shell line: split segments, tokenize each, classify
 * the argv, then apply the textual rules (fork bomb, root redirects) to the
 * RAW line and every segment, plus the pipe-to-shell check (downloader
 * segment followed by a shell segment).
 */
export function classifyCommandString(command: string): ArgvVerdict {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { tier: 'safe', reasons: [] };
  }
  const segments = splitCommandSegments(command);
  let tier: ArgvTier = 'safe';
  const reasons: string[] = [];
  const push = (t: ArgvTier, why: string[]) => {
    tier = maxTier(tier, t);
    for (const w of why) if (!reasons.includes(w)) reasons.push(w);
  };

  // Textual rules run on the RAW line first (segmentation would destroy the
  // fork-bomb signature), then again per segment (harmless, deduped).
  for (const rule of TEXT_BLOCKED_RULES) {
    if (rule.re.test(command)) push('blocked', [rule.reason]);
  }

  const programs: string[] = [];
  for (const seg of segments) {
    for (const rule of TEXT_BLOCKED_RULES) {
      if (rule.re.test(seg)) push('blocked', [rule.reason]);
    }
    const tokens = tokenizeCommandString(seg);
    if (tokens.length === 0) continue;
    let program = normalizeProgram(tokens[0]);
    let argv = tokens.slice(1);
    // `sudo <cmd>` inside a segment: keep the stricter verdict of the two.
    if (program === 'sudo' && argv.length > 0) {
      push('blocked', ['sudo without explicit consent']);
      program = normalizeProgram(argv[0]);
      argv = argv.slice(1);
    }
    programs.push(program);
    const verdict = classifyArgv(program, argv);
    push(verdict.tier, verdict.reasons);
  }

  // Pipe/chain into a shell interpreter right after a downloader → blocked.
  for (let i = 1; i < programs.length; i++) {
    if (SHELL_INTERPRETERS.has(programs[i]) && DOWNLOADERS.has(programs[i - 1])) {
      push('blocked', [`${programs[i - 1]} | sh`]);
    }
  }

  return { tier, reasons };
}
