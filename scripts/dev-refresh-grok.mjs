#!/usr/bin/env node
/**
 * dev-refresh-grok — Refresh the SuperGrok OAuth access token using the
 * stored refresh_token. Persists the new access_token (and any rotated
 * refresh_token) to the keyStore so subsequent runs work without re-login.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { refreshGrokToken } from '../dist/cli/grokOAuth.js';
import { setOAuthToken } from '../dist/cli/keyStore.js';

const KEYS_PATH = '/home/showtimez/.tmp/zelari-code/keys.json';
const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8'));
const old = keys.providers?.grok;
if (!old || !old.refreshToken) {
  console.error('\x1b[31m✗ No refresh token stored. Run /login grok first.\x1b[0m');
  process.exit(1);
}

console.log(`\x1b[36m[refresh]\x1b[0m Old access token: ${old.apiKey.slice(0, 12)}… (expires ${new Date(old.expiresAt).toISOString()})`);
console.log(`\x1b[36m[refresh]\x1b[0m Old refresh token: ${old.refreshToken.slice(0, 12)}…`);

const result = await refreshGrokToken({
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  refreshToken: old.refreshToken,
});

console.log(`\x1b[32m✓\x1b[0m New access token: ${result.accessToken.slice(0, 12)}…`);
if (result.expiresAt) console.log(`  Expires: ${new Date(result.expiresAt).toISOString()}`);
if (result.refreshToken) {
  console.log(`  Refresh token: ${result.refreshToken.slice(0, 12)}… (rotated)`);
}

setOAuthToken('grok', {
  apiKey: result.accessToken,
  ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
  ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
});
console.log('\x1b[32m✓\x1b[0m Token saved to keyStore.');