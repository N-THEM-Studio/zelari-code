/**
 * cookieDisk.ts — login-state from the Chromium cookie DB WITHOUT launching a
 * browser. Desktop used to poll `automation health` every 30s, which spawned
 * Chromium on the same persistent profile and raced the cookie store
 * (false `relogin_required`, locked profiles, failed publishes).
 *
 * Cookie *names* are plaintext in Chromium's SQLite even when values are
 * encrypted. Presence of the channel's auth cookies is enough for health.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type DiskCookieProbe = 'present' | 'missing' | 'locked' | 'absent';

export type CookieFileReader = (filePath: string) => Promise<Buffer>;

/** Chromium cookie DB locations under a persistent profile directory. */
export function cookieDbCandidates(profile: string): string[] {
  return [
    path.join(profile, 'Default', 'Network', 'Cookies'),
    path.join(profile, 'Default', 'Cookies'),
  ];
}

function isLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function containsName(haystack: Buffer, name: string): boolean {
  return haystack.includes(Buffer.from(name, 'utf8'));
}

/**
 * Probe auth-cookie names in the profile's cookie DB.
 * - present: every `wanted` name is in the file
 * - missing: a cookie DB exists but at least one name is absent
 * - locked: Chromium has the file open (do NOT report logged-out)
 * - absent: no cookie DB yet (fresh profile)
 */
export async function probeSessionCookiesOnDisk(
  profile: string,
  wanted: readonly string[],
  read: CookieFileReader = (p) => readFile(p),
): Promise<DiskCookieProbe> {
  if (wanted.length === 0) return 'absent';
  let sawFile = false;
  for (const file of cookieDbCandidates(profile)) {
    try {
      const buf = await read(file);
      sawFile = true;
      if (wanted.every((n) => containsName(buf, n))) return 'present';
      return 'missing';
    } catch (err) {
      if (isLockError(err)) return 'locked';
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') continue;
      throw err;
    }
  }
  return sawFile ? 'missing' : 'absent';
}
