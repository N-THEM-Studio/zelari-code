// @vitest-environment node
/**
 * grok-round wiring contract (RED-IF-REOPENS).
 *
 * App.tsx cannot be rendered in a unit test — importing it pulls the whole
 * Tauri surface (dialogs, updater, agent events) — so the parts of the change
 * that live in App are pinned at the source level, the same idiom the repo
 * already uses for wiring contracts
 * (src/cli/safety/headlessPolicyWiring.contract.test.ts, cors.test.ts).
 *
 * What must stay true:
 *   - the topbar no longer hosts ProviderModelBar (the whole point of the
 *     round) and the pills are mounted INSIDE the composer capsule;
 *   - the empty conversation is centered by a class derived from the existing
 *     `empty && !running` render condition — no new state;
 *   - rename goes through the existing store helper (`setConversations` mapped
 *     by id) and refuses an empty title, and the Sidebar is wired to it.
 *
 * This file fails on the exact regression it describes, not on formatting.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

/** Everything between two markers, starting the search for `end` after `start`. */
function between(src: string, startMarker: string, endMarker: string): string {
  // Sources are checked out CRLF on win32, but every end marker in this file is
  // written with LF ("\n  );\n});"). Normalize before indexing so the contract
  // pins the wiring, not the checkout's line endings.
  const n = src.replace(/\r\n/g, "\n");
  const start = n.indexOf(startMarker);
  expect(start, `missing marker: ${startMarker}`).toBeGreaterThan(-1);
  const end = n.indexOf(endMarker, start);
  expect(end, `missing marker: ${endMarker}`).toBeGreaterThan(start);
  return n.slice(start, end);
}

const app = read("../App.tsx");
const composerSrc = read("./Composer.tsx");
const pills = read("./ComposerToolbar.tsx");

describe("grok-round: the topbar is liberated", () => {
  const topbar = between(app, 'className="topbar glass-capsule"', "</header>");

  it("mounts no provider/model bar and no mode toggles", () => {
    expect(topbar).not.toContain("ProviderModelBar");
    expect(topbar).not.toContain("model-chip");
    for (const toggle of [
      "ModeToggle",
      "PhaseToggle",
      "KrakenGraphToggle",
      "GauntletToggle",
    ]) {
      expect(topbar).not.toContain(`<${toggle}`);
      // …and each one really is inside the composer pill now.
      expect(pills).toContain(`<${toggle}`);
    }
    // App does not even import the bar any more: it lives in the popover.
    expect(app).not.toContain("<ProviderModelBar");
  });

  it("keeps title, todos and the folder picker", () => {
    expect(topbar).toContain("topbar-title");
    expect(topbar).toContain("todo-chip");
    expect(topbar).toContain("topbar-folder");
    expect(topbar).toContain("pickFolder");
  });
});

describe("grok-round: the pills live in the composer", () => {
  // The capsule moved into Composer.tsx (W3.2): pin its internals there, and
  // the toolbar wiring where the props are now fed — App passes a `toolbar` bag.
  const composer = between(
    composerSrc,
    "className={`composer glass-capsule",
    "\n  );\n});",
  );
  const mounted = between(
    composerSrc,
    "<ComposerToolbar {...toolbar} />",
    'className="composer-actions"',
  );
  const toolbarProps = between(app, "toolbar={{", "onSubmit={");

  it("mounts ComposerToolbar inside the capsule, before the send row", () => {
    expect(composer).toContain("<ComposerToolbar");
    expect(composer).toContain("composer-actions"); // send/stop untouched
  });

  it("feeds it the same handlers and props the topbar used", () => {
    for (const prop of [
      "config,",
      "provider,",
      "model,",
      "onProviderChange,",
      "onModelChange,",
      "onThinkingChange,",
      "onConfigRefresh: setConfig,",
      "onStatus: setStatusLine,",
      "permissionPreset: prefs.permissionPreset,",
      "onModeChange,",
      "onPhaseChange,",
      "onKrakenGraphChange: setGraphMode,",
      "onGauntletChange: setGauntletLoop,",
    ]) {
      expect(toolbarProps).toContain(prop);
    }
  });

  it("disables only the choices (never the input) while running", () => {
    expect(toolbarProps).toContain("disabled: running");
    // The pills block holds the choices only — steer/queue are untouched…
    expect(mounted).not.toContain("<textarea");
    // …and the composer's one textarea is never disabled.
    const textarea = between(composerSrc, "<textarea", "/>");
    expect(textarea).not.toContain("disabled");
  });

  it("writes the permission preset through the Settings path", () => {
    expect(toolbarProps).toContain(
      "patchDesktopPrefs(prev, { permissionPreset })",
    );
  });
});

describe("grok-round: empty conversation centers greeting + composer", () => {
  it("uses a class derived from the existing render condition", () => {
    expect(app).toContain('`main${empty && !running ? " is-empty" : ""}`');
    // Same predicate the empty-state branch uses — no second source of truth.
    expect(app).toContain("{empty && !running ? (");
    expect(app).toContain('<div className="empty-state">');
  });
});

describe("grok-round: rename is stored by id and refuses an empty title", () => {
  const handler = between(app, "const renameChat", "const archiveChat");

  it("trims, refuses empty and maps by id (no duplicate row, no re-sort)", () => {
    expect(handler).toContain("const next = title.trim();");
    expect(handler).toContain("if (!next) return;");
    expect(handler).toContain("setConversations((prev) =>");
    expect(handler).toContain("{ ...c, title: next }");
    expect(handler).toContain("c.id === id ?");
    // updatedAt is deliberately left alone: the list is ordered by it.
    expect(handler).not.toContain("updatedAt");
  });

  it("wires the Sidebar to it", () => {
    expect(between(app, "<Sidebar", "/>")).toContain("onRename={renameChat}");
  });
});

describe("grok-round: no forbidden accent crept into the stylesheet", () => {
  const css = read("../App.css");

  it("keeps the grok-flat palette (no cyan, no violet)", () => {
    expect(css).not.toMatch(/#00e5ff/i);
    expect(css).not.toMatch(/#c084fc/i);
  });

  it("appends the round as its own marked section after the grok-flat block", () => {
    expect(css.indexOf("grok-flat refresh")).toBeLessThan(
      css.indexOf("grok-round (composer pills"),
    );
    // The three behaviours the section is responsible for.
    for (const selector of [
      ".composer-pills",
      ".composer-popover",
      ".session-item-rename",
      ".main.is-empty .composer-wrap",
    ]) {
      expect(css).toContain(selector);
    }
  });
});
