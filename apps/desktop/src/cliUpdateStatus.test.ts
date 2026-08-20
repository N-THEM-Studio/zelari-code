import { describe, expect, it } from "vitest";
import { cmpSemver, resolveCliUpdateStatus } from "./cliUpdateStatus";

describe("cmpSemver", () => {
  it("ranks a prerelease below the matching release", () => {
    // Regression: naive numeric compare treated `2.0.0-alpha.4` as equal to
    // `2.0.0` (parseInt("0-alpha") === 0), so Settings claimed the CLI was up
    // to date and disabled "Update CLI".
    expect(cmpSemver("2.0.0-alpha.4", "2.0.0")).toBe(-1);
    expect(cmpSemver("2.0.0", "2.0.0-alpha.4")).toBe(1);
  });

  it("treats equal releases as equal", () => {
    expect(cmpSemver("2.0.0", "2.0.0")).toBe(0);
    expect(cmpSemver("v2.0.0", "2.0.0")).toBe(0);
  });

  it("orders prereleases among themselves", () => {
    expect(cmpSemver("2.0.0-alpha.4", "2.0.0-alpha.5")).toBe(-1);
    expect(cmpSemver("2.0.0-alpha.5", "2.0.0-beta.1")).toBe(-1);
    expect(cmpSemver("1.46.1", "2.0.0")).toBe(-1);
  });
});

describe("resolveCliUpdateStatus", () => {
  it("flags an update when installed is a prerelease and npm latest is the release", () => {
    // Backend from an older Desktop build would report updateAvailable:false
    // and message "CLI is up to date (v2.0.0-alpha.4) on npm latest."
    const r = resolveCliUpdateStatus({
      installed: "2.0.0-alpha.4",
      npmLatest: "2.0.0",
      channel: "latest",
      updateAvailable: false,
      message: "CLI is up to date (v2.0.0-alpha.4) on npm latest.",
    });
    expect(r.updateAvailable).toBe(true);
    expect(r.upToDate).toBe(false);
    expect(r.message).toContain("Use Update CLI to upgrade");
    expect(r.message).toContain("2.0.0-alpha.4");
    expect(r.message).toContain("2.0.0");
  });

  it("reports up to date only when versions actually match", () => {
    const r = resolveCliUpdateStatus({
      installed: "2.0.0",
      npmLatest: "2.0.0",
      channel: "latest",
      updateAvailable: false,
      message: "CLI is up to date (v2.0.0) on npm latest.",
    });
    expect(r.updateAvailable).toBe(false);
    expect(r.upToDate).toBe(true);
  });

  it("keeps the backend message when the backend already flags an update", () => {
    const r = resolveCliUpdateStatus({
      installed: "1.46.1",
      npmLatest: "2.0.0",
      channel: "latest",
      updateAvailable: true,
      message: "CLI is v1.46.1; npm latest is v2.0.0. Use Update CLI to upgrade.",
    });
    expect(r.updateAvailable).toBe(true);
    expect(r.upToDate).toBe(false);
    expect(r.message).toContain("Use Update CLI to upgrade");
  });

  it("suggests an install command when the CLI is missing", () => {
    const r = resolveCliUpdateStatus({ installed: null, npmLatest: "2.0.0" });
    expect(r.updateAvailable).toBe(true);
    expect(r.upToDate).toBe(false);
    expect(r.message).toContain("npm i -g zelari-code@2.0.0");
  });
});
