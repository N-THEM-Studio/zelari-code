#!/usr/bin/env node
/**
 * replay-testmcp — deterministic replay of post-council pipeline on TESTMCP.
 * Does NOT call LLM APIs; simulates what /council produces after Lucifero's turn.
 *
 * Usage:
 *   node scripts/replay-testmcp.mjs [TESTMCP_ROOT]
 *   TESTMCP_ROOT defaults to ../TESTMCP relative to repo root.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const testmcpRoot = resolve(
  process.argv[2] ?? join(repoRoot, "..", "TESTMCP"),
);

const MOTION_TASK =
  "Rendilo animato e moderno: anima index.html con motion compositor-only, " +
  "rispetta prefers-reduced-motion. Non implementare command palette in questo task.";

/** Dishonest synthesis like the original regression (claims verified without evidence). */
const DISHONEST_SYNTHESIS = `## Verification status
| Check | Tier | Status | Evidence |
| motion.keyframes | tool | ✓ verificato | grep su index.html |
| motion.transitions | tool | ✓ verificato | index.html:L535 |
| css.dead-hook | grep | ✓ verificato | nessun hook .rm |
| inline-js.budget | build | ✓ verificato | sotto 5KB |

Tutto compatibile con command palette v0.2.0. Pronto per commit.`;

const {
  runImplementationVerification,
  buildCouncilCompletion,
  writeCouncilCompletion,
  extractTaskScope,
  loadNfrSpec,
} = await import("@zelari/core/council");

const { buildPlanSummary } = await import(
  "../dist/cli/workspace/workspaceSummary.js"
).catch(async () => {
  // Fallback: vitest/ts path via dynamic compile — use relative src if no dist
  return import("../src/cli/workspace/workspaceSummary.ts");
});

function section(title) {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(72)}\n`);
}

if (!existsSync(join(testmcpRoot, "index.html"))) {
  console.error(`[replay-testmcp] index.html not found under ${testmcpRoot}`);
  process.exit(1);
}

const zelariRoot = join(testmcpRoot, ".zelari");

section("1. Task scope (Phase E)");
const scope = extractTaskScope({
  userMessage: MOTION_TASK,
  nfrSpec: loadNfrSpec(zelariRoot),
  planText: existsSync(join(zelariRoot, "plan.json"))
    ? readFileSync(join(zelariRoot, "plan.json"), "utf8")
    : undefined,
});
console.log("Targets:", scope.targets.join(", ") || "(none)");
console.log("Keywords:", scope.keywords.join(", ") || "(none)");
console.log("Explicit OUT:", scope.explicitOut.join("; ") || "(none)");
console.log("NFR relevant:", scope.nfrRelevant);

section("2. Plan summary — in-scope vs backlog");
const planSummary = buildPlanSummary(testmcpRoot, { userMessage: MOTION_TASK });
if (planSummary) {
  const lines = planSummary.split("\n");
  for (const line of lines) {
    if (
      line.startsWith("## Task scope") ||
      line.startsWith("## In scope") ||
      line.startsWith("## Planned but not") ||
      line.startsWith("Targets:") ||
      line.startsWith("Keywords:") ||
      line.startsWith("Out of scope") ||
      line.startsWith("- [") ||
      line.startsWith("_Deliver")
    ) {
      console.log(line);
    }
  }
} else {
  console.log("(no plan.json)");
}

section("3. Gate A — verification (dishonest synthesis)");
const report = runImplementationVerification({
  projectRoot: testmcpRoot,
  zelariRoot,
  synthesisText: DISHONEST_SYNTHESIS,
  degradedRun: false,
});
const fails = report.results.filter((r) => !r.ok);
const errors = fails.filter((r) => r.severity === "error");
console.log(`report.ok: ${report.ok}`);
console.log(`FAIL total: ${fails.length} (${errors.length} error)`);
for (const r of fails.slice(0, 12)) {
  console.log(`  · [${r.severity}] ${r.id}: ${r.message.slice(0, 72)}`);
}
if (fails.length > 12) console.log(`  · … +${fails.length - 12} more`);

section("4. completion.json artifact");
const completion = buildCouncilCompletion({
  verification: { ran: true, ok: report.ok, report },
  smoke: { ran: false },
  degradedRun: false,
  synthesisText: DISHONEST_SYNTHESIS,
  scope: {
    targets: scope.targets,
    keywords: scope.keywords,
    explicitOut: scope.explicitOut,
    nfrRelevant: scope.nfrRelevant,
    sources: scope.sources,
  },
});
const outPath = writeCouncilCompletion(zelariRoot, completion);
console.log(`Written: ${outPath}`);
console.log(JSON.stringify(
  {
    ok: completion.ok,
    readyToCommit: completion.readyToCommit,
    blocking: completion.blocking,
    openFails: completion.openFails.length,
    scope: completion.scope,
  },
  null,
  2,
));

section("5. Verdict");
if (completion.readyToCommit) {
  console.error("[replay-testmcp] UNEXPECTED: readyToCommit=true — gate regression!");
  process.exit(1);
}
console.log(
  "[replay-testmcp] PASS — readyToCommit=false as expected.",
  `Blocking: ${completion.blocking.join(", ") || "(none)"}`,
);
process.exit(0);
