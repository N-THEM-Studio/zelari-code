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

  it('rejects text-only models by default', () => {
    expect(modelSupportsVision('deepseek-chat')).toBe(false);
    expect(modelSupportsVision('deepseek-reasoner')).toBe(false);
  });

  it('honors ZELARI_VISION override', () => {
    process.env.ZELARI_VISION = '1';
    expect(modelSupportsVision('deepseek-chat')).toBe(true);
    process.env.ZELARI_VISION = '0';
    expect(modelSupportsVision('grok-4')).toBe(false);
  });

  it('builds data URIs from image blocks', () => {
    const uri = dataUriFromImage({ mime: 'image/png', dataBase64: 'abc' });
    expect(uri).toBe('data:image/png;base64,abc');
  });
});
