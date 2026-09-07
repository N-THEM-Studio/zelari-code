import { describe, it, expect } from 'vitest';
import { createScreenshotTool } from './screenshotTool.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Minimal 1x1 PNG so stat/readFile see real bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('screenshot tool', () => {
  it('captures, returns the path and attaches the pixels as a vision block', async () => {
    const dir = path.join(os.tmpdir(), `zelari-shot-test-${Date.now()}`);
    const tool = createScreenshotTool({
      outDir: dir,
      capture: async (target) => {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, PNG_BYTES);
      },
    });
    const res = await tool.execute(
      { note: 'test' },
      { cwd: dir, sessionId: 'test', signal: new AbortController().signal } as never,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({ ok: true, bytes: PNG_BYTES.byteLength });
    expect(String((res.value as { path: string }).path)).toMatch(/\.png$/);
    expect(res.images?.length).toBe(1);
    expect(res.images?.[0].mime).toBe('image/png');
    expect(res.images?.[0].dataBase64).toBe(PNG_BYTES.toString('base64'));
    // The saved file is the exact image attached to the model context.
    const saved = await readFile((res.value as { path: string }).path);
    expect(saved.equals(PNG_BYTES)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a capture failure as a typed error', async () => {
    const tool = createScreenshotTool({
      outDir: path.join(os.tmpdir(), `zelari-shot-fail-${Date.now()}`),
      capture: async () => {
        throw new Error('no utility');
      },
    });
    const res = await tool.execute(
      {},
      { cwd: os.tmpdir(), sessionId: 'test', signal: new AbortController().signal } as never,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('screen capture failed');
  });
});
