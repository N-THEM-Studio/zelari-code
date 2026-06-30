import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getSessionBaseDir,
  getCurrentSessionFile,
  ensureSessionDir,
  getCurrentSessionId,
  setCurrentSessionId,
  clearCurrentSessionId,
  newSessionId,
  listSessions,
  loadSessionEvents,
} from '../../src/cli/sessionManager.js';
import { SessionJsonlWriter } from '../../src/main/core/sessionJsonl.js';
import { createBrainEvent } from '../../src/shared/events.js';

describe('sessionManager', () => {
  let testSessionsDir: string;
  let testCurrentFile: string;
  let savedSessionsEnv: string | undefined;
  let savedCurrentEnv: string | undefined;

  beforeEach(async () => {
    const base = path.join(os.tmpdir(), `anathema-sm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    testSessionsDir = path.join(base, 'sessions');
    testCurrentFile = path.join(base, 'current.txt');
    savedSessionsEnv = process.env.ANATHEMA_SESSIONS_DIR;
    savedCurrentEnv = process.env.ANATHEMA_CURRENT_SESSION_FILE;
    process.env.ANATHEMA_SESSIONS_DIR = testSessionsDir;
    process.env.ANATHEMA_CURRENT_SESSION_FILE = testCurrentFile;
    await fs.mkdir(testSessionsDir, { recursive: true });
  });

  afterEach(async () => {
    if (savedSessionsEnv === undefined) delete process.env.ANATHEMA_SESSIONS_DIR;
    else process.env.ANATHEMA_SESSIONS_DIR = savedSessionsEnv;
    if (savedCurrentEnv === undefined) delete process.env.ANATHEMA_CURRENT_SESSION_FILE;
    else process.env.ANATHEMA_CURRENT_SESSION_FILE = savedCurrentEnv;
    await fs.rm(path.dirname(testSessionsDir), { recursive: true, force: true });
  });

  it('getSessionBaseDir() respects ANATHEMA_SESSIONS_DIR override', () => {
    expect(getSessionBaseDir()).toBe(testSessionsDir);
  });

  it('getCurrentSessionFile() respects ANATHEMA_CURRENT_SESSION_FILE override', () => {
    expect(getCurrentSessionFile()).toBe(testCurrentFile);
  });

  it('newSessionId() returns unique UUIDs', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('setCurrentSessionId + getCurrentSessionId roundtrip', () => {
    expect(getCurrentSessionId()).toBeNull();
    setCurrentSessionId('abc-1234');
    expect(getCurrentSessionId()).toBe('abc-1234');
    setCurrentSessionId('def-5678');
    expect(getCurrentSessionId()).toBe('def-5678');
  });

  it('clearCurrentSessionId removes the file', () => {
    setCurrentSessionId('session-x');
    expect(getCurrentSessionId()).toBe('session-x');
    clearCurrentSessionId();
    expect(getCurrentSessionId()).toBeNull();
    // Idempotent: clearing again is a no-op.
    expect(() => clearCurrentSessionId()).not.toThrow();
  });

  it('ensureSessionDir() creates base directory if missing', async () => {
    const newDir = path.join(testSessionsDir, 'nested', 'deeper');
    process.env.ANATHEMA_SESSIONS_DIR = newDir;
    await ensureSessionDir();
    const stat = await fs.stat(newDir);
    expect(stat.isDirectory()).toBe(true);
    process.env.ANATHEMA_SESSIONS_DIR = testSessionsDir;
  });

  it('listSessions() returns sessions sorted by mtime desc', async () => {
    const writer1 = new SessionJsonlWriter('session-aa', { baseDir: testSessionsDir });
    await writer1.append(createBrainEvent('agent_start', 'session-aa', { model: 'm', provider: 'p' }));
    const stat1 = await fs.stat(writer1.path);
    // Touch stat1 to be earlier than the next file.
    await new Promise(r => setTimeout(r, 20));
    const writer2 = new SessionJsonlWriter('session-bb', { baseDir: testSessionsDir });
    await writer2.append(createBrainEvent('agent_start', 'session-bb', { model: 'm', provider: 'p' }));
    await writer2.append(createBrainEvent('message_delta', 'session-bb', { messageId: 'm1', delta: 'hi' }));
    const stat2 = await fs.stat(writer2.path);

    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    // session-bb was created later → first in list.
    expect(sessions[0].id).toBe('session-bb');
    expect(sessions[0].eventCount).toBe(2);
    expect(sessions[0].mtimeMs).toBeGreaterThanOrEqual(stat1.mtimeMs);
    expect(sessions[0].mtimeMs).toBe(stat2.mtimeMs);
    expect(sessions[1].id).toBe('session-aa');
    expect(sessions[1].eventCount).toBe(1);
  });

  it('listSessions() returns [] when base directory does not exist', async () => {
    const emptyDir = path.join(testSessionsDir, 'never-created');
    process.env.ANATHEMA_SESSIONS_DIR = emptyDir;
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
    process.env.ANATHEMA_SESSIONS_DIR = testSessionsDir;
  });

  it('loadSessionEvents() returns parsed events from JSONL', async () => {
    const id = 'session-load';
    const writer = new SessionJsonlWriter(id, { baseDir: testSessionsDir });
    await writer.append(createBrainEvent('agent_start', id, { model: 'grok-4', provider: 'grok' }));
    await writer.append(createBrainEvent('message_delta', id, { messageId: 'm1', delta: 'hello' }));
    const events = await loadSessionEvents(id);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent_start');
    expect(events[1].type).toBe('message_delta');
    if (events[1].type === 'message_delta') {
      expect(events[1].delta).toBe('hello');
    }
  });

  it('loadSessionEvents() returns [] for nonexistent session', async () => {
    const events = await loadSessionEvents('nonexistent-uuid');
    expect(events).toEqual([]);
  });
});