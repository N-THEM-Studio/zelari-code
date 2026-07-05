#!/usr/bin/env node
/**
 * verify-council — CI contract for council verification engine.
 * Runs deterministic checks on fixtures; exit 0 only when expectations match.
 *
 * Env:
 *   VERIFY_FIXTURE_ROOT — single fixture dir (optional)
 *   VERIFY_EXPECT_OK=1 — expect report.ok when using VERIFY_FIXTURE_ROOT
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const { runImplementationVerification } = await import("@zelari/core/council");

function assert(cond, msg) {
  if (!cond) {
    console.error(`[verify-council] FAIL: ${msg}`);
    process.exit(1);
  }
}

async function verifyFixture(relPath, expect) {
  const projectRoot = process.env.VERIFY_FIXTURE_ROOT
    ? process.env.VERIFY_FIXTURE_ROOT
    : join(repoRoot, "tests/fixtures/council-complete", relPath);
  const zelariRoot = join(projectRoot, ".zelari");
  if (!existsSync(zelariRoot)) {
    mkdirSync(zelariRoot, { recursive: true });
  }

  const report = runImplementationVerification({
    projectRoot,
    zelariRoot,
    synthesisText: expect.synthesisText,
    degradedRun: expect.degradedRun,
  });

  if (expect.ok !== undefined) {
    assert(
      report.ok === expect.ok,
      `${relPath}: expected ok=${expect.ok}, got ${report.ok}`,
    );
  }
  if (expect.minFails !== undefined) {
    const fails = report.results.filter((r) => !r.ok);
    assert(
      fails.length >= expect.minFails,
      `${relPath}: expected >=${expect.minFails} fails, got ${fails.length}`,
    );
  }
  if (expect.checkIds) {
    for (const id of expect.checkIds) {
      assert(
        report.results.some((r) => r.id === id && !r.ok),
        `${relPath}: expected failing check ${id}`,
      );
    }
  }

  console.log(
    `[verify-council] OK — ${relPath} (${report.results.filter((r) => !r.ok).length} fail(s))`,
  );
}

if (process.env.VERIFY_FIXTURE_ROOT) {
  const expectOk = process.env.VERIFY_EXPECT_OK === "1";
  await verifyFixture(
    "custom",
    expectOk ? { ok: true } : { ok: false, minFails: 1 },
  );
} else {
  await verifyFixture("clean", { ok: true });
  await verifyFixture("testmcp-like", {
    ok: false,
    minFails: 3,
    checkIds: ["motion.keyframes", "motion.transitions", "css.dead-hook"],
  });
}

console.log("[verify-council] all fixtures passed");
