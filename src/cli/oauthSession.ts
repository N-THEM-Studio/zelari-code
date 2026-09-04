/**
 * oauthSession — persist PKCE verifier between Anthropic magic-link start/complete.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { oauthPendingPath } from './paths.js';

export interface PendingOAuth {
  provider: string;
  codeVerifier: string;
  state: string;
  createdAt: number;
}

const MAX_AGE_MS = 15 * 60_000;

export function getPendingOAuthPath(): string {
  return oauthPendingPath();
}

export function savePendingOAuth(pending: PendingOAuth): void {
  const file = getPendingOAuthPath();
  mkdirSync(path.dirname(file), { recursive: true });
  let all: Record<string, PendingOAuth> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, PendingOAuth>;
      if (parsed && typeof parsed === 'object') all = parsed;
    } catch {
      all = {};
    }
  }
  all[pending.provider] = pending;
  writeFileSync(file, JSON.stringify(all, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function takePendingOAuth(provider: string): PendingOAuth | null {
  const file = getPendingOAuthPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, PendingOAuth>;
    const entry = parsed?.[provider];
    if (!entry || typeof entry.codeVerifier !== 'string') return null;
    delete parsed[provider];
    writeFileSync(file, JSON.stringify(parsed, null, 2), { encoding: 'utf-8', mode: 0o600 });
    if (Date.now() - entry.createdAt > MAX_AGE_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

export function clearPendingOAuthFile(): void {
  const file = getPendingOAuthPath();
  if (existsSync(file)) unlinkSync(file);
}
