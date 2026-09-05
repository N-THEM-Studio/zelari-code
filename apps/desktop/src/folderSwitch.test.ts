import { describe, expect, it } from 'vitest';
import { isVirginConversation, planFolderSwitch } from './folderSwitch.js';
import type { Conversation } from './types.js';

function conv(overrides: Partial<Conversation> & Pick<Conversation, 'id'>): Conversation {
  return {
    title: 'chat',
    messages: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    mode: 'kraken',
    phase: 'build',
    cwd: 'E:\\proj-a',
    ...overrides,
  };
};

const user = { id: 'm1', role: 'user' as const, content: 'hi', createdAt: 1 };

describe('isVirginConversation (FIX-3)', () => {
  it('virgin: no messages and no sessionId', () => {
    expect(isVirginConversation(conv({ id: 'a' }))).toBe(true);
  });

  it('system/tool noise alone does not count as context', () => {
    const c = conv({
      id: 'a',
      messages: [{ id: 's', role: 'system', content: '[headless] mode=kraken', createdAt: 2 }],
    });
    expect(isVirginConversation(c)).toBe(true);
  });

  it('not virgin: any user/assistant message', () => {
    expect(isVirginConversation(conv({ id: 'a', messages: [user] }))).toBe(false);
  });

  it('not virgin: sessionId captured from session_started', () => {
    expect(isVirginConversation(conv({ id: 'a', sessionId: 'sess-1' }))).toBe(false);
  });
});

describe('planFolderSwitch (FIX-3: picking a folder must never rebind a used chat)', () => {
  it('virgin chat → rebind cwd in place, selection unchanged', () => {
    const list = [conv({ id: 'a' }), conv({ id: 'b' })];
    const plan = planFolderSwitch(list, 'a', 'E:\\proj-b');
    expect(plan.reboundInPlace).toBe(true);
    expect(plan.nextActiveId).toBe('a');
    expect(plan.conversations).toHaveLength(2);
    expect(plan.conversations[0]!.cwd).toBe('E:\\proj-b');
    expect(plan.conversations[1]!.cwd).toBe('E:\\proj-a');
    // Pure: the input list is never mutated.
    expect(list[0]!.cwd).toBe('E:\\proj-a');
  });

  it('used chat (messages) → old chat keeps its cwd, NEW chat opens on the folder', () => {
    const used = conv({ id: 'a', messages: [user], sessionId: 'sess-a' });
    const plan = planFolderSwitch([used], 'a', 'E:\\proj-b');
    expect(plan.reboundInPlace).toBe(false);
    expect(plan.conversations).toHaveLength(2);
    const old = plan.conversations.find((c) => c.id === 'a')!;
    const fresh = plan.conversations.find((c) => c.id === plan.nextActiveId)!;
    expect(old.cwd).toBe('E:\\proj-a');
    expect(old.sessionId).toBe('sess-a');
    expect(fresh.cwd).toBe('E:\\proj-b');
    // A fresh chat carries no spine session → first send() starts a new
    // spine in the new folder (no cross-project contamination).
    expect(fresh.sessionId).toBeUndefined();
    expect(fresh.messages).toHaveLength(0);
    expect(fresh.archived).toBe(false);
    expect(fresh.mode).toBe('kraken');
  });

  it('used chat (sessionId only, zero messages) → new chat, never a rebind', () => {
    const used = conv({ id: 'a', sessionId: 'sess-a' });
    const plan = planFolderSwitch([used], 'a', 'E:\\proj-b');
    expect(plan.reboundInPlace).toBe(false);
    expect(plan.conversations).toHaveLength(2);
    expect(plan.conversations.find((c) => c.id === 'a')!.cwd).toBe('E:\\proj-a');
  });

  it('deterministic ids/timestamps via opts (testability)', () => {
    const used = conv({ id: 'a', messages: [user] });
    const plan = planFolderSwitch([used], 'a', 'E:\\proj-b', { now: 5_000, newId: 'fixed' });
    // New chat lands at the HEAD, matching the "New chat" button path.
    const fresh = plan.conversations[0]!;
    expect(plan.nextActiveId).toBe('fixed');
    expect(fresh).toMatchObject({ id: 'fixed', createdAt: 5_000, updatedAt: 5_000 });
  });

  it('REGRESSION (P0 storage): with 80 stored chats the new one survives the cap', () => {
    // 80 existing conversations, newest at the head (App convention).
    const list = Array.from({ length: 80 }, (_, i) =>
      conv({ id: `c${i}`, updatedAt: 5_000 - i, messages: [user] }),
    );
    const plan = planFolderSwitch(list, 'c0', 'E:\\proj-b', { now: 9_000, newId: 'fresh' });
    expect(plan.conversations).toHaveLength(81);
    expect(plan.conversations[0]!.id).toBe('fresh');
  });

  it('unknown active id → plan is a no-op keeping the selection', () => {
    const list = [conv({ id: 'a' })];
    const plan = planFolderSwitch(list, 'ghost', 'E:\\proj-b');
    expect(plan).toEqual({ conversations: list, nextActiveId: 'ghost', reboundInPlace: false });
  });
});
