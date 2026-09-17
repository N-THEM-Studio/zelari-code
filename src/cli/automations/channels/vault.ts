/**
 * automations/channels/vault.ts — per-channel credential vault (F3.3).
 *
 * One JSON file per channel under `~/.zelari-code/channels/<channel>.json`
 * (override the directory with ZELARI_CHANNELS_DIR — used by tests). Writes are
 * ATOMIC (temp file + rename) and best-effort `0600` (chmod is a no-op on NTFS —
 * never fatal). Secrets NEVER leave this module in logs: callers decide what to
 * print. Reusable for any channel that needs stored credentials.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Directory holding the vault files (env override for tests). */
export function channelsDir(): string {
  const env = process.env.ZELARI_CHANNELS_DIR?.trim();
  if (env) return env;
  return path.join(homedir(), '.zelari-code', 'channels');
}

/** Absolute path of the vault file for `channel`. */
export function vaultPath(channel: string): string {
  return path.join(channelsDir(), `${channel}.json`);
}

/** Read + JSON.parse the vault; `null` when the file is absent. Throws on bad JSON. */
export async function loadVault(channel: string): Promise<unknown | null> {
  const file = vaultPath(channel);
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(
      `vault file is malformed JSON: ${file} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/** Atomically write the vault (mkdir -p, temp+rename, best-effort 0600). */
export async function saveVault(channel: string, data: unknown): Promise<void> {
  const dir = channelsDir();
  await mkdir(dir, { recursive: true });
  const file = vaultPath(channel);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => undefined);
}

/** Remove the vault file (tolerant: absent ⇒ no-op). */
export async function removeVault(channel: string): Promise<void> {
  await rm(vaultPath(channel), { force: true }).catch(() => undefined);
}
