import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runImplementationVerificationHook,
  runPostCouncilHook,
} from "../../src/cli/workspace/postCouncilHook.js";
import { createWorkspaceContext } from "../../src/cli/workspace/stubs.js";

let tmpDir: string;
let ctx: ReturnType<typeof createWorkspaceContext>;

const FAIL_HTML = `<!DOCTYPE html><html><head><style>
@keyframes x { to { box-shadow: none; } }
.card { transition: grid-template-rows 300ms ease; }
</style></head><body><script>document.documentElement.classList.add('rm');</script></body></html>`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zelari-verify-hook-"));
  ctx = createWorkspaceContext(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runImplementationVerificationHook", () => {
  it("skips in design-phase mode", async () => {
    const r = await runImplementationVerificationHook(ctx, {
      runMode: "design-phase",
    });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("design-phase");
  });

  it("runs in implementation mode and writes verification-report.json", async () => {
    writeFileSync(join(tmpDir, "index.html"), FAIL_HTML, "utf8");
    const r = await runImplementationVerificationHook(ctx, {
      runMode: "implementation",
      synthesisText: "Tutto verificato ✓",
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reportPath).toBeTruthy();
    expect(existsSync(join(ctx.rootDir, "verification-report.json"))).toBe(
      true,
    );
    const report = JSON.parse(
      readFileSync(join(ctx.rootDir, "verification-report.json"), "utf8"),
    );
    expect(
      report.results.some((x: { id: string }) => x.id === "motion.keyframes"),
    ).toBe(true);
    expect(
      report.results.some((x: { id: string }) => x.id === "motion.transitions"),
    ).toBe(true);
  });
});

describe("runPostCouncilHook step 3", () => {
  const oldAutofix = process.env.ZELARI_VERIFY_AUTOFIX;
  const oldAgents = process.env.ZELARI_AGENTS_MD;
  const oldLessons = process.env.ZELARI_LESSONS;
  const oldSmoke = process.env.ZELARI_SMOKE;

  afterEach(() => {
    if (oldAutofix === undefined) delete process.env.ZELARI_VERIFY_AUTOFIX;
    else process.env.ZELARI_VERIFY_AUTOFIX = oldAutofix;
    if (oldAgents === undefined) delete process.env.ZELARI_AGENTS_MD;
    else process.env.ZELARI_AGENTS_MD = oldAgents;
    if (oldLessons === undefined) delete process.env.ZELARI_LESSONS;
    else process.env.ZELARI_LESSONS = oldLessons;
    if (oldSmoke === undefined) delete process.env.ZELARI_SMOKE;
    else process.env.ZELARI_SMOKE = oldSmoke;
  });

  it("includes verification in implementation runs (autofix disabled)", async () => {
    process.env.ZELARI_VERIFY_AUTOFIX = "0";
    process.env.ZELARI_AGENTS_MD = "0";
    process.env.ZELARI_LESSONS = "0";
    process.env.ZELARI_SMOKE = "0";
    writeFileSync(join(tmpDir, "index.html"), FAIL_HTML, "utf8");
    const hook = await runPostCouncilHook(ctx, { runMode: "implementation" });
    expect(hook.verification?.ran).toBe(true);
    expect(hook.verification?.ok).toBe(false);
    expect(hook.autofix?.ran).toBe(false);
  });

  it("runs deterministic autofix and re-verifies when motion violations are fixable", async () => {
    process.env.ZELARI_AGENTS_MD = "0";
    process.env.ZELARI_LESSONS = "0";
    process.env.ZELARI_SMOKE = "0";
    writeFileSync(join(tmpDir, "index.html"), FAIL_HTML, "utf8");
    const hook = await runPostCouncilHook(ctx, { runMode: "implementation" });
    expect(hook.verification?.ran).toBe(true);
    expect(hook.autofix?.ran).toBe(true);
    expect(hook.autofix?.applied).toBe(true);
    expect(hook.verification?.ok).toBe(true);
  });
});
