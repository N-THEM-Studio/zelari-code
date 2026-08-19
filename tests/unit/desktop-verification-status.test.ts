import { describe, expect, it } from "vitest";
import { readVerificationRun } from "../../apps/desktop/src/components/VerificationStatusCard";

describe("readVerificationRun", () => {
  it("reads a strict PASS payload", () => {
    const v = readVerificationRun({
      type: "verification_run",
      verdict: "PASS",
      strict: true,
      summary: "open (strict PASS): 2/2",
      legacy: { total: 2, passed: 2, failed: [], unknown: [] },
      evidence: { complete: true, satisfied: ["a", "b"], unsatisfied: [] },
    });
    expect(v).toMatchObject({
      verdict: "PASS",
      strict: true,
      evidenceComplete: true,
      passed: 2,
      total: 2,
    });
  });

  it("treats unknown as not-pass and maps blocked flag", () => {
    const v = readVerificationRun({
      type: "verification_run",
      blocked: true,
      summary: "blocked",
      legacy: { total: 1, passed: 0, failed: [], unknown: ["typecheck"] },
    });
    expect(v?.verdict).toBe("BLOCKED");
    expect(v?.unknown).toEqual(["typecheck"]);
  });

  it("returns null for unrelated events", () => {
    expect(readVerificationRun({ type: "kraken_metrics" })).toBeNull();
    expect(readVerificationRun(null)).toBeNull();
  });
});
