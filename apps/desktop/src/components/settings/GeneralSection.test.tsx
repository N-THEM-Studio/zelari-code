// @vitest-environment jsdom
/**
 * GeneralSection — the "Accent color" row (Settings → Appearance).
 *
 * Pins the contract the accent slice depends on: a preset / Auto / custom pick
 * leaves the section as the hex (or "") the App pushes onto `.app`, and Auto is
 * the pressed state while no accent is chosen. Queries are scoped to the row's
 * own group: the baffetti presets reuse some of the same labels.
 * GeneralSection is pure props (no Tauri surface), so it renders like any leaf.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSection, type GeneralSectionProps } from "./GeneralSection";

vi.mock("react", async () => {
  // Direct .js import on purpose: it must resolve to the ROOT React copy
  // regardless of the nested apps/desktop/node_modules install (same pin as
  // AgentsSection.test.tsx).
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../../node_modules/react/index.js");
});

afterEach(cleanup);

function props(
  overrides: Partial<GeneralSectionProps> = {},
): GeneralSectionProps {
  return {
    theme: "dark",
    onThemeChange: () => {},
    defaultMode: "kraken",
    defaultPhase: "build",
    onDefaultsChange: () => {},
    profile: "kraken/v1",
    onProfileChange: () => {},
    mustacheColor: "#d8d8dc",
    onMustacheColorChange: () => {},
    onAccentColorChange: () => {},
    ...overrides,
  };
}

const accentRow = (): HTMLElement =>
  screen.getByRole("group", { name: "Accent color" });

const accentButton = (name: string): HTMLElement =>
  within(accentRow()).getByRole("button", { name });

const pressed = (name: string): string | null =>
  accentButton(name).getAttribute("aria-pressed");

describe("GeneralSection — accent color", () => {
  it("starts on Auto and reports the preset that was picked", () => {
    const onAccentColorChange = vi.fn();
    render(<GeneralSection {...props({ onAccentColorChange })} />);

    expect(pressed("Auto — follow the mode")).toBe("true");
    fireEvent.click(accentButton("Amber"));
    expect(onAccentColorChange).toHaveBeenCalledWith("#f5b642");
  });

  it("marks the active accent and clears back to Auto with an empty value", () => {
    const onAccentColorChange = vi.fn();
    render(
      <GeneralSection
        {...props({ accentColor: "#f5b642", onAccentColorChange })}
      />,
    );

    expect(pressed("Amber")).toBe("true");
    expect(pressed("Cyan")).toBe("false");
    expect(pressed("Auto — follow the mode")).toBe("false");
    fireEvent.click(accentButton("Auto — follow the mode"));
    expect(onAccentColorChange).toHaveBeenCalledWith("");
  });

  it("adds the custom picker without disturbing the baffetti row", () => {
    render(<GeneralSection {...props()} />);

    fireEvent.change(within(accentRow()).getByLabelText("Custom accent color"), {
      target: { value: "#123456" },
    });
    expect(screen.getByLabelText("Custom baffetti color")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Baffetti color" })).toBeTruthy();
  });
});
