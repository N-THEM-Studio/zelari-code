/**
 * cli-sessionKindRouter.test.ts — Task v0.4.2 split + v0.4.3 fix
 *
 * Verifies the `sessionKindRouter` pure helper extracted from app.tsx.
 * Uses env-var redirection (ANATHEMA_CURRENT_SESSION_FILE) to point all
 * session-marker side effects at a temp file we can read back to verify
 * the writes happened. This is more robust than vi.spyOn on the module
 * (which doesn't intercept calls inside a function that already imported
 * those names at top of module scope).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir: string;
let markerFile: string;
let sessionsDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-skind-'));
  markerFile = path.join(tmpDir, 'current.txt');
  sessionsDir = path.join(tmpDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  process.env.ANATHEMA_CURRENT_SESSION_FILE = markerFile;
  process.env.ANATHEMA_SESSIONS_DIR = sessionsDir;
});

afterEach(async () => {
  delete process.env.ANATHEMA_CURRENT_SESSION_FILE;
  delete process.env.ANATHEMA_SESSIONS_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readMarker(): Promise<string | null> {
  try {
    const v = await fs.readFile(markerFile, 'utf-8');
    return v.trim() || null;
  } catch {
    return null;
  }
}

describe('sessionKindRouter (v0.4.2 split + v0.4.3 split-brain fix)', () => {
  it('/sessions: returns "no past sessions" when store is empty', async () => {
    const { sessionKindRouter } = await import('../../src/cli/sessionManager.js');
    const { message, generatedId } = await sessionKindRouter('session');
    expect(message).toBe('[sessions] no past sessions');
    expect(generatedId).toBeUndefined();
  });

  it('/resume <id>: writes the target id to the current-session marker', async () => {
    const { sessionKindRouter } = await import('../../src/cli/sessionManager.js');
    const { message, generatedId } = await sessionKindRouter('resume', 'target-session-1234');
    expect(await readMarker()).toBe('target-session-1234');
    expect(message).toContain('[resume] session target-s…');
    expect(message).toContain('restart zelari-code');
    expect(generatedId).toBeUndefined();
  });

  it('/new without forcedNewId: removes old marker + writes a fresh session id', async () => {
    const { sessionKindRouter } = await import('../../src/cli/sessionManager.js');
    await fs.writeFile(markerFile, 'old-session-id', 'utf-8');
    expect(await readMarker()).toBe('old-session-id');
    const { message, generatedId } = await sessionKindRouter('new');
    const newId = await readMarker();
    expect(newId).not.toBe('old-session-id');
    expect(newId).toMatch(/^[a-z0-9-]+$/);
    expect(message).toMatch(/\[new\] fresh session [a-z0-9]{8}…/);
    // generatedId matches what's on disk
    expect(generatedId).toBe(newId);
  });

  it('/new WITH forcedNewId: writes the forced id (no split-brain)', async () => {
    // v0.4.3 fix: caller passes the id so in-memory state, on-disk marker,
    // and the writerRef all share the same id.
    const { sessionKindRouter } = await import('../../src/cli/sessionManager.js');
    await fs.writeFile(markerFile, 'old-session-id', 'utf-8');
    const { message, generatedId } = await sessionKindRouter('new', undefined, 'forced-id-12345');
    expect(await readMarker()).toBe('forced-id-12345');
    expect(generatedId).toBe('forced-id-12345');
    expect(message).toContain('forced-i…');
  });

  it('unknown kind: returns generic handled message', async () => {
    const { sessionKindRouter } = await import('../../src/cli/sessionManager.js');
    // @ts-expect-error - testing runtime behavior with invalid input
    const { message } = await sessionKindRouter('bogus');
    expect(message).toBe('[bogus] handled');
  });
});