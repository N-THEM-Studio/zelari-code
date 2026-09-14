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
    for (const cls of [
      "kraken-act-head",
      "kraken-act-title",
      "kraken-act-bar",
      "kraken-act-body",
      "kraken-act-row",
      "kraken-act-lead",
      "kraken-act-reason",
    ]) {
      expect(activity).toContain(cls);
    }
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
