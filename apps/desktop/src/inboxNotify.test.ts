/**
 * inboxNotify.test.ts — WS2 Desktop half: the inbox as a notification bus.
 *
 * Red-if-reopens: the bridge must be PREF-GATED (off = silent), PERMISSION-GATED
 * (no WebView permission = no fire), FOCUS-GATED (you are looking at the app)
 * and DEDUPED (one notification per signal), and it must never claim a success
 * the frame does not state (`agent_ended` without `ok: true` is not "finished").
 */
import { describe, expect, it } from "vitest";
import {
  createInboxNotifier,
  inboxNotificationFor,
  shouldNotify,
  type InboxNotification,
  type InboxNotifyGate,
} from "./inboxNotify";
import { DEFAULT_DESKTOP_PREFS, loadDesktopPrefs, normalizeDesktopPrefs, saveDesktopPrefs } from "./desktopPrefs";

const gate = (over: Partial<InboxNotifyGate> = {}): InboxNotifyGate => ({
  enabled: true,
  permission: "granted",
  focused: false,
  ...over,
});

const collector = (): { fired: InboxNotification[]; sink: { fire(n: InboxNotification): void } } => {
  const fired: InboxNotification[] = [];
  return { fired, sink: { fire: (n) => fired.push(n) } };
};

describe("inboxNotificationFor — one frame, one signal (pure)", () => {
  it("a permission request is a needs-input notification tagged by requestId", () => {
    expect(
      inboxNotificationFor({ type: "permission.request", requestId: "r1", tool: "bash", reason: "write outside the sandbox" }),
    ).toEqual({
      kind: "permission",
      title: "Zelari · permission needed: bash",
      body: "write outside the sandbox — Open the chat to allow or deny.",
      tag: "permission:r1",
    });
  });

  it("an ask_user request is a question notification", () => {
    const n = inboxNotificationFor({ type: "ask_user.request", requestId: "q1", question: "Postgres or SQLite?" });
    expect(n).toMatchObject({ kind: "question", tag: "question:q1" });
    expect(n?.body).toBe("Postgres or SQLite?");
  });

  it("agent_ended distinguishes finished / failed / ended and never invents a success", () => {
    expect(inboxNotificationFor({ type: "agent_ended", agentId: "t2", ok: true, durationMs: 4000 })).toMatchObject({
      kind: "finished",
      title: "Zelari · tentacle finished: t2",
    });
    expect(inboxNotificationFor({ type: "agent_ended", agentId: "t2", ok: false })?.title).toContain("FAILED");
    const unknown = inboxNotificationFor({ type: "agent_ended", agentId: "t2" });
    expect(unknown?.title).toBe("Zelari · tentacle ended: t2");
  });

  it("ignores every frame that is not a waiting-on-you signal (or cannot be attributed)", () => {
    expect(inboxNotificationFor(null)).toBeNull();
    expect(inboxNotificationFor({ type: "message_delta", text: "…" })).toBeNull();
    expect(inboxNotificationFor({ type: "permission.request" })).toBeNull(); // no requestId
    expect(inboxNotificationFor({ type: "ask_user.request", requestId: "q1" })).toBeNull(); // no question
    expect(inboxNotificationFor({ type: "agent_ended" })).toBeNull(); // no agentId
  });
});

describe("shouldNotify — pref, permission, focus (pure)", () => {
  const notification = inboxNotificationFor({ type: "permission.request", requestId: "r1", tool: "bash" });

  it('fires ONLY when the pref is ON: `inboxNotifications:false` is a silent no-op', () => {
    expect(shouldNotify(notification, gate())).toBe(true);
    expect(shouldNotify(notification, gate({ enabled: false }))).toBe(false);
  });

  it("requires a GRANTED WebView permission (unsupported/denied/default all skip)", () => {
    expect(shouldNotify(notification, gate({ permission: "denied" }))).toBe(false);
    expect(shouldNotify(notification, gate({ permission: "default" }))).toBe(false);
    expect(shouldNotify(notification, gate({ permission: "unsupported" }))).toBe(false);
  });

  it("stays quiet while the window is focused (the panel already says it)", () => {
    expect(shouldNotify(notification, gate({ focused: true }))).toBe(false);
  });
});

describe("createInboxNotifier — the bus", () => {
  it("fires once per signal (dedupe by tag), and forgets on reset()", () => {
    const { fired, sink } = collector();
    const bus = createInboxNotifier({ gate: () => gate(), sink });
    const frame = { type: "permission.request", requestId: "r1", tool: "bash" };
    expect(bus.onEvent(frame)?.tag).toBe("permission:r1");
    expect(bus.onEvent(frame)).toBeNull(); // duplicate delivery
    expect(fired).toHaveLength(1);
    bus.reset();
    expect(bus.onEvent(frame)?.tag).toBe("permission:r1");
    expect(fired).toHaveLength(2);
  });

  it("re-reads the gate per event: flipping the pref OFF stops the bus immediately", () => {
    const { fired, sink } = collector();
    let enabled = true;
    const bus = createInboxNotifier({ gate: () => gate({ enabled }), sink });
    bus.onEvent({ type: "agent_ended", agentId: "t1", ok: true });
    enabled = false;
    bus.onEvent({ type: "agent_ended", agentId: "t2", ok: true });
    expect(fired.map((n) => n.tag)).toEqual(["agent:t1"]);
  });

  it("keeps the dedupe memory bounded (oldest tag dropped first)", () => {
    const { fired, sink } = collector();
    const bus = createInboxNotifier({ gate: () => gate(), sink, maxSeen: 2 });
    bus.onEvent({ type: "agent_ended", agentId: "a1", ok: true });
    bus.onEvent({ type: "agent_ended", agentId: "a2", ok: true });
    bus.onEvent({ type: "agent_ended", agentId: "a3", ok: true });
    expect(fired).toHaveLength(3);
    bus.onEvent({ type: "agent_ended", agentId: "a1", ok: true }); // evicted → fires again
    expect(fired).toHaveLength(4);
  });

  it("ignores a null/undefined frame without touching the sink", () => {
    const { fired, sink } = collector();
    const bus = createInboxNotifier({ gate: () => gate(), sink });
    expect(bus.onEvent(undefined)).toBeNull();
    expect(bus.onEvent(null)).toBeNull();
    expect(fired).toEqual([]);
  });
});

describe("the Desktop pref — persisted, default ON, explicit false opts out", () => {
  it("defaults ON (CLI-aligned) and only an explicit false disables it", () => {
    expect(DEFAULT_DESKTOP_PREFS.inboxNotifications).toBe(true);
    expect(normalizeDesktopPrefs({}).inboxNotifications).toBe(true);
    expect(normalizeDesktopPrefs({ inboxNotifications: "nope" }).inboxNotifications).toBe(true);
    expect(normalizeDesktopPrefs({ inboxNotifications: false }).inboxNotifications).toBe(false);
    expect(normalizeDesktopPrefs({ inboxNotifications: true }).inboxNotifications).toBe(true);
  });

  it("survives a save/load round-trip through the prefs blob", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveDesktopPrefs({ ...DEFAULT_DESKTOP_PREFS, inboxNotifications: false }, storage);
    expect(loadDesktopPrefs(storage).inboxNotifications).toBe(false);
    saveDesktopPrefs({ ...DEFAULT_DESKTOP_PREFS, inboxNotifications: true }, storage);
    expect(loadDesktopPrefs(storage).inboxNotifications).toBe(true);
  });
});
