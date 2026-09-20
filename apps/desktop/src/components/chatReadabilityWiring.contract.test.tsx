// @vitest-environment node
/**
 * Chat readability wiring contract (RED-IF-REOPENS).
 *
 * App.tsx cannot be rendered in a unit test — importing it pulls the whole
 * Tauri surface (dialogs, updater, agent events) — so the part of this change
 * that lives in App is pinned at the source level, the same idiom the repo
 * already uses for wiring contracts (grokRoundWiring.contract.test.ts).
 *
 * What must stay true:
 *   - <KrakenContextPanel> is mounted ONCE, in the COMPOSER area (after
 *     `composer-wrap`, before `composer-hint`) — never back at the bottom of
 *     the chat flow, where it used to sit under VerificationStatusCard;
 *   - KrakenActivity carries no inline `style=` at all: the `.kraken-act-*`
 *     classes own the look;
 *   - PermissionCard owns the compact settled chip and the collapsible,
 *     height-capped preview;
 *   - App.css owns every class those components rely on.
 *
 * This fails on the exact regressions it describes, not on formatting.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const app = read("../App.tsx");
const activity = read("./KrakenActivity.tsx");
const permission = read("./PermissionCard.tsx");
const css = read("../App.css");

describe("readability: the context strip lives in the composer", () => {
  it("mounts <KrakenContextPanel> exactly once", () => {
    expect((app.match(/<KrakenContextPanel/g) ?? []).length).toBe(1);
  });

  it("mounts it in the composer area, not in the chat flow", () => {
    const panel = app.indexOf("<KrakenContextPanel");
    const wrap = app.lastIndexOf("composer-wrap", panel);
    const hint = app.indexOf("composer-hint", panel);
    expect(wrap).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(wrap);
    expect(hint).toBeGreaterThan(panel);
  });

  it("leaves the chat flow to its own neighbours", () => {
    const flow = app.slice(app.indexOf("<KrakenActivity"), app.indexOf("composer-wrap"));
    expect(flow).not.toContain("<KrakenContextPanel");
    expect(flow).toContain("<VerificationStatusCard");
  });

  it("keeps feeding it the same two props", () => {
    const mounted = app.slice(
      app.indexOf("<KrakenContextPanel"),
      app.indexOf("composer-hint"),
    );
    expect(mounted).toContain("live={liveCtx}");
    expect(mounted).toContain("progress={krakenCard?.progress ?? null}");
  });
});

describe("readability: KrakenActivity is class-driven", () => {
  it("has no inline style left", () => {
    expect(activity).not.toContain("style=");
  });

  it("folds the old inline styles into kraken-act-* classes", () => {
    // Lead unification (§19): the lead renders as a plain AgentRow with the
    // `is-lead` modifier — the bespoke kraken-act-lead markup is gone.
    for (const cls of [
      "kraken-act-head",
      "kraken-act-title",
      "kraken-act-bar",
      "kraken-act-body",
      "kraken-act-row",
      "is-lead",
      "kraken-act-reason",
    ]) {
      expect(activity).toContain(cls);
    }
    expect(activity).not.toContain("kraken-act-lead");
  });

  it("keeps the behavioural handles the other tests rely on", () => {
    expect(activity).toContain('aria-label="Kraken Activity"');
    expect(activity).toContain("kraken-thinking-chip");
    expect(activity).toContain("Kraken activity");
    expect(activity).not.toContain("KRAKEN ACTIVITY");
  });
});

describe("readability: PermissionCard density", () => {
  const settled = permission.slice(
    permission.indexOf('if (ask.status !== "pending")'),
    permission.indexOf("const preview = ask.preview"),
  );

  it("renders a settled ask as a one-line chip with no controls", () => {
    expect(settled).toContain("permission-chip");
    expect(settled).toContain("SETTLED_LABEL[ask.status]");
    expect(settled).not.toContain("<button");
    expect(settled).not.toContain("permission-preview");
  });

  it("hides the pending preview behind a collapsible block", () => {
    expect(permission).toContain("permission-preview-block");
    expect(permission).toContain("Show preview (");
  });
});

describe("readability: App.css owns the new skin", () => {
  it("defines the classes the three components render", () => {
    for (const selector of [
      ".kraken-act-head",
      ".kraken-act-bar",
      ".kraken-act-body",
      ".kraken-act-row",
      ".kraken-thinking-chip",
      ".kraken-ctx-strip",
      ".kraken-ctx-line",
      ".kraken-ctx-caret",
      ".kraken-ctx-detail",
      ".permission-card",
      ".permission-category",
      ".permission-preview-block",
      ".permission-preview-summary",
      ".permission-chip",
      ".permission-chip.is-allow",
      ".permission-chip.is-deny",
    ]) {
      expect(css, `missing rule: ${selector}`).toContain(selector);
    }
  });

  it("keeps the panel body and the preview height-capped", () => {
    const body = css.slice(css.indexOf(".kraken-act-body"), css.indexOf(".kraken-act-body") + 200);
    expect(body).toContain("max-height: 220px");
    expect(body).toContain("overflow: auto");
    // The old always-open preview cap (160px) is gone: 140px scroll box now.
    expect(css).not.toContain("max-height: 160px");
  });
});

describe("scroll: detach must survive stream-driven re-renders", () => {
  it("never syncs followStreamRef from the render body (the yank bug)", () => {
    // Render-time sync resurrected `true` when a delta-driven render beat
    // the scroll handler's state commit, reopening the stick-to-bottom gate
    // and pulling the reader back down mid-history.
    expect(app).not.toContain("followStreamRef.current = followStream");
  });

  it("flips ref+state only through the paired setter", () => {
    expect(app).toContain(
      "const setFollowStream = useCallback((v: boolean) => {",
    );
    expect(app).toContain("followStreamRef.current = v;");
    // Nobody bypasses the setter to flip the state alone.
    expect(app).not.toMatch(/_setFollowStream\((?:true|false)\)/);
  });

  it("anchors the reading position while detached, pins while following", () => {
    expect(app).toContain('`chat-scroll${followStream ? "" : " is-detached"}`');
    const rule = css.slice(
      css.indexOf(".chat-scroll.is-detached"),
      css.indexOf(".chat-scroll.is-detached") + 160,
    );
    expect(rule).toContain("overflow-anchor: auto");
    // Base rule keeps anchoring OFF while following: stick-to-bottom owns it.
    expect(css).toContain("overflow-anchor: none");
  });
});

describe("reply: the answer flows in the page, no nested scroll box", () => {
  it("uncaps the reply scroller (was a 60vh inner scrollbar)", () => {
    // The override sits at the END of the cascade and must neutralize the
    // base rule that capped every reply at min(60vh, 720px).
    const scroll = css.lastIndexOf(".reply-accordion-scroll");
    expect(scroll).toBeGreaterThan(css.indexOf(".reply-accordion-scroll"));
    const rule = css.slice(scroll, scroll + 120);
    expect(rule).toContain("max-height: none");
    expect(rule).toContain("overflow: visible");
  });

  it("does not clip the accordion either (plain block in the page flow)", () => {
    const acc = css.lastIndexOf(".reply-accordion {");
    const rule = css.slice(acc, acc + 120);
    expect(rule).toContain("overflow: visible");
  });
});

describe("follow button: icon-only rail affordance (IDE style)", () => {
  it("renders the button only while detached (room left to scroll down)", () => {
    // Same gate as ever: no button at the bottom, button the moment the
    // reader is above the end (with content worth jumping back to).
    expect(app).toContain("{!followStream && (!empty || running) && (");
  });

  it("drops the label block - icon plus missed-count badge only", () => {
    expect(app).not.toContain("btn-follow-stream-label");
    expect(app).not.toContain("btn-follow-stream-kicker");
    expect(app).not.toContain("btn-follow-stream-text");
    // The missed-content count survives as the tiny corner badge.
    expect(app).toContain("btn-follow-stream-pill");
    expect(app).toContain("Vai alla fine");
  });

  it("docks the button on the right rail, next to the scrollbar", () => {
    const idx = css.indexOf("21. Follow button");
    expect(idx).toBeGreaterThan(-1);
    const after = css.slice(idx);
    const start = after.indexOf(".btn-follow-stream,");
    const rule = after.slice(start, start + 200);
    expect(rule).toContain("left: auto");
    expect(rule).toContain("right: 20px");
    expect(after).toContain("@keyframes follow-btn-rail-in");
    // The old centering transform must not sneak back into this section.
    expect(rule).not.toContain("translateX(-50%)");
  });
});
