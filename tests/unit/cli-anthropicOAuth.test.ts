import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAnthropicPasteCode,
  buildAnthropicAuthorizeUrl,
  startAnthropicOAuth,
  completeAnthropicOAuth,
  refreshAnthropicToken,
  AnthropicOAuthError,
  ANTHROPIC_TOKEN_URL,
  DEFAULT_ANTHROPIC_CLIENT_ID,
} from '../../src/cli/anthropicOAuth.js';

describe('anthropicOAuth', () => {
  let pendingFile: string;
  let saved: string | undefined;

  beforeEach(() => {
    pendingFile = path.join(
      os.tmpdir(),
      `zelari-oauth-pending-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    saved = process.env.ANATHEMA_OAUTH_PENDING_FILE;
    process.env.ANATHEMA_OAUTH_PENDING_FILE = pendingFile;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.ANATHEMA_OAUTH_PENDING_FILE;
    else process.env.ANATHEMA_OAUTH_PENDING_FILE = saved;
    await fs.rm(pendingFile, { force: true });
  });

  it('parseAnthropicPasteCode splits CODE#STATE', () => {
    expect(parseAnthropicPasteCode('abc#def')).toEqual({ code: 'abc', state: 'def' });
    expect(parseAnthropicPasteCode('onlycode')).toEqual({ code: 'onlycode' });
    expect(parseAnthropicPasteCode('  "x#y"  ')).toEqual({ code: 'x', state: 'y' });
  });

  it('buildAnthropicAuthorizeUrl includes PKCE + magic-link flag', () => {
    const url = buildAnthropicAuthorizeUrl({
      clientId: DEFAULT_ANTHROPIC_CLIENT_ID,
      challenge: 'ch',
      state: 'st',
    });
    expect(url).toContain('code=true');
    expect(url).toContain('code_challenge=ch');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain(DEFAULT_ANTHROPIC_CLIENT_ID);
  });

  it('start then complete exchanges the pasted code', async () => {
    const started = await startAnthropicOAuth({ openBrowser: false });
    expect(started.authorizeUrl).toContain('claude.ai/oauth/authorize');

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(ANTHROPIC_TOKEN_URL);
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
      expect(payload.grant_type).toBe('authorization_code');
      expect(payload.code).toBe('authz');
      expect(payload.code_verifier).toBeTruthy();
      return new Response(
        JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const token = await completeAnthropicOAuth({
      pasteCode: `authz#${started.state}`,
      fetchImpl: fetchMock,
    });
    expect(token.accessToken).toBe('at');
    expect(token.refreshToken).toBe('rt');
  });

  it('complete without start throws no_pending', async () => {
    await expect(completeAnthropicOAuth({ pasteCode: 'x' })).rejects.toMatchObject({
      name: 'AnthropicOAuthError',
    });
  });

  it('refreshAnthropicToken posts refresh_token JSON', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
      expect(payload.grant_type).toBe('refresh_token');
      expect(payload.refresh_token).toBe('rt');
      return new Response(JSON.stringify({ access_token: 'new', expires_in: 10 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const result = await refreshAnthropicToken({ refreshToken: 'rt', fetchImpl: fetchMock });
    expect(result.accessToken).toBe('new');
    expect(result.refreshToken).toBe('rt');
  });

  it('refresh maps 400 to AnthropicOAuthError', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      refreshAnthropicToken({ refreshToken: 'bad', fetchImpl: fetchMock }),
    ).rejects.toBeInstanceOf(AnthropicOAuthError);
  });
});
