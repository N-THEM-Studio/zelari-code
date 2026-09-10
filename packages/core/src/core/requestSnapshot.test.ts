/**
 * Int4b — requestSnapshot modes (full | lite | off).
 * Default remains `full`; lite must match full digests when fingerprints are read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentMessage, AgentToolSpec } from './AgentHarness.js';
import {
  createRoutedRequestSnapshot,
  resolveRequestSnapshotMode,
  __resetRequestSnapshotMemoForTests,
} from './requestSnapshot.js';

function sys(content: string): AgentMessage {
  return { role: 'system', content };
}
function user(content: string): AgentMessage {
  return { role: 'user', content };
}

const tools: AgentToolSpec[] = [
  { name: 'zeta', description: 'z tool', parameters: { type: 'object' } },
  { name: 'alpha', description: 'a tool', parameters: { type: 'object' } },
];

const REAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...REAL_ENV };
  delete process.env.ZELARI_REQUEST_SNAPSHOT;
  __resetRequestSnapshotMemoForTests();
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  __resetRequestSnapshotMemoForTests();
});

describe('resolveRequestSnapshotMode', () => {
  it('defaults to full when unset or garbage', () => {
    expect(resolveRequestSnapshotMode({})).toBe('full');
    expect(resolveRequestSnapshotMode({ ZELARI_REQUEST_SNAPSHOT: 'nope' })).toBe('full');
    expect(resolveRequestSnapshotMode({ ZELARI_REQUEST_SNAPSHOT: 'FULL' })).toBe('full');
  });

  it('accepts lite and off (case/space insensitive)', () => {
    expect(resolveRequestSnapshotMode({ ZELARI_REQUEST_SNAPSHOT: ' lite ' })).toBe('lite');
    expect(resolveRequestSnapshotMode({ ZELARI_REQUEST_SNAPSHOT: 'OFF' })).toBe('off');
  });
});

describe('createRoutedRequestSnapshot modes', () => {
  const params = {
    messages: [sys('stable'), user('hello')],
    model: 'm',
    provider: 'p',
    tools,
  };

  it('default / full is bit-identical to an explicit full mode', () => {
    const a = createRoutedRequestSnapshot(params);
    const b = createRoutedRequestSnapshot({ ...params, mode: 'full' });
    expect(a.headerFingerprint).toBe(b.headerFingerprint);
    expect(a.requestFingerprint).toBe(b.requestFingerprint);
    expect(a.tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
  });

  it('lite vs full digest parity on the same request', () => {
    const full = createRoutedRequestSnapshot({ ...params, mode: 'full' });
    const lite = createRoutedRequestSnapshot({ ...params, mode: 'lite' });
    expect(lite.headerFingerprint).toBe(full.headerFingerprint);
    expect(lite.requestFingerprint).toBe(full.requestFingerprint);
    expect(lite.tools.map((t) => t.name)).toEqual(full.tools.map((t) => t.name));
  });

  it('lite lazy digest: second access returns the same value', () => {
    const lite = createRoutedRequestSnapshot({ ...params, mode: 'lite' });
    const h1 = lite.headerFingerprint;
    const h2 = lite.headerFingerprint;
    const r1 = lite.requestFingerprint;
    const r2 = lite.requestFingerprint;
    expect(h1).toBe(h2);
    expect(r1).toBe(r2);
    expect(h1).toHaveLength(32);
    expect(r1).toHaveLength(32);
  });

  it('lite header memo: same tools identity + system reuses header fingerprint', () => {
    const a = createRoutedRequestSnapshot({ ...params, mode: 'lite' });
    const b = createRoutedRequestSnapshot({ ...params, mode: 'lite' });
    expect(a.headerFingerprint).toBe(b.headerFingerprint);
    // conversation-only change keeps header
    const c = createRoutedRequestSnapshot({
      ...params,
      messages: [sys('stable'), user('hello'), user('again')],
      mode: 'lite',
    });
    expect(c.headerFingerprint).toBe(a.headerFingerprint);
    expect(c.requestFingerprint).not.toBe(a.requestFingerprint);
  });

  it('lite shallow copy: top-level message mutation does not rewrite the snapshot', () => {
    const messages: AgentMessage[] = [sys('s'), user('u')];
    const snap = createRoutedRequestSnapshot({
      messages,
      model: 'm',
      provider: 'p',
      tools,
      mode: 'lite',
    });
    messages[1] = user('mutated');
    expect(snap.conversation[0].content).toBe('u');
  });
});
