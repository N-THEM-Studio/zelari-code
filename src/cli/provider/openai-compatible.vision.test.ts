import { describe, it, expect, afterEach } from 'vitest';
import {
  openaiCompatibleProvider,
  modelSupportsVision,
  dataUriFromImage,
  glmModelLooksVision,
  isGlmCodingEndpoint,
  isTextOnlyContentRejection,
  resetTextOnlyVisionMemory,
} from './openai-compatible.js';
import type { AgentMessage } from '@zelari/core/harness';
import type { ProviderName } from '../keyStore.js';

/**
 * Vision stays ON by default so a Grok lead still gets screenshots.
 * GLM chat/coding (glm-5.3, `/api/coding/`) is text-only on the wire
 * (`image_url` → HTTP 400 code 1210). Tool-result pixels ride a synthetic
 * user message after the last consecutive tool result.
 */

const img = (name: string): { mime: string; dataBase64: string; alt: string } => ({
  mime: 'image/png',
  dataBase64: Buffer.from(`png-bytes-${name}`).toString('base64'),
  alt: name,
});

describe('modelSupportsVision (default ON, GLM chat text-only)', () => {
  afterEach(() => {
    delete process.env.ZELARI_VISION;
    resetTextOnlyVisionMemory();
  });

  it('is ON for unknown/new model names and Grok (lead may be vision)', () => {
    expect(modelSupportsVision('openai/gpt-6-astra')).toBe(true);
    expect(modelSupportsVision('grok-4.6')).toBe(true);
    expect(modelSupportsVision('deepseek-v4-flash')).toBe(true);
    expect(modelSupportsVision('totally-unknown-model')).toBe(true);
  });

  it('GLM non-vision chat models are text-only (glm-5.3 coding lead)', () => {
    expect(modelSupportsVision('glm-5.3')).toBe(false);
    expect(modelSupportsVision('glm-5.3-flash')).toBe(false);
    expect(modelSupportsVision('glm-4.5')).toBe(false);
    expect(glmModelLooksVision('glm-5.3')).toBe(false);
    expect(glmModelLooksVision('glm-4.5v')).toBe(true);
    expect(glmModelLooksVision('glm-4v-flash')).toBe(true);
    expect(modelSupportsVision('glm-4.5v')).toBe(true);
    expect(modelSupportsVision('glm-4v-flash')).toBe(true);
  });

  it('GLM coding-plan URLs are text-only even for vision SKUs', () => {
    expect(isGlmCodingEndpoint('https://api.z.ai/api/coding/paas/v4')).toBe(true);
    expect(isGlmCodingEndpoint('https://api.z.ai/api/paas/v4')).toBe(false);
    expect(
      modelSupportsVision('glm-4.5v', {
        providerId: 'glm',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      }),
    ).toBe(false);
  });

  it('ZELARI_VISION=0 opts out; =1 forces pixels on glm-5.3', () => {
    process.env.ZELARI_VISION = '0';
    expect(modelSupportsVision('gpt-4o')).toBe(false);
    process.env.ZELARI_VISION = 'off';
    expect(modelSupportsVision('anything')).toBe(false);
    process.env.ZELARI_VISION = '1';
    expect(modelSupportsVision('glm-5.3')).toBe(true);
  });

  it('detects Z.AI 1210 text-only content rejections', () => {
    expect(
      isTextOnlyContentRejection(
        400,
        '{"error":{"code":"1210","message":"messages.content.type is invalid, allowed values: [\'text\']"}}',
      ),
    ).toBe(true);
    expect(
      isTextOnlyContentRejection(
        400,
        '{"error":{"code":"1210","message":"该模型始终思考，不支持关闭思考"}}',
      ),
    ).toBe(false);
    expect(isTextOnlyContentRejection(429, '{"error":{"code":"1210"}}')).toBe(false);
  });
});

/** Consume the provider stream with a stubbed fetch capturing the request body. */
async function captureRequestBody(
  messages: AgentMessage[],
  model = 'test-model',
  providerId: ProviderName = 'custom',
  baseUrl = 'http://localhost:1/v1',
): Promise<unknown[]> {
  const bodies: unknown[] = [];
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const provider = openaiCompatibleProvider({
      apiKey: 'test',
      baseUrl,
      model,
      providerId,
    });
    for await (const _delta of provider({
      messages,
      tools: [],
      model,
      signal: new AbortController().signal,
    } as Parameters<typeof provider>[0])) {
      void _delta;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(bodies.length).toBe(1);
  return (bodies[0] as { messages: unknown[] }).messages;
}

describe('tool-result images → follow-up user message', () => {
  afterEach(() => {
    delete process.env.ZELARI_VISION;
    resetTextOnlyVisionMemory();
  });

  it('injects ONE user message with image blocks after the tool run', async () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'guarda lo schermo' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'screenshot', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: '{ "ok": true, "path": "shot.png" }', images: [img('shot.png')] },
    ];
    const out = (await captureRequestBody(msgs)) as Array<{ role: string; content: unknown }>;
    expect(out.length).toBe(4);
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: expect.any(String) });
    const followUp = out[3]!;
    expect(followUp.role).toBe('user');
    const parts = followUp.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[0]!.type).toBe('text');
    expect(parts[1]!.type).toBe('image_url');
    expect(parts[1]!.image_url!.url).toBe(dataUriFromImage(img('shot.png')));
  });

  it('accumulates images from consecutive tool results into one follow-up', async () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', toolCalls: [
        { id: 'c1', name: 'a', args: {} },
        { id: 'c2', name: 'b', args: {} },
      ] },
      { role: 'tool', toolCallId: 'c1', content: 'r1', images: [img('one.png')] },
      { role: 'tool', toolCallId: 'c2', content: 'r2', images: [img('two.png')] },
      { role: 'assistant', content: 'done' },
    ];
    const out = (await captureRequestBody(msgs)) as Array<{ role: string; content: unknown }>;
    // tool r1 → tool r2 → follow-up(user, 2 images) → assistant
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    const parts = out[4]!.content as Array<{ type: string }>;
    expect(parts.filter((p) => p.type === 'image_url').length).toBe(2);
  });

  it('ZELARI_VISION=0 keeps tool results text-only (no follow-up)', async () => {
    process.env.ZELARI_VISION = '0';
    try {
      const msgs: AgentMessage[] = [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'screenshot', args: {} }] },
        { role: 'tool', toolCallId: 'c1', content: 'r', images: [img('shot.png')] },
      ];
      const out = (await captureRequestBody(msgs)) as Array<{ role: string }>;
      expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    } finally {
      delete process.env.ZELARI_VISION;
    }
  });

  it('glm-5.3 (Kraken lead) does not send image_url follow-up', async () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'screenshot', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'r', images: [img('shot.png')] },
    ];
    const out = (await captureRequestBody(
      msgs,
      'glm-5.3',
      'glm',
      'https://api.z.ai/api/coding/paas/v4',
    )) as Array<{ role: string; content: unknown }>;
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.stringify(out)).not.toContain('image_url');
  });

  it('HTTP 400 code 1210 retries once without image_url', async () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'guarda', images: [img('shot.png')] },
    ];
    const bodies: Array<{ messages: unknown[] }> = [];
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: '1210',
              message: "messages.content.type is invalid, allowed values: ['text']",
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    try {
      const provider = openaiCompatibleProvider({
        apiKey: 'test',
        baseUrl: 'http://localhost:1/v1',
        model: 'grok-4.6',
        providerId: 'grok',
      });
      const deltas: string[] = [];
      for await (const delta of provider({
        messages: msgs,
        tools: [],
        model: 'grok-4.6',
        signal: new AbortController().signal,
      } as Parameters<typeof provider>[0])) {
        if (delta.kind === 'text') deltas.push(delta.delta);
        if (delta.kind === 'error') throw new Error(delta.message);
      }
      expect(deltas.join('')).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
      resetTextOnlyVisionMemory();
    }
    expect(bodies.length).toBe(2);
    expect(JSON.stringify(bodies[0]!.messages)).toContain('image_url');
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain('image_url');
    expect(JSON.stringify(bodies[1]!.messages)).toContain('non supporta input visivi');
  });
});
