#!/usr/bin/env node
/**
 * live-council-testmcp — headless /council on TESTMCP + post-hook pipeline.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const testmcpRoot = resolve(process.argv[2] ?? join(repoRoot, "..", "TESTMCP"));
const logDir = join(repoRoot, ".zelari", "replay-logs");
mkdirSync(logDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const ndjsonLog = join(logDir, `testmcp-council-${ts}.ndjson`);

const TASK =
  process.env.COUNCIL_TASK ??
  "Rendilo animato e moderno: anima index.html con motion compositor-only, " +
    "rispetta prefers-reduced-motion. Non implementare command palette in questo task. " +
    "Verifica con grep_content dopo ogni modifica.";

const PROVIDER = process.env.COUNCIL_PROVIDER ?? "grok";
const MODEL = process.env.COUNCIL_MODEL ?? "grok-build";
const cli = join(repoRoot, "bin", "zelari-code.js");

console.log("[live-council] cwd:", testmcpRoot);
console.log("[live-council] provider:", PROVIDER, "model:", MODEL);
console.log("[live-council] task:", TASK.slice(0, 120) + "...");
console.log("[live-council] log:", ndjsonLog);

const child = spawn(
  process.execPath,
  [
    cli,
    "--headless",
    "--council",
    "--provider",
    PROVIDER,
    "--model",
    MODEL,
    "--output",
    "json",
    "--task",
    TASK,
  ],
  {
    cwd: testmcpRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let exitCode = 1;
child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  writeFileSync(ndjsonLog, text, { flag: "a" });
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "member_cost") {
        console.log(
          `[member] ${ev.name ?? ev.memberId} tools=${ev.toolCalls ?? 0} err=${ev.errored ?? false} ${ev.durationMs ?? 0}ms`,
        );
      } else if (ev.type === "council_mode") {
        console.log(`[council] ${ev.tier} · ${ev.runMode}`);
      } else if (ev.type === "tool_execution_start") {
        console.log(`[tool] ${ev.toolName}`);
      } else if (ev.type === "error" && ev.severity !== "cancelled") {
        console.log(`[error] ${ev.severity}: ${ev.message?.slice(0, 120)}`);
      }
    } catch {
      // ignore non-json
    }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

await new Promise((resolveRun, reject) => {
  child.on("error", reject);
  child.on("close", (code) => {
    exitCode = code ?? 1;
    resolveRun();
  });
});

console.log(`\n[live-council] council exit: ${exitCode}`);
console.log("[live-council] running post-hook replay...");
const replay = spawn(
  process.execPath,
  [join(repoRoot, "scripts", "replay-testmcp.mjs"), testmcpRoot],
  { cwd: repoRoot, stdio: "inherit", env: process.env },
);
await new Promise((resolveRun) => replay.on("close", () => resolveRun()));

process.exit(exitCode);
