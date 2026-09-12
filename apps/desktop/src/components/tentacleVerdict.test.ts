/**
 * Per-tentacle verification verdict (F3) — contract under test:
 *   - the caption is a WHITELIST over the tokens the CLI really emits
 *     (`taskTool.ts` `emitVerifyPhase`), not a fuzzy guess;
 *   - everything unrecognised — still in flight, no parseable verdict, a
 *     degraded verify run, a missing caption — stays `unknown`, i.e. "—";
 *   - `unknown ≠ pass`: no input in this file may ever produce PASS;
 *   - the mission verdict is passed through unchanged and is absent (undefined)
 *     when the backend sent none.
 */
import { describe, expect, it } from "vitest";
import {
  classifyVerifyCaption,
  readMissionVerdict,
  readTentacleVerdict,
  UNKNOWN_TENTACLE_VERDICT,
} from "./tentacleVerdict";

describe("classifyVerifyCaption — exact tokens from the backend", () => {
  it("maps the captions emitVerifyPhase actually emits", () => {
    expect(classifyVerifyCaption("verify PASS")).toBe("PASS");
    // ADR-0023: "fail present → REPAIR_REQUIRED".
    expect(classifyVerifyCaption("verify FAIL")).toBe("REPAIR_REQUIRED");
    // These two carry NO verdict: the CLI calls them "degraded observation".
    expect(classifyVerifyCaption("verify unknown")).toBe("unknown");
    expect(classifyVerifyCaption("verify failed")).toBe("unknown");
  });

  it("accepts the canonical ADR-0023 tokens if the backend ever emits them", () => {
    expect(classifyVerifyCaption("verify BLOCKED")).toBe("BLOCKED");
    expect(classifyVerifyCaption("verify REPAIR_REQUIRED")).toBe("REPAIR_REQUIRED");
  });

  it("stays unknown for in-flight captions, other captions and junk", () => {
    for (const caption of [
      "verifying…", // t94 in-flight caption
      "phase: general",
      "worktree: wt-impl",
      "merging…",
      "merge ok",
      "verify PASSED", // near-miss: not an exact token
      "VERIFY PASS", // case is part of the emitted contract
      " PASS ",
      "",
      undefined,
      null,
    ]) {
      expect(classifyVerifyCaption(caption)).toBe("unknown");
    }
  });
});

describe("readTentacleVerdict — one row, one signal", () => {
  it("keeps the verbatim caption next to the verdict", () => {
    expect(readTentacleVerdict({ phaseMessage: "verify PASS" })).toEqual({
      verdict: "PASS",
      signal: "verify PASS",
    });
    expect(readTentacleVerdict({ phaseMessage: " verify FAIL " })).toEqual({
      verdict: "REPAIR_REQUIRED",
      signal: "verify FAIL",
    });
  });

  it("returns the shared unknown view when no verdict was emitted", () => {
    expect(readTentacleVerdict({ phaseMessage: "verify unknown" })).toBe(UNKNOWN_TENTACLE_VERDICT);
    expect(readTentacleVerdict({ phaseMessage: "verifying…" })).toBe(UNKNOWN_TENTACLE_VERDICT);
    expect(readTentacleVerdict({}).signal).toBeUndefined();
    expect(readTentacleVerdict(undefined).verdict).toBe("unknown");
  });

  it("never yields PASS without a PASS caption (unknown ≠ pass)", () => {
    const captions = ["", "verifying…", "verify unknown", "verify failed", "phase: general", undefined];
    for (const phaseMessage of captions) {
      expect(readTentacleVerdict({ phaseMessage }).verdict).not.toBe("PASS");
    }
  });
});

describe("readMissionVerdict — passthrough of the verification_run reader", () => {
  it("passes the three policy verdicts through unchanged", () => {
    expect(readMissionVerdict("PASS")).toEqual({ verdict: "PASS", signal: "PASS" });
    expect(readMissionVerdict("REPAIR_REQUIRED")?.verdict).toBe("REPAIR_REQUIRED");
    expect(readMissionVerdict("BLOCKED")?.verdict).toBe("BLOCKED");
  });

  it("is undefined without a verification_run event (no badge, never a PASS)", () => {
    expect(readMissionVerdict(null)).toBeUndefined();
    expect(readMissionVerdict(undefined)).toBeUndefined();
  });
});
