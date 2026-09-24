/**
 * cli-unselectedProviderRouting.test.ts — no call may reach a provider the
 * user did not select (2026-09-24: random HTTP 404s from "default grok").
 *
 * Root causes pinned here:
 *   1. auxiliary calls (embeddings, verdict re-ask, weakness meter) resolved
 *      the PERSISTED active provider — built-in default `openai-compatible`,
 *      base URL api.x.ai, model grok-4.6 — instead of the turn's provider;
 *   2. re-ask / meter fell back to api.openai.com (and used a custom BASE url
 *      as the full endpoint) with the active provider's key;
 *   3. cross-family verify routed to any provider ever discovered, including
 *      one whose login had expired;
 *   4. the Desktop sidecar resolved provider/model/key once per process,
 *      ignoring the per-turn selection and never refreshing an OAuth token.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasFreshCredentials, setOAuthToken } from '../../src/cli/keyStore.js';
import { usableFamilyCandidates, isProviderAccessError } from '../../src/cli/tools/krakenModel.js';
import { chatCompletionsUrlFor, providerFromEnv, supportsOpenAiEmbeddings } from '../../src/cli/provider/openai-compatible.js';
import { setTurnProvider } from '../../src/cli/provider/turnProvider.js';
import { reaskVerifyTrailer } from '../../src/cli/kraken/verifyReask.js';
import { resolveServedTurnStream } from '../../src/cli/serve/harnessServer.js';
import type { HeadlessOptions } from '../../src/cli/headless.js';

const ENV_KEYS = [
  'ANATHEMA_KEYSTORE_FILE',
  'ANATHEMA_PROVIDER_CONFIG_FILE',
  'ANATHEMA_ACTIVE_PROVIDER',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'GROK_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'CHATGPT_API_KEY',
  'ZELARI_VERIFY_REASK',
] as const;
let saved: Record<string, string | undefined> = {};
let dir = '';

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-unselected-'));
  process.env.ANATHEMA_KEYSTORE_FILE = path.join(dir, 'keys.json');
  process.env.ANATHEMA_PROVIDER_CONFIG_FILE = path.join(dir, 'provider.json');
});

afterEach(async () => {
  setTurnProvider(undefined);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(dir, { recursive: true, force: true });
});

describe('hasFreshCredentials — pure, no refresh', () => {
  it('env key, non-expiring stored key and a live token are usable', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    expect(hasFreshCredentials('deepseek')).toBe(true);
    setOAuthToken('glm', { apiKey: 'k' });
    expect(hasFreshCredentials('glm')).toBe(true);
    setOAuthToken('grok', { apiKey: 't', expiresAt: Date.now() + 3_600_000 });
    expect(hasFreshCredentials('grok')).toBe(true);
  });

  it('an expired (or about-to-expire) token and a missing one are not', () => {
    setOAuthToken('grok', { apiKey: 't', expiresAt: Date.now() - 1_000, refreshToken: 'r' });
    expect(hasFreshCredentials('grok')).toBe(false);
    setOAuthToken('chatgpt', { apiKey: 't', expiresAt: Date.now() + 5_000 });
    expect(hasFreshCredentials('chatgpt')).toBe(false);
    expect(hasFreshCredentials('muse')).toBe(false);
  });
});

describe('cross-family verify candidates', () => {
  it('drops providers without fresh credentials, checking each provider once', () => {
    const calls: string[] = [];
    const out = usableFamilyCandidates(
      [
        { provider: 'grok', model: 'grok-4' },
        { provider: 'grok', model: 'grok-4-mini' },
        { provider: 'glm', model: 'glm-5.3' },
      ],
      (p) => {
        calls.push(p);
        return p !== 'grok';
      },
    );
    expect(out).toEqual([{ provider: 'glm', model: 'glm-5.3' }]);
    expect(calls).toEqual(['grok', 'glm']);
  });

  it('a throwing credential check counts as unusable', () => {
    expect(usableFamilyCandidates([{ provider: 'x', model: 'm' }], () => { throw new Error('boom'); })).toEqual([]);
  });

  it('recognises provider access failures (auth, 404, unreachable) — not generic errors', () => {
    expect(isProviderAccessError('HTTP 404: {"error":"not found"}')).toBe(true);
    expect(isProviderAccessError('HTTP 401: invalid token')).toBe(true);
    expect(isProviderAccessError('Network error: getaddrinfo ENOTFOUND api.x.ai')).toBe(true);
    expect(isProviderAccessError('token expired')).toBe(true);
    expect(isProviderAccessError('HTTP 500: upstream error')).toBe(false);
    expect(isProviderAccessError('tool_args_parse_failed: …')).toBe(false);
    expect(isProviderAccessError(undefined)).toBe(false);
  });
});

describe('the turn provider wins over the provider.json default', () => {
  it('providerFromEnv resolves the turn provider/model, not openai-compatible@api.x.ai', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deep';
    process.env.GROK_API_KEY = 'xai-should-not-be-used';
    setTurnProvider({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    const cfg = await providerFromEnv();
    expect(cfg?.providerId).toBe('deepseek');
    expect(cfg?.model).toBe('deepseek-v4-pro');
    expect(cfg?.baseUrl).not.toContain('x.ai');
  });

  it('without a turn provider the persisted active provider is used (TUI unchanged)', async () => {
    process.env.OPENAI_API_KEY = 'sk-oa';
    const cfg = await providerFromEnv();
    expect(cfg?.providerId).toBe('openai-compatible');
  });

  it('an unknown turn provider id (e.g. local-cli) falls back to the active provider', async () => {
    setTurnProvider({ provider: 'local-cli', model: 'x' });
    const cfg = await providerFromEnv();
    expect(cfg === null || cfg.providerId === 'openai-compatible').toBe(true);
  });
});

describe('hand-rolled chat-completions calls never leave the provider', () => {
  it('chatCompletionsUrlFor: real /chat/completions, or null for other protocols', () => {
    expect(chatCompletionsUrlFor({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com' })).toBe(
      'https://api.deepseek.com/chat/completions',
    );
    expect(chatCompletionsUrlFor({ providerId: 'custom', baseUrl: 'http://localhost:11434/v1/' })).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
    for (const providerId of ['chatgpt', 'anthropic', 'muse']) {
      expect(chatCompletionsUrlFor({ providerId: providerId as never, baseUrl: 'https://x' })).toBeNull();
    }
    expect(supportsOpenAiEmbeddings('muse')).toBe(false);
    expect(supportsOpenAiEmbeddings('glm')).toBe(true);
  });

  it('verdict re-ask posts to the TURN provider endpoint with its key', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deep';
    process.env.GROK_API_KEY = 'xai-should-not-be-used';
    setTurnProvider({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    const seen: Array<{ url: string; auth: string; model: string }> = [];
    const verdict = await reaskVerifyTrailer('report without trailer', {
      fetchImpl: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { model: string };
        seen.push({ url, auth: String((init.headers as Record<string, string>).Authorization), model: body.model });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'VERDICT: PASS' } }] }), { status: 200 });
      }) as never,
    });
    expect(verdict).toBe('pass');
    expect(seen).toEqual([
      { url: 'https://api.deepseek.com/chat/completions', auth: 'Bearer sk-deep', model: 'deepseek-v4-pro' },
    ]);
  });

  it('verdict re-ask makes NO call when the turn provider is not chat-completions', async () => {
    process.env.CHATGPT_API_KEY = 'oauth';
    setTurnProvider({ provider: 'chatgpt', model: 'gpt-5.6-codex' });
    let called = false;
    const verdict = await reaskVerifyTrailer('report', {
      fetchImpl: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as never,
    });
    expect(verdict).toBeNull();
    expect(called).toBe(false);
  });
});

describe('Desktop sidecar — provider resolved per turn', () => {
  it('honors the turn provider/model instead of the provider.json default', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deep';
    const turn = await resolveServedTurnStream({ task: 't', provider: 'deepseek', model: 'deepseek-v4-flash' } as HeadlessOptions);
    expect(turn.provider).toBe('deepseek');
    expect(turn.model).toBe('deepseek-v4-flash');
  });

  it('fails loudly (no silent fallback to another provider) when the turn provider has no key', async () => {
    process.env.GROK_API_KEY = 'xai';
    await expect(
      resolveServedTurnStream({ task: 't', provider: 'deepseek', model: 'deepseek-v4-pro' } as HeadlessOptions),
    ).rejects.toThrow(/no API key for provider 'deepseek'/);
  });
});
