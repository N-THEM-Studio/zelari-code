/**
 * inboxNotify — the Desktop half of WS2: `/inbox` as a notification bus.
 *
 * The Desktop already receives every harness frame on the `agent-event` Tauri
 * stream (see App.tsx / activity/useRunActivity.ts). This module turns the
 * three "waiting on you" frames into ONE native notification each:
 *
 *   - `permission.request`  → needs input: a tool call is blocked on your
 *     decision (settled by `permission.settled`);
 *   - `ask_user.request`    → waiting on you: the model asked a question
 *     (settled by `ask_user.settled`);
 *   - `agent_ended`         → a tentacle finished (`ok === true`), failed
 *     (`ok === false`) or simply ended (no ok claim: never reported as a
 *     success — ADR-0023, unknown ≠ pass).
 *
 * GATE (all four must hold, in this order): the pref `inboxNotifications` is
 * ON, the Web Notification API is available and GRANTED, the window is not
 * focused (you are away — otherwise the panel is right there), and this exact
 * signal has not already been notified. Nothing is persisted: the "already
 * notified" set is process-local, exactly like every other derivative of the
 * live stream.
 *
 * NO Rust dependency: `Notification` is the WebView2-native Web API (the Tauri
 * notification plugin is not part of Cargo.toml, and WS2 deliberately adds no
 * crate). A missing/denied API is a silent no-op — notifications are a
 * convenience, never a correctness surface.
 */

/** The three signals the bus can carry. */
export type InboxNotifyKind = 'question' | 'permission' | 'finished';

export interface InboxNotification {
  kind: InboxNotifyKind;
  title: string;
  body: string;
  /** Stable identity of the signal: one notification per tag (dedupe + OS grouping). */
  tag: string;
}

/** Minimal structural view of the Web Notification API (no DOM lib needed). */
interface NotificationLike {
  onclick?: (() => void) | null;
  close?: () => void;
}
interface NotificationCtor {
  new (title: string, options?: { body?: string; tag?: string }): NotificationLike;
  permission?: string;
  requestPermission?: () => Promise<string>;
}

function notificationCtor(): NotificationCtor | null {
  const ctor = (globalThis as { Notification?: unknown }).Notification;
  return typeof ctor === 'function' ? (ctor as NotificationCtor) : null;
}

/** Notification permission as the Web API reports it; `unsupported` = no WebView API. */
export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export function currentNotifyPermission(): NotifyPermission {
  const ctor = notificationCtor();
  if (!ctor) return 'unsupported';
  const permission = ctor.permission;
  return permission === 'granted' || permission === 'denied' || permission === 'default'
    ? permission
    : 'default';
}

/**
 * Ask for the notification permission. MUST be called from a user gesture (the
 * Settings toggle is the gesture) — never automatically from the event stream.
 * Fail-soft: an unsupported/denied/absent API resolves to its current state.
 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  const ctor = notificationCtor();
  if (!ctor) return 'unsupported';
  if (ctor.permission === 'granted' || ctor.permission === 'denied') {
    return ctor.permission;
  }
  if (typeof ctor.requestPermission !== 'function') return currentNotifyPermission();
  try {
    const result = await ctor.requestPermission();
    return result === 'granted' || result === 'denied' || result === 'default' ? result : 'default';
  } catch {
    return currentNotifyPermission();
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

const MAX_SEEN = 200;

/**
 * Pure classification of ONE frame: the notification it deserves, or null when
 * the frame is not a "waiting on you" signal. Never touches the DOM.
 */
export function inboxNotificationFor(ev: Record<string, unknown> | null | undefined): InboxNotification | null {
  if (!ev || typeof ev !== 'object') return null;
  const type = str(ev.type);
  if (type === 'permission.request') {
    const requestId = str(ev.requestId);
    if (!requestId) return null; // unattributable: never claim an ask
    const tool = str(ev.tool) || 'tool';
    const reason = str(ev.reason);
    const preview = str(ev.inputPreview);
    return {
      kind: 'permission',
      title: `Zelari · permission needed: ${tool}`,
      body: [reason || preview || 'A tool call is waiting for your decision.', 'Open the chat to allow or deny.']
        .filter(Boolean)
        .join(' — '),
      tag: `permission:${requestId}`,
    };
  }
  if (type === 'ask_user.request') {
    const requestId = str(ev.requestId);
    const question = str(ev.question);
    if (!requestId || !question) return null;
    return {
      kind: 'question',
      title: 'Zelari · the agent is asking you',
      body: question,
      tag: `question:${requestId}`,
    };
  }
  if (type === 'agent_ended') {
    const agentId = str(ev.agentId);
    if (!agentId) return null; // no tentacle to name
    const what = ev.ok === true ? 'finished' : ev.ok === false ? 'FAILED' : 'ended';
    const duration = typeof ev.durationMs === 'number' ? ` · ${(ev.durationMs / 1000).toFixed(1)}s` : '';
    const reason = str(ev.reason);
    return {
      kind: 'finished',
      title: `Zelari · tentacle ${what}: ${agentId}`,
      body: `${what === 'finished' ? 'The tentacle finished' : what === 'FAILED' ? 'The tentacle failed' : 'The tentacle ended'}${duration}${reason ? ` — ${reason}` : ''}`,
      tag: `agent:${agentId}`,
    };
  }
  return null;
}

export interface InboxNotifyGate {
  /** The `inboxNotifications` pref: OFF is a silent no-op, not an error. */
  enabled: boolean;
  permission: NotifyPermission;
  /** true = you are looking at the app, so the panel already tells you. */
  focused: boolean;
}

/** Pure gate: every input is spelled out so the rule is auditable. */
export function shouldNotify(notification: InboxNotification | null, gate: InboxNotifyGate): boolean {
  if (!notification) return false;
  if (!gate.enabled) return false;
  if (gate.permission !== 'granted') return false;
  if (gate.focused) return false;
  return true;
}

/** Where a fired notification goes. Injectable so tests never touch the DOM. */
export interface InboxNotifySink {
  fire(notification: InboxNotification): void;
}

/** The real sink: the Web Notification API of the webview (WebView2). */
export function webNotificationSink(): InboxNotifySink {
  return {
    fire: (notification) => {
      const Ctor = notificationCtor();
      if (!Ctor) return;
      try {
        const note = new Ctor(notification.title, { body: notification.body, tag: notification.tag });
        note.onclick = () => {
          try {
            (globalThis as { focus?: () => void }).focus?.();
          } catch {
            /* best effort: bringing the window forward is not guaranteed */
          }
        };
      } catch {
        /* denied / unsupported / invalid option: fail-soft */
      }
    },
  };
}

export interface InboxNotifierOptions {
  /** Read per event, so a pref flip or a permission change applies immediately. */
  gate: () => InboxNotifyGate;
  sink?: InboxNotifySink;
  /** Cap of remembered tags (default 200) — a bounded, process-local memory. */
  maxSeen?: number;
}

export interface InboxNotifier {
  /** Classify + gate + fire. Returns the notification it fired, or null. */
  onEvent(ev: Record<string, unknown> | null | undefined): InboxNotification | null;
  /** Forget every remembered tag (a fresh run must be able to notify again). */
  reset(): void;
}

/**
 * The bus: one notifier per window, fed by the `agent-event` subscription.
 * Dedupe is by `tag`, so a re-delivered frame (or a second listener) never
 * fires twice; `reset()` clears the memory at a run boundary.
 */
export function createInboxNotifier(opts: InboxNotifierOptions): InboxNotifier {
  const sink = opts.sink ?? webNotificationSink();
  const maxSeen = Math.max(1, opts.maxSeen ?? MAX_SEEN);
  const seen = new Set<string>();
  return {
    onEvent(ev) {
      const notification = inboxNotificationFor(ev);
      if (!shouldNotify(notification, opts.gate())) return null;
      const fired = notification as InboxNotification;
      if (seen.has(fired.tag)) return null;
      seen.add(fired.tag);
      if (seen.size > maxSeen) {
        // Drop the oldest tag: a Set preserves insertion order.
        const oldest = seen.values().next().value;
        if (typeof oldest === 'string') seen.delete(oldest);
      }
      sink.fire(fired);
      return fired;
    },
    reset() {
      seen.clear();
    },
  };
}
