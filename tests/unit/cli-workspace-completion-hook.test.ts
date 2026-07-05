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
import { runPostCouncilHook } from "../../src/cli/workspace/postCouncilHook.js";
import { createWorkspaceContext } from "../../src/cli/workspace/stubs.js";

const FAIL_HTML = `<!DOCTYPE html><html><head><style>
@keyframes x { to { box-shadow: none; } }
</style></head><body><script>document.documentElement.classList.add('rm');</script></body></html>`;

let tmpDir: string;
let ctx: ReturnType<typeof createWorkspaceContext>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zelari-completion-hook-"));
  ctx = createWorkspaceContext(tmpDir);
  writeFileSync(join(tmpDir, "index.html"), FAIL_HTML, "utf8");
  writeFileSync(
    join(tmpDir, "package.json"),
    JSON.stringify({
      scripts: { typecheck: 'node -e "process.exit(0)"' },
    }),
    "utf8",
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runPostCouncilHook completion + smoke", () => {
  const oldSmoke = process.env.ZELARI_SMOKE;
  const oldAgents = process.env.ZELARI_AGENTS_MD;
  const oldLessons = process.env.ZELARI_LESSONS;
  const oldAutofix = process.env.ZELARI_VERIFY_AUTOFIX;

  afterEach(() => {
    if (oldSmoke === undefined) delete process.env.ZELARI_SMOKE;
    else process.env.ZELARI_SMOKE = oldSmoke;
    if (oldAgents === undefined) delete process.env.ZELARI_AGENTS_MD;
    else process.env.ZELARI_AGENTS_MD = oldAgents;
    if (oldLessons === undefined) delete process.env.ZELARI_LESSONS;
    else process.env.ZELARI_LESSONS = oldLessons;
    if (oldAutofix === undefined) delete process.env.ZELARI_VERIFY_AUTOFIX;
    else process.env.ZELARI_VERIFY_AUTOFIX = oldAutofix;
  });

  it("writes completion.json with readyToCommit=false on verify FAIL", async () => {
    process.env.ZELARI_VERIFY_AUTOFIX = "0";
    process.env.ZELARI_AGENTS_MD = "0";
    process.env.ZELARI_LESSONS = "0";
    const hook = await runPostCouncilHook(ctx, { runMode: "implementation" });
    expect(hook.completion?.ran).toBe(true);
    expect(existsSync(join(ctx.rootDir, "completion.json"))).toBe(true);
    const completion = JSON.parse(
      readFileSync(join(ctx.rootDir, "completion.json"), "utf8"),
    );
    expect(completion.readyToCommit).toBe(false);
    expect(completion.blocking.length).toBeGreaterThan(0);
    expect(hook.smoke?.ran).toBe(true);
    expect(hook.smoke?.ok).toBe(true);
  }, 60_000);
});
