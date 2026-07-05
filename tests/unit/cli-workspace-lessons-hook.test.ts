import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPostCouncilHook } from '../../src/cli/workspace/postCouncilHook.js';
import type { WorkspaceContext } from '../../src/cli/workspace/types.js';

const DEAD_HTML = `<!DOCTYPE html><html><head><style></style></head><body>
<script>document.documentElement.classList.add('rm');</script></body></html>`;

let tmpDir: string;
let ctx: WorkspaceContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-lessons-hook-'));
  mkdirSync(join(tmpDir, '.zelari'), { recursive: true });
  writeFileSync(join(tmpDir, 'index.html'), DEAD_HTML, 'utf8');
  ctx = {
    projectRoot: tmpDir,
    rootDir: join(tmpDir, '.zelari'),
    storage: {} as WorkspaceContext['storage'],
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runPostCouncilHook Step 5 lessons', () => {
  it('captures lessons from verification FAILs', async () => {
    const result = await runPostCouncilHook(ctx, { runMode: 'implementation' });
    expect(result.lessons?.ran).toBe(true);
    expect(result.lessons?.captured).toBeGreaterThan(0);
    expect(existsSync(join(tmpDir, '.zelari', 'lessons.jsonl'))).toBe(true);
  });

  it('skips when ZELARI_LESSONS=0', async () => {
    const old = process.env.ZELARI_LESSONS;
    process.env.ZELARI_LESSONS = '0';
    try {
      const result = await runPostCouncilHook(ctx, { runMode: 'implementation' });
      expect(result.lessons?.reason).toContain('disabled');
      expect(existsSync(join(tmpDir, '.zelari', 'lessons.jsonl'))).toBe(false);
    } finally {
      if (old === undefined) delete process.env.ZELARI_LESSONS;
      else process.env.ZELARI_LESSONS = old;
    }
  });
});
