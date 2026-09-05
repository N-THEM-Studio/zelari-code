import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_STORED_CONVERSATIONS,
  loadConversations,
  saveConversations,
  selectConversationsForStorage,
} from "../../apps/desktop/src/chatStorage";
import type { Conversation } from "../../apps/desktop/src/types";

/** Minimal in-memory localStorage stub (node env has none). */
function stubLocalStorage(opts: { quotaAfter?: number } = {}) {
  const store = new Map<string, string>();
  let written = 0;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      written += v.length;
      if (opts.quotaAfter != null && written > opts.quotaAfter) {
        throw new Error("QuotaExceededError");
      }
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
  return store;
}

function conv(overrides: Partial<Conversation> & Pick<Conversation, "id">): Conversation {
  return {
    title: "chat",
    messages: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    mode: "kraken",
    phase: "build",
    cwd: "E:\\proj-a",
    ...overrides,
  };
}

/** Realistic list: newest at the head (App.tsx prepends new chats). */
function list(n: number, baseUpdatedAt = 5_000): Conversation[] {
  return Array.from({ length: n }, (_, i) =>
    conv({ id: `c${i}`, updatedAt: baseUpdatedAt - i }),
  );
}

beforeEach(() => {
  stubLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selectConversationsForStorage (pure selection)", () => {
  it("under the cap: returns a copy with identical content and order", () => {
    const input = list(3);
    const out = selectConversationsForStorage(input);
    expect(out.map((c) => c.id)).toEqual(["c0", "c1", "c2"]);
    expect(out).not.toBe(input);
    expect(input).toHaveLength(3); // input untouched
  });

  it("over the cap: keeps the most recently updated, preserves relative order", () => {
    const input = list(5);
    const out = selectConversationsForStorage(input, { limit: 3 });
    // updatedAt desc: c0 (5000) > c1 (4999) > c2 (4998) survive.
    expect(out.map((c) => c.id)).toEqual(["c0", "c1", "c2"]);
  });

  it("active conversation is guaranteed a slot even when least recent", () => {
    const input = list(5);
    const out = selectConversationsForStorage(input, { limit: 3, activeId: "c4" });
    expect(out.map((c) => c.id)).toContain("c4");
    expect(out).toHaveLength(3);
    // The eviction falls on the least recent kept entry (c2), not the active.
    expect(out.map((c) => c.id)).toEqual(["c0", "c1", "c4"]);
  });

  it("deterministic tie-break on equal updatedAt (later array position wins)", () => {
    const input = [conv({ id: "a", updatedAt: 100 }), conv({ id: "b", updatedAt: 100 })];
    const out = selectConversationsForStorage(input, { limit: 1 });
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });

  it("never mutates the input", () => {
    const input = list(5);
    const frozen = JSON.stringify(input);
    selectConversationsForStorage(input, { limit: 2, activeId: "c4" });
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe("saveConversations / loadConversations round-trip", () => {
  it("REGRESSION (P0): 80 chats + folder switch → the NEW chat survives the cap", () => {
    const existing = list(MAX_STORED_CONVERSATIONS); // 80, newest at head
    // planFolderSwitch prepends the fresh chat (folderSwitch.test.ts covers
    // the plan); here we verify the STORAGE half of the contract.
    const fresh = conv({
      id: "fresh",
      cwd: "E:\\proj-b",
      updatedAt: 9_000,
    });
    const all = [fresh, ...existing]; // 81 conversations, newest first
    const res = saveConversations(all, { activeId: "fresh" });
    expect(res.ok).toBe(true);
    expect(res.stored).toBe(MAX_STORED_CONVERSATIONS);
    expect(res.dropped).toBe(1);
    const loaded = loadConversations()!;
    expect(loaded).toHaveLength(MAX_STORED_CONVERSATIONS);
    // The just-created chat is there; the eviction hit the OLDEST chat.
    expect(loaded.some((c) => c.id === "fresh")).toBe(true);
    expect(loaded.some((c) => c.id === "c79")).toBe(false); // lowest updatedAt
    expect(loaded.some((c) => c.id === "c78")).toBe(true);
  });

  it("active chat survives even without a recency advantage", () => {
    const all = list(81);
    const res = saveConversations(all, { activeId: "c80" }); // oldest = active
    expect(res.ok).toBe(true);
    const loaded = loadConversations()!;
    expect(loaded).toHaveLength(80);
    expect(loaded.some((c) => c.id === "c80")).toBe(true);
    expect(loaded.some((c) => c.id === "c79")).toBe(false);
  });

  it("boundary cases: 0, 79, 80 conversations", () => {
    for (const n of [0, 79, 80]) {
      const res = saveConversations(list(n), { activeId: "c0" });
      expect(res.ok).toBe(true);
      expect(res.stored).toBe(n);
      expect(res.dropped).toBe(0);
      const loaded = loadConversations();
      expect(loaded).toHaveLength(n);
    }
  });

  it("caps per-conversation messages to the last 200", () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({
      id: `m${i}`,
      role: "user" as const,
      content: `msg ${i}`,
      createdAt: i,
    }));
    const res = saveConversations([conv({ id: "a", messages })]);
    expect(res.ok).toBe(true);
    const loaded = loadConversations()!;
    expect(loaded[0]!.messages).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    // The TAIL (latest messages) survives.
    expect(loaded[0]!.messages[0]!.id).toBe("m50");
    expect(loaded[0]!.messages.at(-1)!.id).toBe("m249");
  });

  it("quota failure: ok=false with error, previous storage untouched", () => {
    const store = stubLocalStorage({ quotaAfter: 50 });
    saveConversations(list(2)); // small payload passes, seeds storage
    const seeded = store.get("zelari-desktop-chats-v1");
    expect(seeded).toBeTruthy();
    vi.stubGlobal("localStorage", {
      // Now every write throws.
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
      clear: () => {},
    });
    const res = saveConversations(list(3), { activeId: "c0" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("QuotaExceededError");
    expect(res.stored).toBe(0);
    expect(res.dropped).toBe(3);
    // The previously stored payload is intact (failure must not corrupt).
    expect(store.get("zelari-desktop-chats-v1")).toBe(seeded);
  });
});

describe("loadConversations hardening", () => {
  it("corrupted JSON → null (app boots with a fresh chat)", () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "zelari-desktop-chats-v1",
      "{not json",
    );
    expect(loadConversations()).toBeNull();
  });

  it("non-array JSON → null", () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "zelari-desktop-chats-v1",
      '{"bogus":1}',
    );
    expect(loadConversations()).toBeNull();
  });

  it("one corrupt record does not sink the valid ones", () => {
    const good = conv({ id: "good" });
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "zelari-desktop-chats-v1",
      JSON.stringify([null, good, 42]),
    );
    const loaded = loadConversations()!;
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("good");
  });

  it("legacy records normalize: bad mode → kraken, missing cwd → legacy workdir", () => {
    const legacy = { ...conv({ id: "old" }), mode: "wat" as never };
    delete (legacy as Partial<Conversation>).cwd;
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "zelari-desktop-workdir",
      "E:\\legacy",
    );
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "zelari-desktop-chats-v1",
      JSON.stringify([legacy]),
    );
    const loaded = loadConversations()!;
    expect(loaded[0]!.mode).toBe("kraken");
    expect(loaded[0]!.cwd).toBe("E:\\legacy");
  });
});
