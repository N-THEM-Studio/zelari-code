/**
 * automations/browser/doctor.ts — one-command environment diagnostic.
 *
 * Borrowed from OpenBot's `dev:status`/`codex:doctor` pattern: a doctor that
 * answers "why does the browser flow not work?" WITHOUT starting a model turn
 * or posting anything. Checks, in order:
 *
 *   1. playwright  — does the module resolve in this tree?
 *   2. chromium    — does the Playwright browser executable exist on disk?
 *   3. selectors   — do x/facebook selectors JSON load?
 *   4. profiles    — does <homedir>/.zelari-code/browser-profiles/<ch> exist?
 *   5. processes   — LIVE chrome processes holding our profile dirs (the
 *                    zombie-lock that makes cookie files EBUSY and blocks
 *                    logins). Listed by default; killed only with --kill and
 *                    ONLY pids whose command line carries our profile marker.
 *   6. sessions    — (opt-in, --sessions) headless cookie login-state check.
 *
 * `ok` ⇔ no check failed (warnings allowed). Pure parsing helpers are exported
 * for unit tests; process listing/killing are injectable seams.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { promisify } from 'node:util';
import { loadPlaywright } from '../../browser/driver.js';
import { playwrightAvailable, profileDir } from './session.js';
import { checkLogin } from './session.js';
import { loadSelectors, SUPPORTED_CHANNELS } from './selectors.js';

const execFileAsync = promisify(execFile);

/** A live OS process whose command line pins one of our channel profiles. */
export interface ProfileProcess {
  pid: number;
  channel: string;
  cmd: string;
}

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checkedAt: string;
  checks: DoctorCheck[];
  processes: ProfileProcess[];
  killed: number[];
}

export interface DoctorDeps {
  cwd?: string;
  /** Run a listing command (injectable for tests). */
  run?: (prog: string, args: string[]) => Promise<{ stdout: string }>;
  /** Kill one pid (injectable for tests). */
  killer?: (pid: number) => Promise<void>;
  /** Headless cookie login-state per channel (default: real checkLogin). */
  sessions?: (channel: string, cwd?: string) => Promise<{ loggedIn: boolean; matched?: string }>;
  withSessions?: boolean;
  kill?: boolean;
  now?: () => string;
}

/** Parse `ps` output (pid + command per line) into {pid, cmd} pairs. */
export function parsePsOutput(raw: string): Array<{ pid: number; cmd: string }> {
  const out: Array<{ pid: number; cmd: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out;
}

/**
 * Parse the Windows `Get-CimInstance … ConvertTo-Json` payload. Tolerates the
 * three shapes PowerShell emits: empty string, one object, or an array.
 */
export function parseWindowsJson(raw: string): Array<{ pid: number; cmd: string }> {
  const text = raw.trim();
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : [data];
  return arr
    .map((e) => {
      const o = e as { ProcessId?: unknown; CommandLine?: unknown };
      const pid = Number(o.ProcessId);
      const cmd = typeof o.CommandLine === 'string' ? o.CommandLine : '';
      return { pid, cmd };
    })
    .filter((e) => Number.isFinite(e.pid) && e.pid > 0);
}

/**
 * Keep only entries whose command line pins one of OUR persistent profiles
 * (`.zelari-code` + `browser-profiles/<channel>`). Everything else — the
 * user's personal Chrome included — is never matched, listed, or killed.
 */
export function matchProfileProcesses(entries: Array<{ pid: number; cmd: string }>): ProfileProcess[] {
  const out: ProfileProcess[] = [];
  for (const e of entries) {
    const low = e.cmd.toLowerCase();
    if (!low.includes('.zelari-code') || !low.includes('browser-profiles')) continue;
    const ch = /browser-profiles[\\/]+([a-z0-9_-]+)/i.exec(e.cmd);
    if (!ch) continue;
    out.push({ pid: e.pid, channel: ch[1].toLowerCase(), cmd: e.cmd.slice(0, 160) });
  }
  return out;
}

async function listProcesses(run: NonNullable<DoctorDeps['run']>): Promise<ProfileProcess[]> {
  const plt = platform();
  let entries: Array<{ pid: number; cmd: string }> = [];
  if (plt === 'win32') {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
    ]);
    entries = parseWindowsJson(stdout);
  } else {
    const { stdout } = await run('ps', plt === 'darwin' ? ['-axo', 'pid=,command='] : ['-eo', 'pid=,args=']);
    entries = parsePsOutput(stdout);
  }
  return matchProfileProcesses(entries);
}

async function defaultKill(pid: number): Promise<void> {
  if (platform() === 'win32') {
    await execFileAsync('taskkill', ['/F', '/PID', String(pid)], { timeout: 10_000 });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

/** Human-readable rendering (one line per check + process table). */
export function formatDoctorReport(r: DoctorReport): string {
  const lines = [`doctor: ${r.ok ? 'OK' : 'PROBLEMS FOUND'} (${r.checkedAt})`];
  for (const c of r.checks) {
    lines.push(`  [${c.status.toUpperCase().padEnd(4)}] ${c.id}: ${c.detail}`);
  }
  if (r.processes.length > 0) {
    lines.push(`  live profile processes (chrome holding a channel profile):`);
    for (const p of r.processes) lines.push(`    pid ${p.pid}  channel=${p.channel}  ${p.cmd}`);
    lines.push(`    → run with --kill to terminate them (only these pids are touched)`);
  } else {
    lines.push('  live profile processes: none');
  }
  if (r.killed.length > 0) lines.push(`  killed pids: ${r.killed.join(', ')}`);
  return lines.join('\n');
}

/** Run the diagnostic. Never throws; failures become `fail` checks. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const run = deps.run ?? ((prog, args) => execFileAsync(prog, args, { timeout: 20_000 }));
  const killer = deps.killer ?? defaultKill;
  const cwd = deps.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  const hasPw = await playwrightAvailable(cwd);
  checks.push({
    id: 'playwright',
    status: hasPw ? 'ok' : 'fail',
    detail: hasPw ? 'module resolves' : 'not installed — `zelari-code --plugins-install playwright --cwd .`',
  });

  let exe = '';
  if (hasPw) {
    try {
      const pw = (await loadPlaywright(cwd)) as unknown as {
        chromium?: { executablePath?: () => string };
      } | null;
      exe = pw?.chromium?.executablePath?.() ?? '';
    } catch {
      exe = '';
    }
    const present = exe !== '' && existsSync(exe);
    checks.push({
      id: 'chromium',
      status: present ? 'ok' : 'fail',
      detail: present ? exe : 'browser executable missing — `npx playwright install chromium`',
    });
  }

  for (const ch of SUPPORTED_CHANNELS) {
    try {
      await loadSelectors(ch);
      checks.push({ id: `selectors:${ch}`, status: 'ok', detail: 'json loaded' });
    } catch (e) {
      checks.push({
        id: `selectors:${ch}`,
        status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    const dir = profileDir(ch);
    checks.push({
      id: `profile:${ch}`,
      status: existsSync(dir) ? 'ok' : 'warn',
      detail: existsSync(dir ? dir : dir) ? dir : `${dir} (not created yet — run \`automation login ${ch}\`)`,
    });
  }

  let processes: ProfileProcess[] = [];
  try {
    processes = await listProcesses(run);
  } catch (e) {
    checks.push({
      id: 'processes',
      status: 'warn',
      detail: `could not list processes: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (processes.length > 0 && !deps.kill) {
    checks.push({
      id: 'profile-lock',
      status: 'warn',
      detail: `${processes.length} chrome process(es) hold the profiles (EBUSY cookies / login blocked) — re-run with --kill`,
    });
  }

  const killed: number[] = [];
  if (deps.kill && processes.length > 0) {
    for (const p of processes) {
      try {
        await killer(p.pid);
        killed.push(p.pid);
      } catch {
        checks.push({ id: 'profile-lock', status: 'warn', detail: `could not kill pid ${p.pid}` });
      }
    }
  }

  if (deps.withSessions) {
    const sessions =
      deps.sessions ?? (async (ch: string, c?: string) => checkLogin(ch, { cwd: c }));
    for (const ch of SUPPORTED_CHANNELS) {
      if (!existsSync(profileDir(ch))) continue;
      try {
        const r = await sessions(ch, cwd);
        checks.push({
          id: `session:${ch}`,
          status: r.loggedIn ? 'ok' : 'warn',
          detail: r.loggedIn ? `logged-in${r.matched ? ` (${r.matched})` : ''}` : 'relogin_required',
        });
      } catch (e) {
        checks.push({
          id: `session:${ch}`,
          status: 'warn',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, checkedAt: (deps.now ?? (() => new Date().toISOString()))(), checks, processes, killed };
}
