import { describe, it, expect } from "vitest";
import {
  formatCompanionPairing,
  parseCompanionPairing,
  normalizeCompanionUrl,
  isLoopbackHost,
} from "../../apps/desktop/src/companionPairing.js";

describe("normalizeCompanionUrl", () => {
  it("adds http:// when the scheme is missing", () => {
    expect(normalizeCompanionUrl("100.64.1.2:7421")).toBe("http://100.64.1.2:7421");
  });

  it("strips trailing slashes and wrapping quotes", () => {
    expect(normalizeCompanionUrl('"http://100.64.1.2:7421/"')).toBe(
      "http://100.64.1.2:7421",
    );
  });
});

describe("isLoopbackHost", () => {
  it("flags 127.0.0.1 / localhost", () => {
    expect(isLoopbackHost("http://127.0.0.1:7421")).toBe(true);
    expect(isLoopbackHost("http://localhost:7421")).toBe(true);
    expect(isLoopbackHost("http://100.64.1.2:7421")).toBe(false);
  });
});

describe("format / parse companion pairing", () => {
  it("round-trips url + token through zelari://pair", () => {
    const payload = formatCompanionPairing("http://100.64.1.2:7421/", "tok-abc");
    expect(payload.startsWith("zelari://pair?")).toBe(true);
    expect(parseCompanionPairing(payload)).toEqual({
      url: "http://100.64.1.2:7421",
      token: "tok-abc",
    });
  });

  it("parses a JSON payload", () => {
    expect(
      parseCompanionPairing(
        JSON.stringify({ url: "100.64.0.8:7421", token: "t" }),
      ),
    ).toEqual({ url: "http://100.64.0.8:7421", token: "t" });
  });

  it("parses a bare Tailscale http URL", () => {
    expect(parseCompanionPairing("http://100.64.1.2:7421")).toEqual({
      url: "http://100.64.1.2:7421",
      token: "",
    });
  });

  it("returns null for garbage", () => {
    expect(parseCompanionPairing("not a pairing")).toBeNull();
  });
});
