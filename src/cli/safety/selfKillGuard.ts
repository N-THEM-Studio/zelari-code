/**
 * selfKillGuard — refuse shell/exec commands that would kill the agent host
 * process itself (P0 anti-self-kill).
 *
 * Motivation: the agent runs as a `node` process; a well-meaning "stop the dev
 * server" command like `taskkill /IM node.exe` (or `pkill node`,
 * `Stop-Process -Name node`, a `ps | grep node | kill` pipeline) murders the
 * agent's own process tree mid-turn. The safe alternative is always to kill by
 * PORT (find the listener pid, kill that exact pid), never by image name.
 *
 * Pure detection: `inspectCommand(command, ctx)` returns a structured verdict
 * and never throws. Wiring (rejection = typed tool error, same discipline as
 * shellBlocklist): `src/cli/tools/execProcess.ts` (exec_process) and
 * `wrapWithShellSafety` in `src/cli/toolRegistry.ts` (the CLI bash tool).
 *
 * Conservative by design (same policy as shellBlocklist): prefers a rare false
 * positive over letting the agent destroy the host process.
 */

export interface SelfKillContext {
  /** PID of the agent host process (process.pid). */
  selfPid: number;
  /** Parent PID of the agent host (process.ppid), when known. */
  parentPid?: number;
  /** Additional PIDs that must never be targeted (sidecars, servers). */
  extraProtectedPids?: number[];
}

export type SelfKillReason =
  /** Kill by protected image name (node.exe / the agent binary). */
  | 'node-image'
  /** Kill of a protected literal PID (own process tree). */
  | 'protected-pid'
  /** `ps … | grep node … | kill/taskkill` pipeline (pids from stdin). */
  | 'ps-pipeline';

export interface SelfKillVerdict {
  blocked: boolean;
  reason?: SelfKillReason;
  /** Short description of the matched shape — for audit logs. */
  match?: string;
  /** Educational denial message — present only when blocked. */
  message?: string;
}

/** Educational denial — teaches the per-port alternative. */
export const SELF_KILL_DENIAL_MESSAGE =
  'Blocked: this command would kill the agent host process itself (node image / own process tree). ' +
  'To stop a dev server, kill by PORT instead: run `netstat -ano | findstr :<port>` to find the listener PID, ' +
  'then `taskkill //PID <listener-pid>` — never kill node by image name.';

/** Image names whose mass-kill equals suicide for the agent host. */
const PROTECTED_IMAGE_RE = /^(?:node(?:\.exe)?|zelari(?:-code)?(?:\.exe)?)$/i;

/** Drop quotes/commas around a captured image-name token. */
function cleanToken(raw: string): string {
  return raw.replace(/^["']+|["',]+\s*$/g, '').trim();
}

function isProtectedImage(name: string): boolean {
  return PROTECTED_IMAGE_RE.test(cleanToken(name));
}

/**
 * Remove `$(…)`, `${…}` and backtick bodies so the per-port pattern
 * `kill $(lsof -t -i:4173)` yields no literal PID to misjudge.
 */
function stripSubstitutions(cmd: string): string {
  return cmd
    .replace(/\$\([^)]*\)/g, ' ( ) ')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/`[^`]*`/g, ' ` ` ');
}

/** Kill-everything-of-a-protected-image shapes (Windows + POSIX). */
function findImageKill(cmd: string): string | null {
  // taskkill … /IM node.exe (also the Git Bash //IM form).
  const im = cmd.match(/\/{1,2}im\s+["']?([a-z0-9_.-]+)/i);
  if (im && /\btaskkill\b/i.test(cmd) && isProtectedImage(im[1])) {
    return `taskkill /IM ${cleanToken(im[1])}`;
  }
  // taskkill /FI "IMAGENAME eq node.exe" — the filter form kills the same way.
  const fi = cmd.match(/imagename\s+eq\s+["']?([a-z0-9_.-]+)/i);
  if (fi && /\btaskkill\b/i.test(cmd) && isProtectedImage(fi[1])) {
    return `taskkill /FI "IMAGENAME eq ${cleanToken(fi[1])}"`;
  }
  // PowerShell Stop-Process -Name node[-Force]; `kill -Name node` (PS alias).
  const nm = cmd.match(/\b(?:stop-process|kill)\b[^|;&]*-name\s+["']?([a-z0-9_.-]+)/i);
  if (nm && isProtectedImage(nm[1])) {
    return `Stop-Process -Name ${cleanToken(nm[1])}`;
  }
  // Get-Process node | Stop-Process (also `| % { $_.Kill() }`).
  if (
    /\bget-process\b[^|;&]*\bnode(?:\.exe)?\b/i.test(cmd) &&
    /\|\s*[^|]*?(?:stop-process|\.\s*kill\s*\(|\bkill\b)/i.test(cmd)
  ) {
    return 'Get-Process node | Stop-Process';
  }
  // pkill node · pkill -f node · pkill -f node.exe · pkill -9 node
  if (/\bpkill\b[^|;&]*\bnode(?:\.exe)?\b/i.test(cmd)) return 'pkill node';
  // killall node / killall node.exe
  if (/\bkillall\b[^|;&]*\bnode(?:\.exe)?\b/i.test(cmd)) return 'killall node';
  // wmic process where name="node.exe" delete | … call terminate
  if (
    /\bwmic\b[^|;&]*name\s*=\s*["']?node(?:\.exe)?["']?/i.test(cmd) &&
    /\b(?:delete|terminate)\b/i.test(cmd)
  ) {
    return 'wmic process delete node.exe';
  }
  return null;
}

/** `ps -W | grep node | awk … | xargs kill` — the pids ride stdin. */
function findPsPipelineKill(cmd: string): string | null {
  if (!/\bps\b[^|;&]*\|\s*(?:grep|findstr|awk|sed)[^|;&]*\bnode(?:\.exe)?\b/i.test(cmd)) {
    return null;
  }
  if (!/\b(?:xargs\s+)?(?:kill|taskkill|pkill|killall|stop-process)\b/i.test(cmd)) {
    return null; // read-only `ps aux | grep node` — allowed
  }
  return 'ps | grep node | kill';
}

/** Kill-by-PID shapes targeting the agent's own process tree. */
function findProtectedPidKill(cmd: string, ctx: SelfKillContext): string | null {
  const protectedPids = new Set<number>([
    ctx.selfPid,
    ...(ctx.parentPid !== undefined ? [ctx.parentPid] : []),
    ...(ctx.extraProtectedPids ?? []),
  ]);
  const hit = (pid: number, shape: string): string | null =>
    protectedPids.has(pid) ? `${shape} ${pid}` : null;
  const stripped = stripSubstitutions(cmd);

  // taskkill //PID n / /PID a,b,c / /PIDLIST …
  for (const m of stripped.matchAll(/\/{1,2}pid(?:list)?\s+([\d,\s]+)/gi)) {
    for (const tok of m[1].split(/[\s,]+/)) {
      const pid = Number.parseInt(tok, 10);
      if (Number.isFinite(pid) && pid > 0) {
        const h = hit(pid, 'taskkill /PID');
        if (h) return h;
      }
    }
  }
  // PowerShell Stop-Process -Id n (alias `kill -Id n`).
  for (const m of stripped.matchAll(/\b(?:stop-process|kill)\b[^|;&]*?-(?:id|pid)\s+(\d+)/gi)) {
    const h = hit(Number.parseInt(m[1], 10), 'Stop-Process -Id');
    if (h) return h;
  }
  // POSIX kill: bare decimal tokens in every kill argument list; signal flags
  // like -9 are not `^\d+$` so they are skipped.
  for (const m of stripped.matchAll(/\bkill\b([^|;&]*)/gi)) {
    for (const tok of m[1].split(/\s+/)) {
      if (!/^\d+$/.test(tok)) continue;
      const h = hit(Number.parseInt(tok, 10), 'kill');
      if (h) return h;
    }
  }
  return null;
}

function blockedVerdict(reason: SelfKillReason, match: string): SelfKillVerdict {
  return { blocked: true, reason, match, message: SELF_KILL_DENIAL_MESSAGE };
}

/**
 * Inspect one command string (shell string, or program+argv joined) against
 * the agent host process tree. Pure: no I/O, never throws.
 */
export function inspectCommand(command: string, ctx: SelfKillContext): SelfKillVerdict {
  if (typeof command !== 'string' || command.length === 0) return { blocked: false };
  const imageMatch = findImageKill(command);
  if (imageMatch) return blockedVerdict('node-image', imageMatch);
  const pipelineMatch = findPsPipelineKill(command);
  if (pipelineMatch) return blockedVerdict('ps-pipeline', pipelineMatch);
  const pidMatch = findProtectedPidKill(command, ctx);
  if (pidMatch) return blockedVerdict('protected-pid', pidMatch);
  return { blocked: false };
}
