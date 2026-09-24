import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MUSE_BASE_URL,
  readMuseCliAuth,
  runMuseOAuthFlow,
} from '../../src/cli/museOAuth.js';
import { responsesApiProvider } from '../../src/cli/provider/responsesApi.js';

/**
 * LIVE smoke test — Meta "Muse / Code plan" login → models respond.
 *
 * Opt-in only, never runs in CI (`npm test` stays hermetic):
 *
 *   ZELARI_MUSE_LIVE=1 npx vitest run tests/unit/cli-museOAuth.live.test.ts
 *
 * Requires a real official-CLI session (`muse login` →
 * `~/.config/muse/auth.json`, or point `MUSE_CONFIG_DIR` at one).
 */
const live = process.env.ZELARI_MUSE_LIVE === '1';

describe.skipIf(!live)('muse live: login → models respond', () => {
  it('imports the official muse CLI session without a device flow', { timeout: 60_000 }, async () => {
    expect(
      readMuseCliAuth(),
      'no `muse login` session found — run the official CLI first (or set MUSE_CONFIG_DIR)',
    ).not.toBeNull();
    const token = await runMuseOAuthFlow();
    expect(token.accessToken.length).toBeGreaterThan(0);
  });

  it('lists models and streams a completion through the zelari transport', { timeout: 180_000 }, async () => {
    const token = await runMuseOAuthFlow();
    const base = (token.baseUrl ?? DEFAULT_MUSE_BASE_URL).replace(/\/$/, '');

    const modelsRes = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    expect(modelsRes.ok, `GET /models → HTTP ${modelsRes.status}`).toBe(true);
    const models = ((await modelsRes.json()) as { data?: { id: string }[] }).data ?? [];
    expect(models.length).toBeGreaterThan(0);

    // Same transport resolveStream routes muse to: responsesApiProvider
    // (POST {base}/responses, stream: true, Bearer key, SSE deltas).
    const ids = models.map((m) => m.id);
    const model = ids.includes('muse-spark-1.3') ? 'muse-spark-1.3' : ids[0]!;
    const stream = responsesApiProvider({
      apiKey: token.accessToken,
      baseUrl: base,
      model,
      providerId: 'muse',
    });
    let text = '';
    let finished = false;
    let streamError: string | undefined;
    for await (const delta of stream({
      messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
      model,
      provider: 'muse',
      tools: [],
    })) {
      if (delta.kind === 'text') text += delta.delta;
      else if (delta.kind === 'finish') finished = true;
      else if (delta.kind === 'error') streamError = delta.message;
    }
    expect(streamError, `model "${model}" must not error after login`).toBeUndefined();
    expect(finished, `model "${model}" must finish its stream`).toBe(true);
    expect(text.trim().length, `model "${model}" must produce text`).toBeGreaterThan(0);
  });

  // 2026-09-24 muse incident: tentacle tool calls reached the tool with `{}`.
  // A real tool call must carry its arguments end-to-end through the adapter.
  it('streams a tool call WITH its arguments (tentacle regression)', { timeout: 180_000 }, async () => {
    const token = await runMuseOAuthFlow();
    const base = (token.baseUrl ?? DEFAULT_MUSE_BASE_URL).replace(/\/$/, '');
    const model = process.env.ZELARI_MUSE_LIVE_MODEL ?? 'muse-spark-1.3';
    const stream = responsesApiProvider({ apiKey: token.accessToken, baseUrl: base, model, providerId: 'muse' });
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const errors: string[] = [];
    for await (const delta of stream({
      messages: [
        { role: 'user', content: 'Call the read_file tool once with path "package.json". Do not answer in text.' },
      ],
      model,
      provider: 'muse',
      tools: [
        {
          name: 'read_file',
          description: 'Read a UTF-8 file from the workspace.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative path' } },
            required: ['path'],
          },
        },
      ],
    })) {
      if (delta.kind === 'tool_call') calls.push({ toolName: delta.toolName, args: delta.args });
      else if (delta.kind === 'error') errors.push(delta.message);
    }
    expect(errors, 'no tool_args_missing / parse errors').toEqual([]);
    expect(calls.length, `model "${model}" must emit a tool call`).toBeGreaterThan(0);
    expect(calls[0]!.toolName).toBe('read_file');
    expect(calls[0]!.args.path, 'args must survive the stream').toBe('package.json');
  });
});
