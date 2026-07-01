#!/usr/bin/env node
/**
 * dev-login-grok — Manual helper to run the xAI SuperGrok Device
 * Authorization Grant flow without going through the TUI.
 *
 * Mirrors the logic in src/cli/app.tsx (the `login_oauth` handler), but
 * prints the user_code + verification_uri on stdout + a log file so they
 * can be captured in non-TTY environments (CI, agents, remote shells).
 *
 * Usage:
 *   node scripts/dev-login-grok.mjs
 *
 * The OAuth token (access + refresh + expiry) is saved to the same
 * keyStore the CLI uses.
 */

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { runGrokOAuthFlow } from '../dist/cli/grokOAuth.js';
import { setOAuthToken } from '../dist/cli/keyStore.js';
import {
  setActiveProviderId,
  setModelForProvider,
  getProviderConfig,
} from '../dist/cli/providerConfig.js';

const LOG_DIR = join(homedir(), '.tmp', 'zelari-code');
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, 'dev-login-grok.log');

// Truncate log on start so each run shows only its own output.
writeFileSync(LOG_FILE, '');

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  appendFileSync(LOG_FILE, line);
};
const banner = (s) => log(`\n\x1b[36m[login-grok]\x1b[0m ${s}`);

banner('Requesting device code from xAI...');

const result = await runGrokOAuthFlow({
  onUserCode: (info) => {
    log('');
    banner('GOT DEVICE CODE — present this to the user:');
    log('');
    log(`  Visit:   ${info.verificationUri}`);
    if (info.verificationUriComplete) {
      log(`  Direct:  ${info.verificationUriComplete}  (code pre-filled)`);
    }
    log(`  Code:    ${info.userCode}`);
    log('');
    log(`  expires_in=${info.expiresIn}s, interval=${info.interval}s`);
    log('');
  },
});

banner('✓ Authorization successful — saving token...');

setOAuthToken('grok', {
  apiKey: result.accessToken,
  ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
  ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
});
setActiveProviderId('grok');

if (!getProviderConfig().modelForProvider?.grok) {
  setModelForProvider('grok', 'grok-4');
}

const mask = (t) => t.slice(0, 8) + '…' + t.slice(-4);
banner('✓ Grok OAuth token saved.');
log(`  Access token: ${mask(result.accessToken)}`);
if (result.expiresAt) {
  log(`  Expires:      ${new Date(result.expiresAt).toISOString()}`);
}
if (result.refreshToken) {
  log(`  Refresh:      ${mask(result.refreshToken)} (saved for auto-refresh)`);
}
log(`  Active provider: grok`);
log(`  Model:           ${getProviderConfig().modelForProvider?.grok ?? 'grok-4'}`);
banner('Done. You can now run \`zelari-code\` and prompt normally.');
log(`Log saved to: ${LOG_FILE}`);