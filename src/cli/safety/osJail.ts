/**
 * osJail — Pilastro A (HARNESS-10 t28): OS-level process jail for the CLI
 * execution surface (`exec_process` + the CLI `bash` path).
 *
 * WHAT IT IS
 *   ONE choke-point, {@link spawnJailed}, through which EVERY CLI spawn of
 *   the exec tools must flow (grep-gated by scripts/verify-os-jail.mjs).
 *   The {@link JailSpec} is derived from the SAME decision inputs the
 *   permission layer already used — sandboxPath root + resourceClaims
 *   network claims — there is deliberately NO second policy engine here.
 *
 * HONESTY CONTRACT (P3 — no fake containment, no jail-by-prompt)
 *   Pure Node CANNOT create restricted tokens (win32) or landlock rulesets
 *   (linux) without native modules, which this repo bans. Each backend in
 *   ./jails/ therefore probes HONESTLY and reports `unavailable` when it
 *   cannot actually contain the child:
 *     - darwin : sandbox-exec (Seatbelt) profile as argv prefix
 *     - linux  : bubblewrap (bwrap) argv wrapper — landlock needs syscalls
 *                Node does not expose, so without bwrap there is NO backend
 *     - win32  : restricted token + low integrity + Job Object needs native
 *                APIs → the backend declares itself UNAVAILABLE in this task
 *   Golden rule: backend missing + ZELARI_OS_JAIL=required ⇒ the tool is
 *   DENIED (typed `[jail]` error) — NEVER warn/skip/upgrade-to-advisory.
 *   The advisory fail-open is ALWAYS VISIBLE: console.error + audit entry +
 *   a warning on the tool result. Silence would be a fake guarantee.
 *
 * MODE RESOLUTION (same pattern as safety/lifecycleHooks.resolveHookFailureMode)
 *   1. ZELARI_OS_JAIL=off|advisory|required (exact match, case/space
 *     -insensitive; any other value is IGNORED — a typo never weakens the jail)
 *   2. default: `required` on strict surfaces (headless/mission/CI — see
 *      policyLoadMode) WHEN the platform backend probes available, otherwise
 *      VISIBLE advisory; `advisory` on the interactive TUI.
 *
 * A stub backend may be injected via {@link setJailBackendForTests} — that
 * seam is for TESTS ONLY and is never set by production code paths.
 *
 * Out of scope (declared, not hidden): persistent LSP language servers
 * (src/cli/lsp/manager.ts) and lifecycle hooks (packages/core LifecycleHookRunner,
 * which core cannot route through a CLI module) do NOT pass through this jail.
 *
 * @since v2.17.0 (HARNESS-10 t28)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { activePolicyLoadMode } from './policyLoadMode.js';
import { darwinBackend } from './jails/darwin.js';
import { linuxBackend } from './jails/linux.js';
import { win32Backend } from './jails/win32.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Jail strictness. Default per surface: required (headless/mission/CI), advisory (TUI). */
export type JailMode = 'off' | 'advisory' | 'required';

/**
 * Network posture. `deny` = no network for the jailed child (bwrap
 * --unshare-net / Seatbelt deny network*). `allow-list` carries the hosts
 * whose resource claim resolved to `allow`; where a backend cannot filter
 * per-host (bwrap, and our Seatbelt profile) it degrades to full allow and
 * SAYS SO — the claims-level verdict still gates the tool call itself.
 */
export type JailNetwork =
  | { mode: 'deny' }
  | { mode: 'allow' }
  | { mode: 'allow-list'; hosts: readonly string[] };

/**
 * THE jail decision for one exec surface, built from the SAME inputs the
 * permission layer used (root from sandboxPath, network from resourceClaims).
 */
export interface JailSpec {
  /** Workspace root every jailed process is confined to (the sandboxPath root). */
  root: string;
  network: JailNetwork;
  /** The ONLY env variables the jailed child receives (t28: exec inherited ALL of process.env before). */
  envAllowlist: readonly string[];
  /** Writable paths: root + OS tmpdir + ~/.zelari-code. */
  writable: readonly string[];
}

/** Honest probe outcome — `available:false` must reflect REAL incapability. */
export interface JailProbeResult {
  /** Backend id (e.g. 'seatbelt', 'bwrap', 'win32-restricted-token'). */
  backend: string;
  available: boolean;
  /** Why it is (un)available — surfaced in deny/notice messages. */
  reason: string;
}

/** A jail backend: honest probe + argv wrapper. NEVER spawns anything. */
export interface JailBackend {
  readonly id: string;
  probe(): JailProbeResult;
  wrap(spec: JailSpec, program: string, argv: readonly string[]): { program: string; argv: string[] };
}

// ── Mode resolution (resolveHookFailureMode pattern) ─────────────────────

/** Env override accepted by resolveJailMode. */
export const OS_JAIL_ENV = 'ZELARI_OS_JAIL';

/**
 * Pure mode resolution. Exactly `off` / `advisory` / `required` (case/space
 * -insensitive) wins; ANY other value is ignored and falls through to the
 * surface default — strict policy ⇒ required, permissive ⇒ advisory. Same
 * shape as safety/lifecycleHooks.resolveHookFailureMode (t22), one more
 * consumer of the SAME policy load mode, not a second switch.
 */
export function resolveJailMode(
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): JailMode {
  const v = override?.trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'advisory') return 'advisory';
  if (v === 'required') return 'required';
  // v2.32 (S4): `--permissions strict` (ZELARI_PERMISSION_PRESET, set by the
  // flag at boot) carries the same strict intent as the policy-load strict
  // mode. Strict intent still NEVER defaults to required without a real
  // backend — the honest fallback stays a VISIBLE advisory, never silence.
  const strictIntent =
    activePolicyLoadMode(env) === 'strict' ||
    (env.ZELARI_PERMISSION_PRESET ?? '').trim().toLowerCase() === 'strict';
  if (!strictIntent) return 'advisory';
  // Strict surfaces want a REAL jail — but the backend must exist. Defaulting
  // to `required` on a platform with no honest backend (win32 today, linux
  // without bwrap) would DENY every exec tool call there. The honest default
  // is VISIBLE advisory (triple notice); `required` stays enforceable — and
  // DENIES on a missing backend — when set explicitly via ZELARI_OS_JAIL.
  return probeJailBackend().available ? 'required' : 'advisory';
}

/** Resolve the ACTIVE jail mode from env (injectable so tests never mutate process.env). */
export function activeJailMode(env: NodeJS.ProcessEnv = process.env): JailMode {
  return resolveJailMode(env[OS_JAIL_ENV], env);
}

// ── Backends ─────────────────────────────────────────────────────────────

function platformBackend(platform: string = process.platform): JailBackend {
  switch (platform) {
    case 'darwin':
      return darwinBackend;
    case 'linux':
      return linuxBackend;
    default:
      // win32 (and anything else): the honest-unavailable restricted-token stub.
      return win32Backend;
  }
}

let testBackend: JailBackend | null = null; // TEST-ONLY injection, never production.
let probeCache: { platform: string; result: JailProbeResult } | null = null;

/** Current backend: the injected test stub wins, otherwise the platform's. */
function currentBackend(platform: string = process.platform): JailBackend {
  return testBackend ?? platformBackend(platform);
}

/**
 * Probe the active backend (memoized for the real platform probe; the test
 * stub is probed fresh every call so tests can flip availability freely).
 */
export function probeJailBackend(platform: string = process.platform): JailProbeResult {
  if (testBackend) return testBackend.probe();
  if (!probeCache || probeCache.platform !== platform) {
    probeCache = { platform, result: platformBackend(platform).probe() };
  }
  return probeCache.result;
}

/**
 * TEST-ONLY: inject a jail backend (or `null` to restore the platform one).
 * Production code must never call this — a stub is NEVER active by default.
 */
export function setJailBackendForTests(backend: JailBackend | null): void {
  testBackend = backend;
  probeCache = null;
}

// ── JailSpec construction (same decision inputs — no second policy engine) ──

/** Spec-mandated default allowlist: today's exec tools inherited ALL of process.env. */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LANG', 'CI', 'TERM', 'NO_COLOR',
];

/**
 * win32 additions WITHOUT which a jailed shell cannot even start (SystemRoot
 * missing makes many Windows binaries fail outright); `MSYSTEM` is what the
 * Git Bash branch of the bash tool sets. Documented default, still a tiny
 * fraction of process.env.
 */
const WIN32_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'Path', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'SystemDrive', 'ComSpec',
  'PATHEXT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
  'MSYSTEM', 'PROGRAMFILES', 'ProgramFiles', 'ProgramData', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'WINDIR',
];

export function defaultEnvAllowlist(platform: string = process.platform): readonly string[] {
  return platform === 'win32' ? [...BASE_ENV_ALLOWLIST, ...WIN32_ENV_ALLOWLIST] : BASE_ENV_ALLOWLIST;
}

/** Writable = root + tmpdir + ~/.zelari-code (deduped, case-folded on win32). */
export function defaultWritable(
  root: string,
  home: string = homedir(),
  tmp: string = tmpdir(),
  platform: string = process.platform,
): string[] {
  // All three entries go through the same resolution so that dedup is
  // host-independent: a win32 case-folded collapse must hold on any host
  // (path.resolve is identity for already-absolute native paths).
  const raw = [path.resolve(root), path.resolve(tmp), path.join(home, '.zelari-code')];
  const out: string[] = [];
  for (const p of raw) {
    const key = platform === 'win32' ? p.toLowerCase() : p;
    if (!out.some((q) => (platform === 'win32' ? q.toLowerCase() : q) === key)) out.push(p);
  }
  return out;
}

/**
 * Build a JailSpec. `network` defaults to the conservative deny; pass the
 * result of {@link networkSpecFromClaimHosts} to honor the claims decision.
 */
export function buildJailSpec(opts: {
  root: string;
  network?: JailNetwork;
  envAllowlist?: readonly string[];
  writable?: readonly string[];
}): JailSpec {
  return {
    root: path.resolve(opts.root),
    network: opts.network ?? { mode: 'deny' },
    envAllowlist: opts.envAllowlist ?? defaultEnvAllowlist(),
    writable: opts.writable ?? defaultWritable(opts.root),
  };
}

/**
 * Pure bridge from the EXISTING claims engine (resourceClaims): hosts whose
 * layered claim verdict was `allow` become the allow-list; anything else
 * (no claims / ask / deny) stays conservative `deny`.
 */
export function networkSpecFromClaimHosts(allowedHosts: readonly string[] | undefined): JailNetwork {
  if (!allowedHosts || allowedHosts.length === 0) return { mode: 'deny' };
  return { mode: 'allow-list', hosts: [...new Set(allowedHosts)] };
}

/**
 * Env sanitation for a jailed child: keep ONLY allowlisted variables
 * (case-insensitive on win32, preserving the original key casing) and always
 * propagate the CI fast-fail flag. Pure — `env` is never mutated.
 */
export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  platform: string = process.platform,
): NodeJS.ProcessEnv {
  const wanted = new Set(allowlist.map((k) => (platform === 'win32' ? k.toLowerCase() : k)));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const key = platform === 'win32' ? k.toLowerCase() : k;
    if (wanted.has(key)) out[k] = v;
  }
  return out;
}

// ── Decision + THE choke-point ───────────────────────────────────────────

export interface DecideJailSpawnInput {
  program: string;
  argv: readonly string[];
  /** Base env (usually process.env) BEFORE sanitation. */
  env?: NodeJS.ProcessEnv;
  /** Merged on top of `env` before sanitation (e.g. CI=1, MSYSTEM). */
  envExtras?: Record<string, string | undefined>;
  /** Injectable for pure tests; defaults to {@link activeJailMode}. */
  mode?: JailMode;
}

export type JailSpawnDecision =
  | { action: 'spawn-jailed'; probe: JailProbeResult; program: string; argv: string[]; env: NodeJS.ProcessEnv }
  | { action: 'spawn-plain'; env: NodeJS.ProcessEnv; notice?: string }
  | { action: 'deny'; reason: string };

/** Canonical deny reason (golden rule) shared by preflight and spawn paths. */
export function jailDenyReason(probe: JailProbeResult, mode: JailMode): string {
  return (
    `OS jail backend unavailable (${probe.backend}: ${probe.reason}) with ZELARI_OS_JAIL=${mode} — ` +
    'execution is DENIED instead of running unjailed (t28 golden rule: missing backend + required ⇒ deny, never warn/skip). ' +
    'Set ZELARI_OS_JAIL=advisory (visible fail-open) or =off to explicitly allow unjailed execution.'
  );
}

/** Canonical advisory notice — the fail-open must be SEEN, never silent. */
export function jailAdvisoryNotice(probe: JailProbeResult): string {
  return (
    `advisory: OS jail backend unavailable (${probe.backend}: ${probe.reason}) — ` +
    'this process will run UNJAILED (visible fail-open). Set ZELARI_OS_JAIL=required to deny instead.'
  );
}

/**
 * Pure decision of WHAT a spawn may do under the current jail mode:
 *   required + backend missing ⇒ deny (typed `[jail]`, no spawn at all);
 *   advisory + backend missing ⇒ unjailed spawn + notice (visible fail-open);
 *   backend available          ⇒ wrapped argv + sanitized env;
 *   off                        ⇒ today's plain behavior, untouched.
 * When the jail is active (mode != off) the env is sanitized EVEN on the
 * fail-open path — env allowlisting is ours, not the kernel's.
 */
export function decideJailSpawn(spec: JailSpec, input: DecideJailSpawnInput): JailSpawnDecision {
  const mode = input.mode ?? activeJailMode();
  const merged: NodeJS.ProcessEnv = { ...(input.env ?? process.env), ...(input.envExtras ?? {}) };
  if (mode === 'off') return { action: 'spawn-plain', env: merged };
  const probe = probeJailBackend();
  if (!probe.available) {
    if (mode === 'required') return { action: 'deny', reason: jailDenyReason(probe, mode) };
    return { action: 'spawn-plain', env: sanitizeEnv(merged, spec.envAllowlist), notice: jailAdvisoryNotice(probe) };
  }
  const wrapped = currentBackend().wrap(spec, input.program, input.argv);
  return {
    action: 'spawn-jailed',
    probe,
    program: wrapped.program,
    argv: wrapped.argv,
    env: sanitizeEnv(merged, spec.envAllowlist),
  };
}

export interface JailedSpawnRequest {
  program: string;
  argv: readonly string[];
  cwd: string;
  /** Cancellation wired to the tool ctx (child dies with the call). */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  envExtras?: Record<string, string | undefined>;
  /** Visibility sink for the advisory fail-open; console.error is always emitted too. */
  onNotice?: (notice: string) => void;
}

export type JailedSpawnResult =
  | { outcome: 'spawned'; child: ChildProcess; backend: string; jailed: boolean; notice?: string }
  | { outcome: 'denied'; reason: string }
  | { outcome: 'failed'; reason: string };

/**
 * THE spawn choke-point for the CLI exec surface (exec_process + CLI bash
 * via the core seam). The only place in those paths that touches
 * child_process.spawn. Always `shell:false`, stdin closed; deny reasons are
 * prefixed `[jail]` so callers surface a typed tool error.
 */
export function spawnJailed(spec: JailSpec, req: JailedSpawnRequest): JailedSpawnResult {
  const decision = decideJailSpawn(spec, {
    program: req.program,
    argv: req.argv,
    env: req.env,
    envExtras: req.envExtras,
  });
  if (decision.action === 'deny') {
    return { outcome: 'denied', reason: `[jail] ${decision.reason}` };
  }
  const notice = decision.action === 'spawn-plain' ? decision.notice : undefined;
  if (notice) {
    // P3: fail-open is visible. Console first (chip-style line), then the sink.
    console.error(`[os-jail] ${notice}`);
    req.onNotice?.(notice);
  }
  const jailed = decision.action === 'spawn-jailed';
  const program = jailed ? decision.program : req.program;
  const argv = jailed ? decision.argv : [...req.argv];
  try {
    const child = spawn(program, argv, {
      cwd: req.cwd,
      signal: req.signal,
      shell: false,
      env: decision.env,
      stdio: ['ignore', 'pipe', 'pipe'], // non-interactive by construction
    });
    return {
      outcome: 'spawned',
      child,
      backend: jailed ? decision.probe.backend : 'none',
      jailed,
      ...(notice ? { notice } : {}),
    };
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Availability snapshot for preflight call sites (the bash wrapper): what
 * mode is active and whether a backend exists. `off` short-circuits to a
 * neutral probe without touching the backend.
 */
export function jailAvailability(env: NodeJS.ProcessEnv = process.env): {
  mode: JailMode;
  probe: JailProbeResult;
} {
  const mode = activeJailMode(env);
  const probe: JailProbeResult =
    mode === 'off'
      ? { backend: 'none', available: false, reason: 'jail disabled (ZELARI_OS_JAIL=off)' }
      : probeJailBackend();
  return { mode, probe };
}
