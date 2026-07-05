import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runImplementationVerification,
  scanKeyframesViolations,
  scanTransitionViolations,
  lintSynthesisHonesty,
} from "../../packages/core/src/council/verification/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zelari-verify-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const TESTMCP_SNIPPET = `<!DOCTYPE html>
<html><head><style>
@keyframes dot-breathe {
  0%, 100% { box-shadow: 0 0 8px blue; }
  50%      { box-shadow: 0 0 14px blue; }
}
details.faq > .faq-body {
  grid-template-rows: 0fr;
  transition: grid-template-rows 320ms ease;
}
.card {
  transition: transform 160ms ease, box-shadow 160ms ease;
}
</style></head>
<body>
<script>
(() => {
  document.documentElement.classList.add('rm');
})();
</script>
</body></html>`;

describe("scanKeyframesViolations", () => {
  it("ignores COMPLIANT-style annotation comments inside @keyframes blocks", () => {
    const html = `<style>
@keyframes pulse-modern {
  /* COMPLIANT: transform + opacity only */
  0%   { transform: scale(0.8); opacity: .5; }
  100% { transform: scale(1); opacity: 1; }
}
</style>`;
    const v = scanKeyframesViolations(html, {
      compositorOnly: true,
      forbidLayoutProps: true,
    });
    expect(v).toHaveLength(0);
  });

  it("flags box-shadow in @keyframes when compositorOnly", () => {
    const v = scanKeyframesViolations(TESTMCP_SNIPPET, {
      compositorOnly: true,
      forbidLayoutProps: true,
    });
    expect(
      v.some((x) => x.property === "box-shadow" && x.kind === "keyframes"),
    ).toBe(true);
  });
});

describe("scanTransitionViolations", () => {
  it("flags grid-template-rows and box-shadow transitions", () => {
    const v = scanTransitionViolations(TESTMCP_SNIPPET, {
      compositorOnly: true,
      forbidLayoutProps: true,
    });
    expect(v.some((x) => x.property === "grid-template-rows")).toBe(true);
    expect(v.some((x) => x.property === "box-shadow")).toBe(true);
  });
});

describe("lintSynthesisHonesty", () => {
  it("flags unverified checkmarks in synthesis", () => {
    const r = lintSynthesisHonesty(
      "Budget rispettati: solo transform/opacity ✓ verificato.",
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe("synthesis.honesty");
  });

  it("passes when Evidence section present", () => {
    const r = lintSynthesisHonesty(
      "## Verification status\n| Check | PASS |\npath: index.html:L10",
    );
    expect(r).toHaveLength(0);
  });
});

describe("runImplementationVerification", () => {
  it("detects TESTMCP-like violations (keyframes, transitions, dead hook)", () => {
    writeFileSync(join(tmpDir, "index.html"), TESTMCP_SNIPPET, "utf8");
    mkdirSync(join(tmpDir, ".zelari"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".zelari", "plan.json"),
      JSON.stringify({
        milestones: [
          {
            name: "v0.2.0",
            description: "command palette, theme toggle, print stylesheet",
          },
        ],
      }),
      "utf8",
    );

    const report = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, ".zelari"),
      synthesisText: "Tutto verificato ✓ nessuna regressione.",
    });

    expect(report.ok).toBe(false);
    expect(
      report.results.some((r) => r.id === "motion.keyframes" && !r.ok),
    ).toBe(true);
    expect(
      report.results.some((r) => r.id === "motion.transitions" && !r.ok),
    ).toBe(true);
    expect(report.results.some((r) => r.id === "css.dead-hook" && !r.ok)).toBe(
      true,
    );
    expect(
      report.results.some((r) => r.id === "synthesis.honesty" && !r.ok),
    ).toBe(true);
    expect(report.results.some((r) => r.id === "plan.reality" && !r.ok)).toBe(
      true,
    );
  });

  it("passes clean compositor-only motion", () => {
    const clean = `<!DOCTYPE html><html><head><style>
.reveal { transition: transform 300ms ease, opacity 300ms ease; }
@keyframes spin { to { transform: rotate(360deg); } }
</style></head><body><script>const x=1;</script></body></html>`;
    writeFileSync(join(tmpDir, "index.html"), clean, "utf8");
    mkdirSync(join(tmpDir, ".zelari"), { recursive: true });

    const report = runImplementationVerification({
      projectRoot: tmpDir,
      zelariRoot: join(tmpDir, ".zelari"),
    });
    const errors = report.results.filter(
      (r) => !r.ok && r.severity === "error",
    );
    expect(errors).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});
