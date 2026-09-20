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
  // IDE round: the topbar ROW itself is retired — the chat tab bar is the only
  // chrome above the chat, so these pins target its right-hand cluster.
  const topbar = between(app, 'className="chat-tabs-right"', "</div>");

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

  it("keeps todos and the folder picker in the tab-bar cluster", () => {
    expect(topbar).toContain("todo-chip");
    expect(topbar).toContain("topbar-folder");
    expect(topbar).toContain("pickFolder");
    // The standalone topbar row — and the title echo it used to carry — are
    // gone for good: the tab strip names the conversation now.
    expect(app).not.toContain("topbar glass-capsule");
    expect(app).not.toContain("<header");
    expect(app).not.toContain("topbar-title");
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

describe("activity compaction: containers shrink, data stays", () => {
  const css = read("../App.css");

  it("compacts the live stage in a marked section after the IDE-round block", () => {
    // The override must sit AFTER the grok-flat surface (§13) to win the cascade.
    expect(css.indexOf("grok-flat refresh")).toBeLessThan(
      css.indexOf("16. compact activity surfaces"),
    );
    const section = css.slice(css.indexOf("16. compact activity surfaces"));

    // 16a — the live stage card becomes a slim strip (base §2320: 14px 18px,
    // 64px min-height, 12px orb).
    const card = section.slice(
      section.indexOf(".run-activity {"),
      section.indexOf(".run-activity-orb"),
    );
    expect(card).toContain("padding: 7px 11px");
    expect(card).toContain("min-height: 0");
    expect(section).toContain("width: 8px");
    expect(section).toContain("max-height: 92px");

    // 16b — the Kraken panel body cap drops (base: 220px → 150px) and the
    // rows tighten; every datum (glyph/status/dur/model/chip/tools) stays.
    const body = section.slice(
      section.indexOf(".kraken-act-body"),
      section.indexOf(".kraken-act-rows"),
    );
    expect(body).toContain("max-height: 150px");
    // Type scale RESTORED: §16b keeps geometry only — the 0.82em panel shrink
    // is gone, the base .kraken-act font applies again.
    expect(section).not.toContain("font-size: 0.82em");
    expect(section).toContain("padding: 1px 6px");
  });

  it("keeps every rendered datum — no row, chip or feed selector is deleted", () => {
    // Compaction is geometry only: these selectors must still exist somewhere.
    for (const selector of [
      ".kraken-act-agent",
      ".kraken-act-dur",
      ".kraken-act-model",
      ".kraken-thinking-chip",
      ".kraken-act-toolrow",
      ".kraken-act-warn",
      ".run-activity-steps",
      ".run-activity-step-sum",
    ]) {
      expect(css).toContain(selector);
    }
  });


  it("renders the lead as an AgentRow — aligned and expandable (§19)", () => {
    // The lead lives in the SAME row container as the tentacles (aligned,
    // clickable); the bespoke lead markup is gone for good.
    expect(css).toContain(".kraken-act-row.is-lead");
    expect(css).not.toContain(".kraken-act-lead");
    // The stripe must not shift content: every row gets the border first,
    // colors come later (§20).
    expect(css.indexOf(".kraken-act-rows .kraken-act-row {")).toBeGreaterThan(-1);
    expect(css.indexOf(".kraken-act-rows .kraken-act-row {")).toBeLessThan(
      css.indexOf(".kraken-act-rows .kraken-act-row.is-lead"),
    );
    const src = read("../components/KrakenActivity.tsx");
    expect(src).toContain("isLead");
    expect(src).not.toContain("kraken-act-lead");
  });

  it("colors a status stripe on EVERY row (§20), the lead stays accent", () => {
    // §20 sits AFTER §19 so its status colors (and the final lead rule) win.
    expect(css.indexOf("19. aligned lead row")).toBeLessThan(
      css.indexOf("20. status stripes"),
    );
    const section = css.slice(css.indexOf("20. status stripes"));
    for (const cls of [
      ".kraken-act-rows .kraken-act-row.is-running",
      ".kraken-act-rows .kraken-act-row.is-completed",
      ".kraken-act-rows .kraken-act-row.is-failed",
      ".kraken-act-rows .kraken-act-row.is-waiting",
    ]) {
      expect(section).toContain(cls);
    }
    // The lead rule comes LAST in §20: the orchestrator stays accent even
    // when its own status would color the stripe otherwise.
    expect(section.lastIndexOf(".kraken-act-row.is-lead")).toBeGreaterThan(
      section.lastIndexOf(".kraken-act-row.is-failed"),
    );
    // The component stamps the status class on EVERY row, not just running.
    const src = read("../components/KrakenActivity.tsx");
    expect(src).toContain("is-${agent.status");
  });
  it("flattens the reasoning stage to one inline line (§18 wins over §16a)", () => {
    // §18 must sit AFTER §16a/§17 so the one-line strip wins the cascade.
    expect(css.indexOf("16. compact activity surfaces")).toBeLessThan(
      css.indexOf("18. Reasoning strip"),
    );
    const section = css.slice(css.indexOf("18. Reasoning strip"));

    // Card chrome goes: no box, no blur, no radius, hairline padding.
    const card = section.slice(
      section.indexOf(".run-activity {"),
      section.indexOf(".run-activity-orb"),
    );
    expect(card).toContain("background: none");
    expect(card).toContain("backdrop-filter: none");
    expect(card).toContain("padding: 1px 0 2px");
    expect(card).toContain("border: none");

    // One flowing line: kicker carries the "·" separator, title/sub go
    // inline, the tool feed becomes inline chips (no stacked rows, no
    // inner scroll cap).
    expect(section).toContain('content: "·"');
    expect(section).toContain("display: inline");
    expect(section).toContain("flex-direction: row");
    expect(section).toContain("max-height: none");

    // Every datum keeps a selector inside the section (kicker, rotating
    // title, sub, tool names, +N toggle) — geometry only, nothing dropped.
    for (const selector of [
      ".run-activity-kicker",
      ".run-activity-title",
      ".run-activity-sub",
      ".run-activity-step-name",
      ".run-activity-steps-toggle",
    ]) {
      expect(section).toContain(selector);
    }
  });
});

describe("sidebar row actions: reveal on hover only (IDE round \u00a722)", () => {
  const css = read("../App.css");
  const idx = css.indexOf("22. SIDEBAR ROW ACTIONS");
  expect(idx).toBeGreaterThan(-1);
  // Last section of the file: everything from the marker on is the contract.
  const section = css.slice(idx);

  it("hides the buttons by default and while merely active", () => {
    expect(section).toMatch(/\.session-actions\s*\{[^}]*opacity:\s*0/);
    expect(section).toMatch(/\.session-actions\s*\{[^}]*visibility:\s*hidden/);
    // The base sheet's `.active` reveal must be overridden, not just matched.
    expect(section).toMatch(
      /\.session-item-wrap\.active \.session-actions\s*\{[^}]*opacity:\s*0/,
    );
    expect(section).toMatch(
      /\.session-item-wrap\.active \.session-actions\s*\{[^}]*visibility:\s*hidden/,
    );
  });

  it("reveals them only on pointer hover or keyboard focus", () => {
    expect(section).toContain(".session-item-wrap:hover .session-actions");
    expect(section).toContain(".session-item-wrap:focus-within .session-actions");
    expect(section).toMatch(
      /:focus-within \.session-actions\s*\{[^}]*visibility:\s*visible/,
    );
  });

  it("keeps hidden buttons out of hit-testing (visibility, not just opacity)", () => {
    expect(section).toMatch(/transition:[^;]*visibility/);
  });
});

describe("23. project panel head — branch chip on its own full row", () => {
  const css = read("../App.css");
  const idx = css.indexOf("23. PROJECT PANEL HEAD");
  expect(idx).toBeGreaterThan(-1);
  // Last section of the file: everything from the marker on is the contract.
  const section = css.slice(idx);

  it("stacks the head in two rows instead of one nowrap squeeze", () => {
    expect(section).toMatch(/\.project-panel-head\s*\{[^}]*flex-direction:\s*column/);
    expect(section).toMatch(/\.project-panel-head\s*\{[^}]*align-items:\s*stretch/);
    expect(section).toContain(".project-head-row");
    expect(section).toMatch(/\.project-head-actions\s*\{[^}]*margin-left:\s*auto/);
  });

  it("gives the branch chip the full row width with the ellipsis on the name only", () => {
    expect(section).toContain(".git-branch-row");
    expect(section).toMatch(/\.git-branch\s*\{[^}]*flex:\s*1 1 auto/);
    expect(section).toMatch(/\.git-branch-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it("ProjectPanel renders the branch as its own row (not inline in the head)", () => {
    const src = read("../components/ProjectPanel.tsx");
    expect(src).toContain('className="git-branch-row"');
    expect(src).toContain('className="project-head-actions"');
    // The chip carries an icon + name span, so the ellipsis can hit the
    // text without clipping the glyph.
    expect(src).toContain("git-branch-icon");
    expect(src).toContain("git-branch-name");
  });

  it("the section stays after the §22 sidebar rules in the cascade", () => {
    // Ordering is checked on the FULL sheet: §22 lives before this section.
    expect(css.indexOf("22. SIDEBAR ROW ACTIONS")).toBeGreaterThan(-1);
    expect(css.indexOf("23. PROJECT PANEL HEAD")).toBeGreaterThan(
      css.indexOf("22. SIDEBAR ROW ACTIONS"),
    );
  });
});
