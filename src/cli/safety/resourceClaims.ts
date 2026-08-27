/**
 * Resource claims (P0.C1) — what ONE tool invocation can actually touch.
 * Each invocation expands to 0..N claims ({@link resourceClaimsFor}); every
 * claim matches INDEPENDENTLY against the layered agent rules and the
 * per-claim effects intersect deny > ask > allow, so one denied resource
 * denies the whole call (closes the leak where multi-path tools like
 * apply_diff were checked only on their primary argument). Only path-WRITE
 * claims also reuse the legacy `edit` list; reads never inherit it.
 *
 * Kinds `ui` / `agent`: accepted by the v2 policy schema but EVALUATION IS
 * DEFERRED TO v1.1 — no tool emits such a claim yet, so those rules are inert.
 * Fail-open: unknown tool or unusable args -> [] (nothing widened).
 *
 * @since P0.C1
 */
import type { PermissionAction } from './toolPermissions.js';
import type {
  LayeredPolicyRuleSet,
  PolicyPrecedence,
  PolicyRule,
  PolicyRuleSet,
} from './policyEngine.js';
import { pathCandidates, resolvePolicyRule } from './policyEngine.js';
import { intersectEffects } from './policyLayers.js';

export type ResourceClaim =
  | { kind: 'path'; operation: 'read' | 'write'; path: string }
  /**
   * P0.C2 (t17): `raw` carries the UNSTRIPPED command string when raw-shell
   * prefix normalization rewrote `executable`/`argv` (see normalizeProcessArgs)
   * so rules anchored to the literal input still find a match value.
   */
  | { kind: 'process'; executable: string; argv?: string[]; raw?: string }
  | { kind: 'network'; host: string; port?: number }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'ssh'; target: string; command?: string }
  /** Deferred to v1.1 — parsed by the v2 schema, never emitted here yet. */
  | { kind: 'ui'; action: string }
  | { kind: 'agent'; role: string };


function asArgs(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The primary path argument, mirroring matchAgentPolicyRule: `path` then `file_path`. */
function primaryPath(a: Record<string, unknown>): string | undefined {
  return str(a['path']) ?? str(a['file_path']);
}

/** Paths referenced by a diff's `---`/`+++` headers (best-effort, `/dev/null`
 * skipped, `a/` `b/` + quotes stripped) — write claims so none dodges a deny. */
function pathsFromUnifiedDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const m = /^(?:---|\+\+\+)\s+(\S+)/.exec(line);
    if (!m) continue;
    let p = m[1].replace(/^"|"$/g, '');
    if (p === '/dev/null') continue;
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    if (p !== '') out.add(p);
  }
  return [...out];
}

/** Host (+optional port) claims for every absolute URL in the args. */
function networkClaimsForUrls(urls: readonly unknown[]): ResourceClaim[] {
  const out: ResourceClaim[] = [];
  for (const u of urls) {
    if (typeof u !== 'string' || u === '') continue;
    try {
      const parsed = new URL(u);
      const port = parsed.port !== '' ? Number(parsed.port) : undefined;
      out.push(
        port !== undefined && Number.isInteger(port)
          ? { kind: 'network', host: parsed.hostname, port }
          : { kind: 'network', host: parsed.hostname },
      );
    } catch {
      // Not an absolute URL — the tool itself will reject it later; no claim.
    }
  }
  return out;
}

/** Best-effort `mcp_<server>_<tool>` reverse-parse (first underscore split;
 * ambiguous for underscored server names — accepted). */
function mcpClaimFromName(registryName: string): ResourceClaim | null {
  const rest = registryName.startsWith('mcp_') ? registryName.slice('mcp_'.length) : '';
  const sep = rest.indexOf('_');
  return sep <= 0 || sep === rest.length - 1
    ? null
    : { kind: 'mcp', server: rest.slice(0, sep), tool: rest.slice(sep + 1) };
}

/** Nested action URLs a browser_check call may navigate to. */
function browserActionUrls(a: Record<string, unknown>): unknown[] {
  const actions = Array.isArray(a['actions']) ? a['actions'] : [];
  return actions.map((x) => (x !== null && typeof x === 'object' ? (x as Record<string, unknown>)['url'] : undefined));
}
/**
 * Raw-shell normalization (P0.C2/t17) — BEST-EFFORT, deliberately not a shell
 * parser: strip common wrapper prefixes so `env FOO=x git push`,
 * `command git push`, `exec git push`, `bash -lc 'git push'`,
 * `cmd.exe /c git push` and extra whitespace classify as the program they
 * actually run (`git push`), letting a `git push*` rule hit what a plain
 * `command: 'git push …'` would have hit. Quoted strings are re-tokenized
 * quote-aware; recursion is depth-capped and ANY ambiguity keeps the original.
 */

/** Cap for nested wrappers (`bash -lc 'bash -lc …'`). */
const MAX_RAW_SHELL_STRIP_DEPTH = 3;

/** Prefixes that prepend context around the real command. */
const RAW_SHELL_WRAPPERS = new Set(['command', 'exec', 'nice', 'nohup', 'time']);
/** Interpreters whose `-c`-style flag executes the NEXT argument as a string. */
const RAW_SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'ksh', 'zsh']);

function stripWindowsExecutableExt(name: string): string {
  return name.replace(/\.(exe|cmd|bat|com)$/i, '');
}

/** Whitespace tokenizer honoring single/double quotes; quotes are dropped. */
function tokenizeCommandString(command: string): string[] {
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

function isEnvAssignment(token: string): boolean {
  const eq = token.indexOf('=');
  return eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq));
}

/** Strip one wrapper layer per call; returns argv for the program it runs. */
function stripRawShellLayer(argv: readonly string[], depth: number): string[] {
  if (depth >= MAX_RAW_SHELL_STRIP_DEPTH || argv.length === 0) return [...argv];
  const bare = stripWindowsExecutableExt(argv[0]).toLowerCase();
  // env [VAR=val|-flag]* [--] cmd …
  if (bare === 'env') {
    let i = 1;
    while (i < argv.length && (isEnvAssignment(argv[i]) || argv[i].startsWith('-'))) i++;
    if (argv[i] === '--') i++;
    if (i >= argv.length) return [...argv]; // nothing left — keep original
    return stripRawShellLayer(argv.slice(i), depth + 1);
  }
  if (RAW_SHELL_WRAPPERS.has(bare)) {
    let i = 1;
    while (i < argv.length && argv[i].startsWith('-')) i++;
    if (i >= argv.length) return [...argv];
    return stripRawShellLayer(argv.slice(i), depth + 1);
  }
  // sh/bash -lc '<command string>' — execute the string, not the interpreter.
  if (RAW_SHELL_INTERPRETERS.has(bare)) {
    if (argv.length >= 3 && /^-\w*c\w*$/.test(argv[1])) {
      return stripRawShellLayer(tokenizeCommandString(argv[2]), depth + 1);
    }
    return [...argv]; // `bash script.sh` — can't know what the script runs
  }
  // cmd.exe /c <string>
  if ((bare === 'cmd' || bare === 'cmd.exe') && argv.length >= 3 && /^\/c$/i.test(argv[1])) {
    return stripRawShellLayer(tokenizeCommandString(argv.slice(2).join(' ')), depth + 1);
  }
  return [...argv];
}

export interface NormalizedProcessArgs {
  /** argv of the program the raw shell line actually runs. */
  argv: string[];
  /** True when prefix stripping rewrote the tokenization. */
  changed: boolean;
}

/**
 * Best-effort wrapper stripping over an already-whitespace-split token list —
 * the entry point used by the tool → claims table below.
 */
export function normalizeProcessArgs(tokens: readonly string[]): NormalizedProcessArgs {
  const stripped = stripRawShellLayer(tokens, 0);
  return { argv: stripped, changed: stripped.join(' ') !== tokens.join(' ') };
}

/** Match values for ONE process claim: canonical chain first (+ raw original). */
function processClaimValues(claim: Extract<ResourceClaim, { kind: 'process' }>): string[] {
  const main =
    claim.argv && claim.argv.length > 0
      ? [claim.executable, ...claim.argv].join(' ')
      : claim.executable;
  return claim.raw && claim.raw !== main ? [main, claim.raw] : [main];
}

/**
 * Central tool → claims table (best-effort throughout). `web_search` yields
 * NO claim: its destination host is the search backend, not argument-chosen
 * (category policy still gates it). Unknown tool → [].
 */
export function resourceClaimsFor(toolName: string, args: unknown): ResourceClaim[] {
  const a = asArgs(args);
  switch (toolName) {
    case 'write_file':
    case 'edit_file': {
      const p = primaryPath(a);
      return p ? [{ kind: 'path', operation: 'write', path: p }] : [];
    }
    case 'apply_diff': {
      // Cover EVERY path it can touch: primary `path` + all diff headers.
      const uniq: string[] = [];
      for (const p of [primaryPath(a), ...pathsFromUnifiedDiff(str(a['diff']) ?? '')]) {
        if (p && !uniq.includes(p)) uniq.push(p);
      }
      return uniq.map((p) => ({ kind: 'path', operation: 'write', path: p }) as ResourceClaim);
    }
    // READ tools — match only explicit v2 `claims` rules, never the edit list.
    case 'read_file':
    case 'show_diff':
    case 'list_files':
    case 'grep_content': {
      const p = primaryPath(a);
      return p ? [{ kind: 'path', operation: 'read', path: p }] : [];
    }
    // Shell-like — raw-shell string normalized into the process it runs
    // (best-effort wrapper stripping, P0.C2/t17; NOT a shell parser).
    // Tokenize quote-aware FIRST so `bash -lc '<string>'` keeps its command
    // argument intact for the interpreter branch.
    case 'bash':
    case 'inspect_command': {
      const cmd = str(a['command']);
      if (!cmd) return [];
      const tokens = tokenizeCommandString(cmd);
      const { argv, changed } = normalizeProcessArgs(tokens);
      const claim: ResourceClaim = {
        kind: 'process',
        executable: argv[0],
        ...(argv.length > 1 ? { argv: argv.slice(1) } : {}),
        ...(changed ? { raw: cmd.trim() } : {}),
      };
      return [claim];
    }
    // Structured execution (t17): no shell ever involved — the claim IS the
    // invocation. program basename (Windows extension stripped) matches
    // `git push*`-style rules; the literal path is kept as a second value.
    case 'exec_process': {
      const program = str(a['program']);
      if (!program) return [];
      const name = stripWindowsExecutableExt(program.split(/[\\/]/).pop() ?? program);
      const argv = Array.isArray(a['args'])
        ? a['args'].filter((x): x is string => typeof x === 'string')
        : [];
      return [{ kind: 'process', executable: name, ...(argv.length > 0 ? { argv } : {}) }];
    }
    case 'fetch_url':
      return networkClaimsForUrls([str(a['url'])]);
    case 'browser_check': {
      const urls = [a['url'], ...browserActionUrls(a)];
      return networkClaimsForUrls(urls.filter((u) => typeof u === 'string'));
    }
    case 'web_search':
      return []; // no argument-controlled destination host (see table doc)
    case 'ssh_run': {
      const target = str(a['targetId']);
      const command = str(a['command']);
      return target ? [command ? { kind: 'ssh', target, command } : { kind: 'ssh', target }] : [];
    }
    case 'ssh_status': {
      const target = str(a['targetId']);
      return target ? [{ kind: 'ssh', target }] : [];
    }
    case 'observe_batch': {
      // Nested observations fan out into the wrapped read tools.
      const ops = Array.isArray(a['operations']) ? a['operations'] : [];
      const out: ResourceClaim[] = [];
      for (const op of ops) {
        if (op === null || typeof op !== 'object') continue;
        const o = op as Record<string, unknown>;
        const p = primaryPath(asArgs(o['args']));
        if (p && ['read_file', 'grep_content', 'list_files'].includes(String(o['tool']))) {
          out.push({ kind: 'path', operation: 'read', path: p });
        }
      }
      return out;
    }
    default: {
      const mcp = mcpClaimFromName(toolName);
      return mcp ? [mcp] : [];
    }
  }
}


/** Values a claim's rules glob-match (anchored; paths try root-relative first). */
export function claimMatchValues(claim: ResourceClaim, root?: string): string[] {
  switch (claim.kind) {
    case 'path':
      return pathCandidates(claim.path, root);
    case 'process':
      return processClaimValues(claim);
    case 'network':
      return claim.port !== undefined ? [`${claim.host}:${claim.port}`, claim.host] : [claim.host];
    case 'mcp':
      return [`${claim.server}.${claim.tool}`];
    case 'ssh':
      return claim.command !== undefined ? [`${claim.target} ${claim.command}`] : [claim.target];
    case 'ui':
      return [claim.action];
    case 'agent':
      return [claim.role];
  }
}

/** Glob hits when ANY candidate value full-matches the anchored pattern. */
function globHits(pattern: string, values: readonly string[]): boolean {
  // resolvePolicyRule only reads `.match`; a deny placeholder keeps this a pure probe.
  return values.some((v) => resolvePolicyRule([{ match: pattern, effect: 'deny' }], v) !== null);
}

/**
 * Match ONE claim against ONE layer: the v2 `claims` section first (ordered,
 * kind+operation-aware), then the legacy fallback for retrocompat — path
 * WRITE claims reuse the v1 `edit` list and process claims the v1 `shell`
 * list with EXACTLY today's semantics. Read/network/mcp/ssh only hit
 * explicit `claims` rules, so v1 files never start denying them. Null =
 * this layer says nothing.
 */
export function claimRuleFor(
  rules: PolicyRuleSet | undefined,
  claim: ResourceClaim,
  root?: string,
): PolicyRule | null {
  if (!rules) return null;
  for (const cr of rules.claims ?? []) {
    if (cr.kind !== claim.kind) continue;
    if (claim.kind === 'path' && cr.operation !== undefined && cr.operation !== claim.operation) {
      continue;
    }
    if (globHits(cr.pattern, claimMatchValues(claim, root))) {
      return cr.reason
        ? { match: cr.pattern, effect: cr.effect, reason: cr.reason }
        : { match: cr.pattern, effect: cr.effect };
    }
  }
  // Legacy single-value fallbacks (identical behavior to the P0.A matcher).
  if (claim.kind === 'path' && claim.operation === 'write') {
    for (const candidate of pathCandidates(claim.path, root)) {
      const hit = resolvePolicyRule(rules.edit, candidate);
      if (hit) return hit;
    }
  }
  if (claim.kind === 'process') {
    return resolvePolicyRule(rules.shell, claimMatchValues(claim)[0]);
  }
  return null;
}

/** Combine BOTH layers for ONE claim — restrict-only per {@link matchAgentPolicyRuleLayered}
 * (stricter wins, ties keep project; legacy = project-first first-match). A
 * global-floor deny can NEVER be relaxed by an agent-local allow — this IS the
 * subagent ⊆ parent property through claims. */
export function matchResourceClaimLayered(
  layers: LayeredPolicyRuleSet | undefined,
  precedence: PolicyPrecedence,
  claim: ResourceClaim,
  root?: string,
): PolicyRule | null {
  if (!layers) return null;
  if (precedence === 'legacy') {
    const merged: PolicyRuleSet = {
      shell: [...layers.project.shell, ...layers.global.shell],
      edit: [...layers.project.edit, ...layers.global.edit],
    };
    if (layers.project.claims || layers.global.claims) {
      merged.claims = [...(layers.project.claims ?? []), ...(layers.global.claims ?? [])];
    }
    return claimRuleFor(merged, claim, root);
  }
  const g = claimRuleFor(layers.global, claim, root);
  const p = claimRuleFor(layers.project, claim, root);
  if (!g) return p;
  if (!p) return g;
  const win = intersectEffects(p.effect, g.effect);
  return p.effect === win ? p : g;
}

export interface ClaimsVerdict {
  /** Intersected deny>ask>allow across ALL claims/layers; undefined = no claim matched (never `allow`). */
  effect?: PermissionAction;
  /** One surfaced rule per matched claim (messages/diagnostics). */
  matchedRules: PolicyRule[];
}

/** Expand the invocation to claims, match EACH on the layered rules, intersect. */
export function resolveClaimsVerdict(
  layers: LayeredPolicyRuleSet | undefined,
  precedence: PolicyPrecedence,
  toolName: string,
  args: unknown,
  root?: string,
): ClaimsVerdict {
  const claims = resourceClaimsFor(toolName, args);
  const matchedRules: PolicyRule[] = [];
  if (!layers || claims.length === 0) return { matchedRules };
  const effects: PermissionAction[] = [];
  for (const claim of claims) {
    const hit = matchResourceClaimLayered(layers, precedence, claim, root);
    if (hit) {
      effects.push(hit.effect);
      matchedRules.push(hit);
    }
  }
  return effects.length > 0 ? { effect: intersectEffects(...effects), matchedRules } : { matchedRules };
}
