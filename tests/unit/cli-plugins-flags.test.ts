import { describe, it, expect } from "vitest";
import {
  wantsPluginsStatus,
  wantsPluginsInstall,
} from "../../src/cli/plugins/cliFlags";

describe("plugins CLI flags", () => {
  it("detects --plugins-status", () => {
    expect(wantsPluginsStatus(["--plugins-status"])).toBe(true);
    expect(wantsPluginsStatus(["--headless"])).toBe(false);
  });

  it("detects --plugins-install", () => {
    expect(wantsPluginsInstall(["--plugins-install", "playwright"])).toBe(true);
    expect(wantsPluginsInstall([])).toBe(false);
  });
});
