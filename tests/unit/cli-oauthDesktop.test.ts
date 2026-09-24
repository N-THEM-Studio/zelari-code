import { describe, it, expect } from 'vitest';
import {
  parseLoginOAuthFlags,
  parseProviderOnlyFlag,
  wantsLoginOAuth,
  wantsLogoutOAuth,
  wantsRefreshOAuth,
} from '../../src/cli/desktopConfig.js';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

describe('desktop OAuth flags', () => {
  it('detects --login-oauth / --refresh-oauth / --logout-oauth', () => {
    expect(wantsLoginOAuth(['--login-oauth'])).toBe(true);
    expect(wantsRefreshOAuth(['--refresh-oauth'])).toBe(true);
    expect(wantsLogoutOAuth(['--logout-oauth'])).toBe(true);
  });

  it('parseLoginOAuthFlags requires provider', () => {
    const r = parseLoginOAuthFlags(['--login-oauth']);
    expect(r.request).toBeNull();
    expect(r.error).toMatch(/provider/);
  });

  it('parseLoginOAuthFlags reads provider + code + no-browser', () => {
    const r = parseLoginOAuthFlags([
      '--login-oauth',
      '--provider',
      'anthropic',
      '--code',
      'ABC#ST',
      '--no-browser',
    ]);
    expect(r.error).toBeUndefined();
    expect(r.request).toEqual({
      provider: 'anthropic',
      code: 'ABC#ST',
      noBrowser: true,
    });
  });

  it('parseProviderOnlyFlag requires --provider', () => {
    const r = parseProviderOnlyFlag(['--refresh-oauth'], '--refresh-oauth');
    expect(r.present).toBe(true);
    expect(r.error).toMatch(/provider/);
  });
});

describe('slash /login oauth providers', () => {
  it('/login chatgpt without key starts OAuth', () => {
    const r = handleSlashCommand('/login chatgpt', []);
    expect(r.kind).toBe('login_oauth');
    expect(r.provider).toBe('chatgpt');
  });

  it('/login anthropic without key starts OAuth', () => {
    const r = handleSlashCommand('/login anthropic', []);
    expect(r.kind).toBe('login_oauth');
    expect(r.provider).toBe('anthropic');
  });

  it('/login anthropic CODE#STATE completes OAuth (not treated as API key)', () => {
    const r = handleSlashCommand('/login anthropic abcdef#state', []);
    expect(r.kind).toBe('login_oauth');
    expect(r.loginKey).toBe('abcdef#state');
  });

  it('/login anthropic sk-ant-... stores an API key', () => {
    const r = handleSlashCommand('/login anthropic sk-ant-secret', []);
    expect(r.kind).toBe('login');
    expect(r.loginKey).toBe('sk-ant-secret');
  });

  it('/login muse without key starts OAuth (CLI-session import or device flow)', () => {
    const r = handleSlashCommand('/login muse', []);
    expect(r.kind).toBe('login_oauth');
    expect(r.provider).toBe('muse');
  });

  it('/login muse LLM|... stores a Meta Model API key (not a device flow)', () => {
    const r = handleSlashCommand('/login muse LLM|secret', []);
    expect(r.kind).toBe('login');
    expect(r.loginKey).toBe('LLM|secret');
  });

  it('/login muse dca:... paste completes OAuth via mint (loginKey passed through)', () => {
    const r = handleSlashCommand('/login muse dca:oidc-token', []);
    expect(r.kind).toBe('login_oauth');
    expect(r.provider).toBe('muse');
    expect(r.loginKey).toBe('dca:oidc-token');
  });
});
