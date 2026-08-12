/**
 * folderTrust.ts — persisted trusted-folder store (v1.32.0).
 *
 * Trust decides whether PROJECT-scoped MCP servers (`.zelari/mcp.json`) and
 * PROJECT-scoped lifecycle hooks (`.zelari/hooks/`) are loaded. User-global
 * config (`~/.zelari-code/…`) is ALWAYS active — trust gates project
 * self-execution, not the user's own machine config.
 *
 * Persistence: `~/.zelari-code/trust.json`
 *   { "folders": [{ "path": "Z:\\repo\\app", "trustedAt": "ISO" }] }
 *
 * Env override:
 *   ZELARI_FOLDER_TRUST=1          — trust every folder (CI / headless)
 *   ZELARI_FOLDER_TRUST=<path>     — trust exactly this folder
 *   ZELARI_FOLDER_TRUST=0          — trust nothing (strict lockdown)
 *
 * Matching is exact-path (case-insensitive on win32, after `path.resolve`).
 *
 * @since v1.32.0
 */

import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface TrustedFolder {
  path: string;
  trustedAt: string;
}

export interface TrustStoreFile {
  folders: TrustedFolder[];
}

const DEFAULT_STORE: TrustStoreFile = { folders: [] };

let _overrideStorePath: string | null = null;

function trustStorePath(): string {
  return _overrideStorePath ?? path.join(homedir(), '.zelari-code', 'trust.json');
}

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readStore(): TrustStoreFile {
  try {
    const raw = readFileSync(trustStorePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TrustStoreFile>;
    if (parsed && Array.isArray(parsed.folders)) return parsed as TrustStoreFile;
    return DEFAULT_STORE;
  } catch {
    return DEFAULT_STORE;
  }
}

function writeStore(store: TrustStoreFile): void {
  const p = trustStorePath();
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    // Never throw from a safety store write — fail visible via return value.
    throw new Error(
      `failed to persist trust store ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Parse ZELARI_FOLDER_TRUST: '1' → all, '0' → none, else one path. */
function envTrustedFolder(): string | null | 'all' | 'none' {
  const raw = process.env.ZELARI_FOLDER_TRUST?.trim();
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'all') return 'all';
  if (v === '0' || v === 'false' || v === 'no' || v === 'none') return 'none';
  return raw; // exact path
}

/** True if `folderPath` is trusted (env override first, then store). */
export function isFolderTrusted(folderPath: string): boolean {
  const env = envTrustedFolder();
  if (env === 'all') return true;
  if (env === 'none') return false;
  if (env) return normalize(env) === normalize(folderPath);

  const target = normalize(folderPath);
  return readStore().folders.some((f) => normalize(f.path) === target);
}

/** Trust a folder (idempotent). Returns the normalized stored path. */
export function trustFolder(folderPath: string): { ok: true; path: string } {
  const store = readStore();
  const normalized = path.resolve(folderPath);
  if (!store.folders.some((f) => normalize(f.path) === normalize(normalized))) {
    store.folders.push({ path: normalized, trustedAt: new Date().toISOString() });
    writeStore(store);
  }
  return { ok: true, path: normalized };
}

/** Remove trust for a folder. Returns true if it was present. */
export function untrustFolder(folderPath: string): { ok: boolean; removed: boolean } {
  const store = readStore();
  const target = normalize(folderPath);
  const before = store.folders.length;
  store.folders = store.folders.filter((f) => normalize(f.path) !== target);
  if (store.folders.length === before) return { ok: true, removed: false };
  writeStore(store);
  return { ok: true, removed: true };
}

/** List all trusted folders (env override surfaces as a single synthetic entry). */
export function listTrustedFolders(): TrustedFolder[] {
  const env = envTrustedFolder();
  if (env === 'all') {
    return [{ path: '<all>', trustedAt: 'env' }];
  }
  if (env) {
    return [{ path: env, trustedAt: 'env' }];
  }
  return readStore().folders;
}

/** Path of the trust store file (for inspect / diagnostics). */
export function getTrustStorePath(): string {
  return trustStorePath();
}

/** True if a trust store file exists on disk. */
export function hasTrustStore(): boolean {
  return existsSync(trustStorePath());
}

/** Convenience for tests: force a store file location. */
export function _setTrustStorePathForTests(p: string): void {
  _overrideStorePath = p;
}
