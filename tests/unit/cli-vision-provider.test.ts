import { describe, expect, it, afterEach } from 'vitest';
import {
  modelSupportsVision,
  dataUriFromImage,
} from '../../src/cli/provider/openai-compatible.js';

describe('vision provider support (no third-party API)', () => {
  const prev = process.env.ZELARI_VISION;

  afterEach(() => {
    if (prev === undefined) delete process.env.ZELARI_VISION;
    else process.env.ZELARI_VISION = prev;
  });

  it('detects known vision models', () => {
    expect(modelSupportsVision('grok-4')).toBe(true);
    expect(modelSupportsVision('grok-4-fast')).toBe(true);
    expect(modelSupportsVision('glm-4.5v')).toBe(true);
    expect(modelSupportsVision('qwen2.5-vl-72b')).toBe(true);
    expect(modelSupportsVision('gpt-4o')).toBe(true);
    expect(modelSupportsVision('minimax-m2')).toBe(true);
    expect(modelSupportsVision('deepseek-vl')).toBe(true);
  });

  it('vision is ON for every model by default (2.35) — unknown names included', () => {
    // Name-hint allowlists kept missing new vision models (gpt-6-astra,
    // glm-5.x, deepseek v4): pixels are now always sent and the provider
    // decides. ZELARI_VISION=0 is the explicit opt-out.
    expect(modelSupportsVision('deepseek-chat')).toBe(true);
    expect(modelSupportsVision('deepseek-reasoner')).toBe(true);
    expect(modelSupportsVision('openai/gpt-6-astra')).toBe(true);
    expect(modelSupportsVision('totally-unknown-model')).toBe(true);
  });

  it('honors ZELARI_VISION override', () => {
    process.env.ZELARI_VISION = '0';
    expect(modelSupportsVision('grok-4')).toBe(false);
    process.env.ZELARI_VISION = 'off';
    expect(modelSupportsVision('deepseek-chat')).toBe(false);
  });

  it('builds data URIs from image blocks', () => {
    const uri = dataUriFromImage({ mime: 'image/png', dataBase64: 'abc' });
    expect(uri).toBe('data:image/png;base64,abc');
  });
});
