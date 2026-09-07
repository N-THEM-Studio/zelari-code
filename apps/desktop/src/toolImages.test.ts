import { describe, expect, it } from "vitest";
import { extractImagePathsFromToolResult } from "./toolImages";

describe("extractImagePathsFromToolResult", () => {
  it("reads the screenshot tool JSON path (Windows escaped backslashes)", () => {
    const raw = `{\n  "ok": true,\n  "path": "Z:\\\\proj\\\\.zelari\\\\screenshots\\\\screenshot-2026-09-07T01-02-03.png",\n  "bytes": 1234\n}`;
    const out = extractImagePathsFromToolResult(raw);
    expect(out).toEqual(["Z:\\proj\\.zelari\\screenshots\\screenshot-2026-09-07T01-02-03.png"]);
  });

  it("reads browser_check screenshotPath (posix)", () => {
    const raw = `{\n  "ok": true,\n  "screenshotPath": "/tmp/zelari-browser-1788.png"\n}`;
    expect(extractImagePathsFromToolResult(raw)).toEqual(["/tmp/zelari-browser-1788.png"]);
  });

  it("falls back to a raw path regex when the text is not JSON", () => {
    const raw = "Screenshot saved: C:\\Users\\me\\shot-1.PNG please review";
    expect(extractImagePathsFromToolResult(raw)).toEqual(["C:\\Users\\me\\shot-1.PNG"]);
  });

  it("ignores non-image paths and non-path JSON", () => {
    expect(extractImagePathsFromToolResult('{ "ok": true, "path": "Z:\\proj\\index.html" }')).toEqual([]);
    expect(extractImagePathsFromToolResult("no paths here")).toEqual([]);
  });

  it("caps the number of extracted paths", () => {
    const raw = [1, 2, 3, 4, 5, 6]
      .map((i) => `{ "path": "/tmp/s-${i}.png" }`)
      .join("\n");
    expect(extractImagePathsFromToolResult(raw).length).toBeLessThanOrEqual(4);
  });
});
