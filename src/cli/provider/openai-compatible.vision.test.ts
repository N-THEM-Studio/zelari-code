import { describe, it, expect, afterEach } from 'vitest';
import {
  openaiCompatibleProvider,
  modelSupportsVision,
  dataUriFromImage,
} from './openai-compatible.js';
import type { AgentMessage } from '@zelari/core/harness';

/**
 * 2.35 vision policy: pixels are sent to EVERY model by default (name-hint
 * allowlists kept missing new vision models), with ZELARI_VISION=0 as the
 * explicit opt-out. Tool-result pixels (screenshots) ride a synthetic user
 * message injected after the last consecutive tool result, because the
 * OpenAI `tool` role only accepts textual content.
 */

const img = (name: string): { mime: string; dataBase64: string; alt: string } => ({
  mime: 'image/png',
  dataBase64: Buffer.from(`png-bytes-${name}`).toString('base64'),
  alt: name,
});

describe('modelSupportsVision (default ON)', () => {
  afterEach(() => {
    delete process.env.ZELARI_VISION;
  });

  it('is ON for unknown/new model names (gpt-6-astra, glm-5.3, deepseek v4 flash)', () => {
    expect(modelSupportsVision('openai/gpt-6-astra')).toBe(true);
    expect(modelSupportsVision('glm-5.3')).toBe(true);
    expect(modelSupportsVision('deepseek-v4-flash')).toBe(true);
    expect(modelSupportsVision('totally-unknown-model')).toBe(true);
  });

  it('ZELARI_VISION=0 opts out', () => {
    process.env.ZELARI_VISION = '0';
    expect(modelSupportsVision('gpt-4o')).toBe(false);
    process.env.ZELARI_VISION = 'off';
    expect(modelSupportsVision('anything')).toBe(false);
  });
});

/** Consume the provider stream with a stubbed fetch capturing the request body. */
async function captureRequestBody(messages: AgentMessage[], model = 'test-model'): Promise<unknown[]> {
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
      baseUrl: 'http://localhost:1/v1',
      model,
      providerId: 'custom',
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
});
