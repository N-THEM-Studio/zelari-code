/**
 * SSH target store — user config for deploy/monitor (Desktop + agent tools).
 * File: ~/.zelari-code/ssh-targets.json
 * Passwords: ~/.zelari-code/ssh-secrets.json (never returned to LLM / list JSON).
 * Private keys: paths only, never key bytes.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

export type SshAuthMode = 'agent' | 'keyPath' | 'password';

export interface SshTarget {
  id: string;
  name: string;
  host: string;
  port?: number;
  user: string;
  auth: SshAuthMode;
  /** Local path to private key (auth=keyPath). Never embed key bytes. */
  keyPath?: string;
  /**
   * Local path to public key (.pub) — for UI display / copy to server.
   * Not used for authentication (OpenSSH uses the private key).
   */
  publicKeyPath?: string;
  defaultRemotePath?: string;
  tags?: string[];
  /** Literals or prefix* globs allowed for ssh_run. Empty = status only. */
  allowedCommands?: string[];
  enabled?: boolean;
  notes?: string;
  /** UI only — set when listing; never stored. */
  hasPassword?: boolean;
}

/** Upsert payload may include one-shot password (stripped before target file write). */
export type SshTargetInput = SshTarget & { password?: string };

interface StoreFile {
  targets?: SshTarget[];
}

interface SecretsFile {
  passwords?: Record<string, string>;
}

export function getSshTargetsPath(): string {
  return join(homedir(), '.zelari-code', 'ssh-targets.json');
}

export function getSshSecretsPath(): string {
  return join(homedir(), '.zelari-code', 'ssh-secrets.json');
}

function normalizeAuth(auth: unknown): SshAuthMode {
  if (auth === 'keyPath') return 'keyPath';
  if (auth === 'password') return 'password';
  return 'agent';
}

function readSecrets(): SecretsFile {
  const path = getSshSecretsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SecretsFile;
  } catch {
    return {};
  }
}

function writeSecrets(data: SecretsFile): void {
  const path = getSshSecretsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may ignore mode; best-effort
  }
}

export function getSshPassword(id: string): string | undefined {
  const p = readSecrets().passwords?.[id];
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

export function hasSshPassword(id: string): boolean {
  return Boolean(getSshPassword(id));
}

export function setSshPassword(id: string, password: string): void {
  const data = readSecrets();
  const passwords = { ...(data.passwords ?? {}) };
  if (password) {
    passwords[id] = password;
  } else {
    delete passwords[id];
  }
  writeSecrets({ passwords });
}

export function deleteSshPassword(id: string): void {
  const data = readSecrets();
  if (!data.passwords?.[id]) return;
  const passwords = { ...data.passwords };
  delete passwords[id];
  writeSecrets({ passwords });
}

function readStore(): SshTarget[] {
  const path = getSshTargetsPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
    const list = Array.isArray(parsed.targets) ? parsed.targets : [];
    return list
      .filter(
        (t) =>
          t &&
          typeof t.id === 'string' &&
          typeof t.host === 'string' &&
          typeof t.user === 'string',
      )
      .map((t) => ({
        ...t,
        port: typeof t.port === 'number' ? t.port : 22,
        auth: normalizeAuth(t.auth),
        enabled: t.enabled !== false,
      }));
  } catch {
    return [];
  }
}

function writeStore(targets: SshTarget[]): void {
  const path = getSshTargetsPath();
  mkdirSync(dirname(path), { recursive: true });
  // Never persist hasPassword / password on target records
  const clean = targets.map(({ hasPassword: _hp, ...t }) => t);
  writeFileSync(
    path,
    `${JSON.stringify({ targets: clean }, null, 2)}\n`,
    'utf8',
  );
}

export function listSshTargets(): {
  path: string;
  targets: SshTarget[];
} {
  const targets = readStore().map((t) => ({
    ...t,
    hasPassword: t.auth === 'password' ? hasSshPassword(t.id) : false,
  }));
  return { path: getSshTargetsPath(), targets };
}

export function getSshTarget(id: string): SshTarget | undefined {
  return readStore().find((t) => t.id === id);
}

export function upsertSshTarget(
  target: SshTargetInput,
): { ok: true } | { ok: false; error: string } {
  const id = target.id?.trim();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return { ok: false, error: 'Invalid id (letters, digits, _ -)' };
  }
  if (!target.host?.trim() || !target.user?.trim()) {
    return { ok: false, error: 'host and user are required' };
  }
  const auth = normalizeAuth(target.auth);
  if (auth === 'keyPath' && !target.keyPath?.trim()) {
    return { ok: false, error: 'keyPath required when auth=keyPath' };
  }
  if (auth === 'password') {
    const incoming = target.password;
    if (typeof incoming === 'string' && incoming.length > 0) {
      setSshPassword(id, incoming);
    } else if (!hasSshPassword(id)) {
      return {
        ok: false,
        error: 'password required when auth=password (first save)',
      };
    }
  } else {
    deleteSshPassword(id);
  }

  const list = readStore().filter((t) => t.id !== id);
  list.push({
    id,
    name: target.name?.trim() || id,
    host: target.host.trim(),
    port: target.port && target.port > 0 ? target.port : 22,
    user: target.user.trim(),
    auth,
    keyPath: auth === 'keyPath' ? target.keyPath?.trim() : undefined,
    publicKeyPath:
      auth === 'password' ? undefined : target.publicKeyPath?.trim(),
    defaultRemotePath: target.defaultRemotePath?.trim(),
    tags: target.tags,
    allowedCommands: target.allowedCommands,
    enabled: target.enabled !== false,
    notes: target.notes,
  });
  list.sort((a, b) => a.id.localeCompare(b.id));
  writeStore(list);
  return { ok: true };
}

export function removeSshTarget(
  id: string,
): { ok: true } | { ok: false; error: string } {
  const list = readStore();
  if (!list.some((t) => t.id === id)) {
    return { ok: false, error: `Target "${id}" not found` };
  }
  writeStore(list.filter((t) => t.id !== id));
  deleteSshPassword(id);
  return { ok: true };
}

/** Build OpenSSH argv for a target (no remote command). */
export function buildSshBaseArgs(target: SshTarget): string[] {
  const args = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=12',
    '-p',
    String(target.port ?? 22),
  ];
  if (target.auth === 'password') {
    // BatchMode blocks password prompts; use SSH_ASKPASS instead.
    args.push(
      '-o',
      'BatchMode=no',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'NumberOfPasswordPrompts=1',
    );
  } else {
    args.push('-o', 'BatchMode=yes');
    if (target.auth === 'keyPath' && target.keyPath) {
      args.push('-i', target.keyPath);
    }
  }
  args.push(`${target.user}@${target.host}`);
  return args;
}

/**
 * Helper scripts for non-interactive password auth via SSH_ASKPASS.
 * Password is passed only in the child env (ZELARI_SSH_ASKPASS_PASS).
 */
function ensureAskpassHelper(): string {
  const dir = join(homedir(), '.zelari-code', 'ssh-helpers');
  mkdirSync(dir, { recursive: true });
  const cjs = join(dir, 'askpass.cjs');
  writeFileSync(
    cjs,
    "process.stdout.write(process.env.ZELARI_SSH_ASKPASS_PASS || '');\n",
    'utf8',
  );
  if (process.platform === 'win32') {
    const cmd = join(dir, 'askpass.cmd');
    writeFileSync(
      cmd,
      `@echo off\r\nnode "%~dp0askpass.cjs"\r\n`,
      'utf8',
    );
    return cmd;
  }
  const sh = join(dir, 'askpass.sh');
  writeFileSync(
    sh,
    `#!/bin/sh\nexec node "$(dirname "$0")/askpass.cjs"\n`,
    'utf8',
  );
  try {
    chmodSync(sh, 0o755);
  } catch {
    /* ignore */
  }
  return sh;
}

export function runSsh(
  target: SshTarget,
  remoteCommand: string,
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (target.auth === 'password' && !getSshPassword(target.id)) {
      resolve({
        code: 1,
        stdout: '',
        stderr:
          'No password stored for this target — edit target and set password',
      });
      return;
    }

    const args = [...buildSshBaseArgs(target), remoteCommand];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (target.auth === 'password') {
      const pass = getSshPassword(target.id)!;
      env.SSH_ASKPASS = ensureAskpassHelper();
      env.SSH_ASKPASS_REQUIRE = 'force';
      // OpenSSH uses askpass when DISPLAY is set and stdin is not a TTY
      if (!env.DISPLAY) env.DISPLAY = '1';
      env.ZELARI_SSH_ASKPASS_PASS = pass;
    }

    const child = spawn('ssh', args, {
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const cap = 40_000;
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        code: 124,
        stdout,
        stderr: stderr + '\n[ssh] timeout',
      });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: 127,
        stdout,
        stderr: err.message.includes('ENOENT')
          ? 'ssh not found on PATH — install OpenSSH client'
          : err.message,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Read public key text for display (never private key material).
 * Accepts a .pub path or a private key path (appends .pub).
 */
export function readSshPublicKey(
  keyOrPubPath: string,
): { ok: true; path: string; content: string } | { ok: false; error: string } {
  const raw = keyOrPubPath.trim().replace(/^["']|["']$/g, '');
  if (!raw) return { ok: false, error: 'Empty path' };
  const candidates = raw.endsWith('.pub')
    ? [raw]
    : [`${raw}.pub`, raw];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf8').trim();
      if (!content) continue;
      // Refuse obvious private key files
      if (/BEGIN .*PRIVATE KEY/i.test(content)) {
        return {
          ok: false,
          error: 'Path points to a private key — use the .pub file instead',
        };
      }
      return { ok: true, path: p, content };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return {
    ok: false,
    error: `Public key not found (tried: ${candidates.join(', ')})`,
  };
}

export async function testSshTarget(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const t = getSshTarget(id);
  if (!t) return { ok: false, message: `Target "${id}" not found` };
  if (t.enabled === false) {
    return { ok: false, message: `Target "${id}" is disabled` };
  }
  if (t.auth === 'password' && !hasSshPassword(id)) {
    return {
      ok: false,
      message: 'Password auth selected but no password saved — edit target',
    };
  }
  const r = await runSsh(t, 'true', 15_000);
  if (r.code === 0) {
    return { ok: true, message: `OK ${t.user}@${t.host}:${t.port ?? 22}` };
  }
  return {
    ok: false,
    message: (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 400),
  };
}

/** Safe summary for LLM context (no key paths, no passwords). */
export function formatSshTargetsForPrompt(): string {
  const targets = readStore().filter((t) => t.enabled !== false);
  if (targets.length === 0) return '';
  const lines = [
    '# Configured SSH targets',
    'Use tools ssh_status / ssh_run with targetId. Do not invent hosts.',
  ];
  for (const t of targets) {
    const tags = t.tags?.length ? ` tags=[${t.tags.join(',')}]` : '';
    const path = t.defaultRemotePath ? ` remotePath=${t.defaultRemotePath}` : '';
    const allow = t.allowedCommands?.length
      ? ` allowed=${t.allowedCommands.join('|')}`
      : ' allowed=status-only';
    const auth =
      t.auth === 'password'
        ? ' auth=password'
        : t.auth === 'keyPath'
          ? ' auth=key'
          : ' auth=agent';
    lines.push(
      `- id=${t.id} name=${t.name} ${t.user}@${t.host}:${t.port ?? 22}${auth}${path}${tags}${allow}`,
    );
  }
  return lines.join('\n');
}

/**
 * Allow ssh_run command: exact match or prefix* glob in allowedCommands.
 * Dangerous metacharacters rejected unless the whole command is exactly allowlisted.
 */
export function isSshCommandAllowed(
  target: SshTarget,
  command: string,
): { ok: true } | { ok: false; error: string } {
  const cmd = command.trim();
  if (!cmd) return { ok: false, error: 'empty command' };
  const list = target.allowedCommands ?? [];
  if (list.length === 0) {
    return {
      ok: false,
      error:
        'No allowedCommands on this target — only ssh_status is permitted. Add allowlist entries in Settings → Connections.',
    };
  }
  const dangerous = /[;&|`$(){}<>]|\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=/i;
  for (const pattern of list) {
    const p = pattern.trim();
    if (!p) continue;
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      if (cmd.startsWith(prefix)) {
        if (dangerous.test(cmd)) {
          return {
            ok: false,
            error: 'Command contains blocked shell metacharacters',
          };
        }
        return { ok: true };
      }
    } else if (cmd === p) {
      // Exact allowlist may include intentional operators; still block rm -rf etc.
      if (/\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=/i.test(cmd)) {
        return { ok: false, error: 'Command blocked for safety' };
      }
      return { ok: true };
    }
  }
  return {
    ok: false,
    error: `Command not in allowlist. Allowed: ${list.join(', ')}`,
  };
}
