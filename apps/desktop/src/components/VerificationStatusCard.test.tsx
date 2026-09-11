// @vitest-environment jsdom
/**
 * VerificationStatusCard.test — Phase 5 evidence pack UI (ADR-0023/0028).
 *
 * Contract under test:
 *   - readVerificationRun parses the per-criterion breakdown from
 *     `native` (F2 pack) and `compiled` (t22) payload sections;
 *   - required flags come from the sibling `criteria` list;
 *   - evidence keeps `seq` when present (event-backed) and degrades to
 *     the tier label when not — `unknown ≠ pass` stays visible;
 *   - the card renders criterion rows with status and evidence anchors;
 *   - legacy payloads (no native/compiled) render no criteria section.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  readVerificationRun,
  VerificationStatusCard,
  type VerificationRunView,
} from "./VerificationStatusCard";

afterEach(cleanup);

function payload(native?: unknown, compiled?: unknown): Record<string, unknown> {
  return {
    type: "verification_run",
    strict: true,
    verdict: "PASS",
    engine: "kraken-legacy+completion-policy+criteria-pack",
    legacy: { total: 3, passed: 2, failed: [], unknown: [] },
    evidence: { satisfied: 2, unsatisfied: 0, complete: true, provenance: null },
    ...(native ? { native } : {}),
    ...(compiled ? { compiled } : {}),
  };
}

describe("readVerificationRun — evidence pack (Phase 5)", () => {
  it("parses native pack results with required flags and evidence seq", () => {
    const view = readVerificationRun(
      payload({
        packId: "native-v1",
        criteria: [
          { id: "build", required: true },
          { id: "tests", required: true },
          { id: "smoke", required: false },
        ],
        results: [
          {
            criterionId: "build",
            status: "pass",
            evidence: [{ tier: "command-output", ref: "npm run build", seq: 42 }],
          },
          {
            criterionId: "tests",
            status: "unknown",
            evidence: [{ tier: "command-output", ref: "npm test" }],
          },
          { criterionId: "smoke", status: "pass", evidence: [] },
        ],
      }),
    );
    expect(view).not.toBeNull();
    expect(view!.results).toHaveLength(3);
    const build = view!.results[0];
    expect(build.origin).toBe("pack");
    expect(build.criterionId).toBe("build");
    expect(build.required).toBe(true);
    expect(build.status).toBe("pass");
    expect(build.evidence[0].seq).toBe(42);
    const tests = view!.results[1];
    expect(tests.status).toBe("unknown");
    expect(tests.evidence[0].seq).toBeUndefined();
    expect(view!.results[2].required).toBe(false);
  });

  it("merges compiled results after pack results, both origins labeled", () => {
    const view = readVerificationRun(
      payload(
        {
          criteria: [{ id: "build", required: true }],
          results: [
            { criterionId: "build", status: "pass", evidence: [] },
          ],
        },
        {
          criteria: [{ id: "verify.custom", required: true }],
          results: [
            {
              criterionId: "verify.custom",
              status: "fail",
              detail: "exit 1",
              evidence: [{ tier: "command-output", ref: "npm run check", seq: 7 }],
            },
          ],
        },
      ),
    );
    expect(view!.results.map((r) => r.origin)).toEqual(["pack", "compiled"]);
    expect(view!.results[1].status).toBe("fail");
    expect(view!.results[1].detail).toBe("exit 1");
  });

  it("legacy payload (no native/compiled) yields empty results, not an error", () => {
    const view = readVerificationRun(payload());
    expect(view).not.toBeNull();
    expect(view!.results).toEqual([]);
  });

  it("malformed sections are dropped defensively", () => {
    const view = readVerificationRun(
      payload({
        criteria: "nope",
        results: [null, 3, { criterionId: "", status: "pass" }, { criterionId: "ok", status: "weird" }],
      }),
    );
    expect(view!.results).toHaveLength(1);
    expect(view!.results[0].criterionId).toBe("ok");
    expect(view!.results[0].status).toBe("unknown");
  });
});

describe("VerificationStatusCard — criteria rendering (Phase 5)", () => {
  function packView(): VerificationRunView {
    const view = readVerificationRun(
      payload({
        criteria: [
          { id: "build", required: true },
          { id: "tests", required: true },
          { id: "smoke", required: false },
        ],
        results: [
          {
            criterionId: "build",
            status: "pass",
            evidence: [{ tier: "command-output", ref: "npm run build", seq: 42 }],
          },
          { criterionId: "tests",
            status: "unknown",
            evidence: [{ tier: "command-output", ref: "npm test" }] },
          { criterionId: "smoke", status: "fail", evidence: [] },
        ],
      }),
    );
    return view!;
  }

  it("renders one row per criterion with status and evidence anchor", () => {
    render(<VerificationStatusCard run={packView()} />);
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("tests")).toBeTruthy();
    expect(screen.getByText("smoke · optional")).toBeTruthy();
    expect(screen.getByText("seq 42")).toBeTruthy();
    expect(screen.getByText("command-output")).toBeTruthy();
    expect(screen.getByText("no evidence")).toBeTruthy();
    const rows = document.querySelectorAll(".verification-card-criterion");
    expect(rows.length).toBe(3);
    expect(rows[0].getAttribute("data-status")).toBe("pass");
    expect(rows[1].getAttribute("data-status")).toBe("unknown");
    expect(rows[2].getAttribute("data-status")).toBe("fail");
  });

  it("caps the list at 6 rows with a +N overflow line", () => {
    const base = packView();
    const many = {
      ...base,
      results: Array.from({ length: 9 }, (_, i) => ({
        origin: "pack" as const,
        criterionId: `c${i}`,
        required: true,
        status: "pass" as const,
        evidence: [],
      })),
    };
    render(<VerificationStatusCard run={many} />);
    expect(screen.getByText("+3 more")).toBeTruthy();
    const rows = document.querySelectorAll(".verification-card-criterion");
    expect(rows.length).toBe(7); // 6 criteria + overflow line
  });

  it("legacy run renders no criteria section", () => {
    const legacy = readVerificationRun(payload())!;
    render(<VerificationStatusCard run={legacy} />);
    expect(document.querySelector(".verification-card-criteria")).toBeNull();
  });
});
