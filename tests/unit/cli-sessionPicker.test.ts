/**
 * cli-sessionPicker.test.ts — v2.53 `/sessions` fuzzy picker.
 *
 * Covers the pure surface: the [name, engine, cwd] haystack, the item builder
 * (labels/hint/current + searchText), the interplay with the multi-term AND
 * matcher, the SESSION_LIST_LIMIT cap, and the unchanged textual fallback
 * (no picker UI → the same sessionKindRouter message as before v2.53).
 *
 * The interactive key handling needs raw-mode stdin (covered by the existing
 * picker tests / manual verification); the SelectList filter itself is pure
 * after fuzzyMatch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fuzzyMatch } from '../../src/cli/components/fuzzyMatch.js';
import {
  buildSessionPickerItems,
  handleSessionsPicker,
  readSessionSearchFields,
  sessionSearchText,
  type SessionSearchFields,
} from '../../src/cli/slashHandlers/sessions.js';
import { SESSION_LIST_LIMIT, type SessionInfo } from '../../src/cli/sessionManager.js';
import type { ChatMessage } from '../../src/cli/components/ChatStream.js';
import type { PickerRequest } from '../../src/cli/slashHandlers/provider.js';

let tmpDir: string;
let sessionsDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-spick-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  process.env.ANATHEMA_SESSIONS_DIR = sessionsDir;
  process.env.ANATHEMA_CURRENT_SESSION_FILE = path.join(tmpDir, 'current.txt');
});

afterEach(async () => {
  delete process.env.ANATHEMA_SESSIONS_DIR;
  delete process.env.ANATHEMA_CURRENT_SESSION_FILE;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Minimal SessionInfo row (listSessions sorts by mtime; irrelevant here). */
const row = (id: string, eventCount = 12, mtimeMs = Date.UTC(2026, 0, 2, 3, 4)): SessionInfo => ({
  id,
  eventCount,
  firstTs: mtimeMs - 1000,
  lastTs: mtimeMs,
  mtimeMs,
  filePath: `sessions/${id}.jsonl`,
});

const fields = (name: string, engine: string, cwd: string): SessionSearchFields => ({
  name,
  engine,
  cwd,
});

/** Chat-shaped sink: appendSystem calls it with an updater or a value. */
function fakeCtx(): { ctx: { setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>> }; text: () => string } {
  let messages: ChatMessage[] = [];
  const setMessages = ((updater: unknown) => {
    messages =
      typeof updater === 'function'
        ? (updater as (prev: ChatMessage[]) => ChatMessage[])(messages)
        : (updater as ChatMessage[]);
  }) as React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  return { ctx: { setMessages }, text: () => messages.map((m) => m.content).join('\n') };
}

describe('sessionSearchText (v2.53)', () => {
  it('joins name, engine and cwd with single spaces', () => {
    expect(sessionSearchText(fields('fix login', 'kraken/v1', 'C:\\dev\\zelari-code'))).toBe(
      'fix login kraken/v1 C:\\dev\\zelari-code',
    );
  });

  it('drops empty facets instead of leaving double spaces', () => {
    expect(sessionSearchText(fields('', 'council/v1', '  '))).toBe('council/v1');
    expect(sessionSearchText(fields('', '', ''))).toBe('');
  });
});

describe('buildSessionPickerItems (v2.53)', () => {
  const sessions = [row('aaaa1111-2222-3333-4444-555566667777'), row('bbbb1111-2222-3333-4444-555566667777')];
  const meta = new Map<string, SessionSearchFields>([
    [sessions[0]!.id, fields('fix login bug', 'kraken/v1', 'C:\\dev\\zelari-code')],
    [sessions[1]!.id, fields('ship android companion', 'council/v1', 'D:\\work\\phone')],
  ]);

  it('labels rows like the textual list and keeps the FULL id as the value', () => {
    const items = buildSessionPickerItems(sessions, (id) => meta.get(id), null);
    expect(items[0]!.value).toBe(sessions[0]!.id);
    expect(items[0]!.label).toBe('aaaa1111…  12 events  2026-01-02 03:04');
  });

  it('carries [name, engine, cwd] + the id in the fuzzy haystack', () => {
    const items = buildSessionPickerItems(sessions, (id) => meta.get(id), null);
    expect(items[0]!.searchText).toContain('fix login bug');
    expect(items[0]!.searchText).toContain('kraken/v1');
    expect(items[0]!.searchText).toContain('zelari-code');
    expect(items[0]!.searchText).toContain(sessions[0]!.id); // id stays searchable
  });

  it('marks the active session current so the cursor lands on it', () => {
    const items = buildSessionPickerItems(sessions, (id) => meta.get(id), sessions[1]!.id);
    expect(items[0]!.current).toBeUndefined();
    expect(items[1]!.current).toBe(true);
  });

  it('falls back to the id when the spine has no metadata (never throws)', () => {
    const items = buildSessionPickerItems(sessions, () => undefined, null);
    expect(items[0]!.searchText).toBe(sessions[0]!.id);
    expect(items[0]!.hint).toBeUndefined();
  });

  it('filters by any single facet, and by several at once (AND)', () => {
    const items = buildSessionPickerItems(sessions, (id) => meta.get(id), null);
    expect(fuzzyMatch('android', items).map((i) => i.value)).toEqual([sessions[1]!.id]);
    expect(fuzzyMatch('kraken zelari', items).map((i) => i.value)).toEqual([sessions[0]!.id]);
    expect(fuzzyMatch('kraken phone', items)).toEqual([]); // no session has both
  });
});

describe('readSessionSearchFields (v2.53)', () => {
  it('degrades to empty fields when the spine log is missing', async () => {
    await expect(readSessionSearchFields('no-such-session', sessionsDir)).resolves.toEqual({
      name: '',
      engine: '',
      cwd: '',
    });
  });
});

describe('handleSessionsPicker (v2.53)', () => {
  it('opens a filterable session picker with /resume as the dispatch prefix', async () => {
    let opened: PickerRequest | undefined;
    const { ctx } = fakeCtx();
    await handleSessionsPicker(
      ctx,
      (req) => {
        opened = req;
      },
      {
        listSessions: async () => [row('aaaa1111-2222-3333-4444-555566667777')],
        searchFields: async () => fields('fix login', 'kraken/v1', 'C:\\dev\\zelari-code'),
      },
    );
    expect(opened?.kind).toBe('session');
    expect(opened?.commandPrefix).toBe('/resume');
    expect(opened?.items).toHaveLength(1);
    expect(opened?.items[0]?.searchText).toContain('fix login');
    expect(opened?.title).toContain('1 of 1');
  });

  it('caps the list at SESSION_LIST_LIMIT (no new limit invented)', async () => {
    const many = Array.from({ length: SESSION_LIST_LIMIT + 5 }, (_, i) =>
      row(`sess-${String(i).padStart(4, '0')}-aaaa-bbbb-cccc-dddddddddddd`),
    );
    let opened: PickerRequest | undefined;
    const { ctx } = fakeCtx();
    await handleSessionsPicker(
      ctx,
      (req) => {
        opened = req;
      },
      { listSessions: async () => many, searchFields: async () => fields('', '', '') },
    );
    expect(opened?.items).toHaveLength(SESSION_LIST_LIMIT);
    expect(opened?.title).toContain(`of ${many.length}`);
  });

  it('shows ALL listed sessions on an empty query (empty query = no filter)', async () => {
    let opened: PickerRequest | undefined;
    const { ctx } = fakeCtx();
    await handleSessionsPicker(
      ctx,
      (req) => {
        opened = req;
      },
      {
        listSessions: async () => [row('a'), row('b')],
        searchFields: async () => fields('', '', ''),
      },
    );
    expect(fuzzyMatch('', opened!.items)).toEqual(opened!.items);
  });

  it('says there is nothing to pick when the store is empty', async () => {
    const { ctx, text } = fakeCtx();
    await handleSessionsPicker(ctx, () => undefined, { listSessions: async () => [] });
    expect(text()).toBe('[sessions] no past sessions');
  });

  it('surfaces a listing error instead of opening an empty picker', async () => {
    const { ctx, text } = fakeCtx();
    await handleSessionsPicker(ctx, () => undefined, {
      listSessions: async () => {
        throw new Error('boom');
      },
    });
    expect(text()).toBe('[sessions] error: boom');
  });

  it('WITHOUT a picker UI keeps the pre-v2.53 textual path byte-for-byte', async () => {
    const { ctx, text } = fakeCtx();
    await handleSessionsPicker(ctx); // no openPicker → sessionKindRouter('session')
    expect(text()).toBe('[sessions] no past sessions');
  });
});
