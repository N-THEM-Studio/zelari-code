#!/usr/bin/env node
/**
 * zelari-code — CLI coding agent on top of AnathemaBrain.
 * Phase 14 Task 14.3 + 14.4: multi-panel TUI + slash command wiring.
 */

import React from "react";
import { render } from "ink";
// @ts-ignore
import { App } from "./app.js";
import { SplashGate } from "./components/SplashScreen.js";
import { PluginGate } from "./components/PluginGate.js";
import { getMetricsLogger } from "./metrics.js";
import { getProviderConfigPath } from "./providerConfig.js";
import { parseWizardFlags, shouldRunWizard } from "./wizard/firstRun.js";
import { RunWizard } from "./wizard/runWizard.js";
import { parseHeadlessFlags } from "./headless.js";
import { runHeadless } from "./runHeadless.js";
import {
  applySetConfig,
  applySetKey,
  parseDiscoverModelsFlags,
  parseLoginOAuthFlags,
  parseProviderOnlyFlag,
  parseSetConfigFlags,
  parseSetKeyFlags,
  printDesktopConfig,
  runDiscoverModels,
  wantsDiscoverModels,
  wantsLoginOAuth,
  wantsLogoutOAuth,
  wantsPrintConfig,
  wantsRefreshOAuth,
  wantsSetKey,
} from "./desktopConfig.js";
import {
  runLoginOAuth,
  runLogoutOAuth,
  runRefreshOAuth,
} from "./oauthDesktop.js";
import {
  runPluginsInstall,
  runPluginsStatus,
  wantsPluginsInstall,
  wantsPluginsStatus,
} from "./plugins/cliFlags.js";
import { loadSkillMdSkills } from "./skillsMd.js";
import { listCodingSkills } from "@zelari/core/skills";
import { getCurrentVersion } from "./updater.js";
import {
  listMcpServers,
  removeMcpServer,
  upsertMcpServer,
} from "./mcp/mcpConfigIo.js";
import {
  listSkillsSnapshot,
  upsertSkill,
  removeSkill,
  ensureBuiltinSkillsLoadedSync,
} from "./skillConfigIo.js";
import { generateSkillFromUrl } from "./generateSkillFromUrl.js";
import { applyMcpPreset } from "./mcp/mcpPresets.js";
import {
  listSshTargets,
  readSshPublicKey,
  removeSshTarget,
  testSshTarget,
  upsertSshTarget,
  type SshTargetInput,
} from "./ssh/targets.js";
import { shouldStartHarnessServer } from "./serve/detectHarnessMode.js";

/**
 * Bundled CLI version. Derived from <pkg>/package.json at runtime so it
 * stays in sync with `npm publish` / self-update checks (which also read
 * package.json via `getCurrentVersion`). Previously hardcoded — that
 * caused `--version` to show 1.0.0 after a 1.0.1 publish and confused
 * `/update` (registry's "latest" was 1.0.1, current was 1.0.0 → update
 * offered, then reinstalled 1.0.1 → no change apparent).
 */
export const VERSION: string = getCurrentVersion();

/**
 * Silent background update check (Task N.6, v3-N).
 *
 * Runs ~3s after startup. If a newer version exists on npm, prints a
 * one-line hint to stderr (so it doesn't pollute the TUI). Failures
 * are swallowed silently — registry outages must NEVER block the CLI.
 *
 * Disabled in dev mode (`ANATHEMA_DEV=1`) to avoid noise during local
 * development where the bundled version is the source repo.
 */
/**
 * Boot-time prerequisite gate (v1.4.0).
 *
 * Probes node/git/bash THROUGH the agent's resolved shell — not the main
 * process — because the agent runs `npm`/`tsc`/build scripts inside the
 * resolved bash (Git Bash on Windows), which inherits a different PATH
 * than this Node process. A user can have node visible to the main process
 * yet invisible to the agent's bash; without this check zelari-code boots
 * happily and the failure surfaces only mid-task (`node: not found`), which
 * is exactly what blocked the Anathema-Studio council run on 2026-07-07.
 *
 * Severity:
 *   - node unreachable from agent shell → hard-fail (exit 1). Without node
 *     the agent cannot run npm/build/tsc — there is nothing useful it can do.
 *   - git / bash missing → warn to stderr, continue. Features degrade but
 *     the agent still works for non-git, non-POSIX tasks.
 *
 * Bypass: `ZELARI_SKIP_PREFLIGHT=1` or `--skip-checks`. Intended for CI,
 * sandboxes, and emergency recovery — not normal use.
 *
 * Runs AFTER `pickRootComponent()` (so `--version`/`--help`/`--doctor` keep
 * working on a broken install) but BEFORE skill loading and the TUI render.
 * Never throws — `runPrereqChecks` already swallows per-check errors.
 *
 * @see src/cli/utils/prereqChecks.ts — the probe implementation.
 */
function runPreflight(): void {
  if (process.env.ZELARI_SKIP_PREFLIGHT === "1") return;
  if (process.argv.includes("--skip-checks")) return;
  if (process.env.ANATHEMA_DEV === "1") return; // dev: avoid noise on a source checkout.

  const { runPrereqChecks } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./utils/prereqChecks.js") as typeof import("./utils/prereqChecks.js");
  const { results, hasCriticalFail, warnings } = runPrereqChecks({
    mode: "preflight",
  });

  // Soft warnings: one compact line each (no multi-line walls before the TUI).
  // Full detail stays in `zelari-code --doctor`.
  for (const w of warnings) {
    const oneLine = w.message.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
    const short =
      oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
    // eslint-disable-next-line no-console
    console.error(`\x1b[33m[zelari-code] ⚠ ${w.tool}: ${short}\x1b[0m`);
  }

  if (hasCriticalFail) {
    const critical = results.find(
      (r) => !r.ok && r.severity === "critical",
    );
    // eslint-disable-next-line no-console
    console.error("");
    // eslint-disable-next-line no-console
    console.error(
      "\x1b[31m" +
        "==============================================================\n" +
        " zelari-code cannot start: a critical prerequisite is missing.\n" +
        "==============================================================\x1b[0m",
    );
    if (critical) {
      // eslint-disable-next-line no-console
      console.error(`\n  ${critical.tool}: ${critical.message}`);
    }
    // eslint-disable-next-line no-console
    console.error(
      "\n  Run `zelari-code --doctor` for the full diagnostic report.\n" +
        "  Bypass this check with ZELARI_SKIP_PREFLIGHT=1 (NOT recommended —\n" +
        "  the agent will still fail when it tries to run npm/build/tsc).",
    );
    process.exit(1);
  }
}

async function backgroundUpdateCheck(): Promise<void> {
  if (process.env.ANATHEMA_DEV === "1") return;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    const { checkForUpdate } = await import("./updater.js");
    const info = await checkForUpdate();
    if (info.updateAvailable && !info.error) {
      // eslint-disable-next-line no-console
      console.error(
        `[zelari-code] 🆕 v${info.latestVersion} available (current: v${info.currentVersion}). ` +
          `Run \`zelari-code\` then \`/update --yes\` to upgrade.`,
      );
    }
  } catch {
    // Swallow — network failures, malformed responses, etc.
    // The CLI is fully usable without update awareness.
  }
}

async function shutdown(): Promise<void> {
  // Flush the process-wide MetricsLogger (Task G.3.3, carryover from v3-B
  // B.5.2). The chat session in `app.tsx` writes via fire-and-forget
  // queue — if we just `process.exit(0)` on SIGINT, the last few records
  // (often the most interesting: agent_end + tool_execution_end) never
  // land in `~/.zelari-code/metrics.jsonl`. Awaiting `flush()`
  // before exit guarantees the file is fully written.
  try {
    await getMetricsLogger().flush();
  } catch {
    // Best-effort — never block shutdown on a metrics write error.
  }
  try {
    // v0.7.5: kill spawned MCP server processes so they don't outlive the CLI.
    const { closeMcpClients } = await import("./mcp/mcpManager.js");
    closeMcpClients();
  } catch {
    // Best-effort.
  }
  process.exit(0);
}

/**
 * Decide what to render: Wizard (first run / forced), App, or run headless.
 *
 * v0.5.0: replaced "always render App" with a conditional branch on
 * `shouldRunWizard()`. Resolved at startup, before any Ink render.
 *
 * v0.5.0: headless mode (`--headless --task X`) short-circuits the
 * TUI entirely. Returns a discriminator so `main()` can call
 * `runHeadless()` + `process.exit()` without mounting Ink.
 *
 * Also handles meta-flags that should NOT mount Ink (--version, --help):
 * these print to stdout and exit, leaving the TTY untouched.
 */
function pickRootComponent(): {
  kind: "wizard" | "app" | "headless" | "done" | "serve" | "harness-server";
  element?: React.ReactElement;
  headlessOpts?: Parameters<typeof runHeadless>[0];
  serveOpts?: import("./companion/serve.js").ServeOptions;
} {
  const argv = process.argv.slice(2);

  if (argv.includes("--version") || argv.includes("-v")) {
    // eslint-disable-next-line no-console
    console.log(`zelari-code v${VERSION}`);
    process.exit(0);
  }
  // Desktop / scripts: optional plugin status + install (JSON on stdout).
  if (wantsPluginsStatus(argv)) {
    void runPluginsStatus(argv).then((code) => process.exit(code));
    return { kind: "done" };
  }
  if (wantsPluginsInstall(argv)) {
    void runPluginsInstall(argv).then((code) => process.exit(code));
    return { kind: "done" };
  }
  if (argv.includes("--memory-json")) {
    const requestIndex = argv.indexOf("--memory-json");
    const rawRequest = requestIndex >= 0 ? argv[requestIndex + 1] : undefined;
    const cwdIndex = argv.indexOf("--cwd");
    const projectRoot = cwdIndex >= 0 && argv[cwdIndex + 1] ? argv[cwdIndex + 1] : process.cwd();
    if (!rawRequest) {
      console.error("[zelari-code --memory-json] a JSON request argument is required");
      process.exit(1);
    }
    void import("./memory/jsonApi.js")
      .then(({ runMemoryJsonApi }) => runMemoryJsonApi(projectRoot, rawRequest))
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exit(0);
      })
      .catch((err) => {
        console.error(`[zelari-code --memory-json] ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    return { kind: "done" };
  }
  // Optional external project-memory transport. Native Council/Kraken/mission
  // paths call MemoryService directly and never depend on this server.
  if (argv.includes("--memory-mcp")) {
    const cwdIndex = argv.indexOf("--cwd");
    const projectRoot = cwdIndex >= 0 && argv[cwdIndex + 1]
      ? argv[cwdIndex + 1]
      : process.cwd();
    const clientIndex = argv.indexOf("--client-id");
    const clientId = clientIndex >= 0 && argv[clientIndex + 1]
      ? argv[clientIndex + 1]
      : undefined;
    void import("./memory/mcpCli.js")
      .then(({ runMemoryMcpCli }) => runMemoryMcpCli(projectRoot, clientId))
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(
          `[zelari-code --memory-mcp] ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
    return { kind: "done" };
  }
  // External-agent permission broker (OpenMausBot pattern): spawned by
  // `claude --permission-prompt-tool "zelari-code --permission-mcp <socket>"`.
  // Pure stdio JSON-RPC loop — must NOT mount Ink or run preflight. The
  // dynamic import keeps the heavy TUI modules out of the child process's
  // startup path until the flag is actually used.
  if (argv.includes("--permission-mcp")) {
    const i = argv.indexOf("--permission-mcp");
    const socketPath = i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
    if (!socketPath) {
      // eslint-disable-next-line no-console
      console.error("[zelari-code --permission-mcp] a socket path argument is required");
      process.exit(1);
    }
    void import("./mcp/permissionCli.js")
      .then(({ runPermissionCli }) => runPermissionCli(socketPath))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[zelari-code --permission-mcp] ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
    return { kind: "done" };
  }
  // Companion host (Android / remote). Must not use kind "done" — that
  // returns from main() and on some Windows spawn paths the process exits
  // before the async server fully roots on the event loop.
  if (argv.includes("serve") || argv.includes("--serve")) {
    // Sync parse only; dynamic import happens in main() so the serve
    // promise is the last thing keeping the process alive.
    const { parseServeFlags } = require("./companion/serve.js") as typeof import("./companion/serve.js");
    return { kind: "serve", serveOpts: parseServeFlags(argv) ?? {} };
  }
  // t29 (Pilastro B): long-lived harness kernel over stdio NDJSON. Same
  // host discipline as --serve: no TUI, no preflight, transport owns
  // stdin/stdout; the dynamic import happens in main() so the serve
  // promise is the last thing keeping the process alive.
  // Also recovers Desktop 2.16.0, which spawned the sidecar with piped
  // stdio and no `--serve-harness` (PluginGate then polluted the boot line).
  if (
    shouldStartHarnessServer({
      argv,
      env: process.env,
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
    })
  ) {
    return { kind: "harness-server" };
  }
  // URL → skill draft (Desktop skill form). MUST run before any Ink path —
  // Desktop pipes stdin (no TTY); mounting the TUI throws "Raw mode is not supported".
  if (argv.includes("--generate-skill-from-url")) {
    void (async () => {
      try {
        const get = (flag: string) => {
          const i = argv.indexOf(flag);
          return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
        };
        const url = get("--url");
        if (!url) throw new Error("--url is required");
        const draft = await generateSkillFromUrl({
          url,
          provider: get("--provider"),
          model: get("--model"),
        });
        console.log(JSON.stringify({ ok: true, ...draft }, null, 2));
        process.exit(0);
      } catch (err) {
        console.error(
          `[zelari-code --generate-skill-from-url] ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    })();
    return { kind: "done" };
  }
  if (argv.includes("--doctor") || argv.includes("doctor")) {
    // v1.0.3: install-health diagnostic. Runs BEFORE the bundle is loaded
    // and before any provider / config work, so it works on a broken
    // install (missing bundle, missing shim, wrong PATH, etc.).
    // v1.5.0: async — the optional-plugins check delegates to
    // detectMissingPlugins (dynamic import + async detection).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runDoctor } =
      require("./utils/doctor.js") as typeof import("./utils/doctor.js");
    void runDoctor().then((healthy) => process.exit(healthy ? 0 : 1));
    return { kind: "done" };
  }
  if (argv.includes("--fix-path") || argv.includes("fix-path")) {
    // v1.4.2: runtime PATH repair. Companion to the install-time auto-fix
    // in scripts/postinstall.mjs. Handles the "PATH lost AFTER install"
    // case that postinstall can't reach retroactively. Windows-only at the
    // effect level; POSIX prints an advisory and exits 1.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { repairWindowsUserPath } =
      require("./utils/fixPath.js") as typeof import("./utils/fixPath.js");
    const result = repairWindowsUserPath();
    const green = "\x1b[32m";
    const red = "\x1b[31m";
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    if (result.ok) {
      if (result.alreadyOk) {
        // eslint-disable-next-line no-console
        console.log(`${green}✔${reset} npm prefix already on user PATH: ${result.prefix}`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`${green}✔${reset} added npm prefix to user PATH: ${result.prefix}`);
        // eslint-disable-next-line no-console
        console.log(`${dim}open a NEW terminal for the change to take effect, then run: zelari-code --version${reset}`);
      }
      process.exit(0);
    }
    // eslint-disable-next-line no-console
    console.error(`${red}✗${reset} ${result.error}`);
    if (result.prefix) {
      // eslint-disable-next-line no-console
      console.error(`${dim}prefix: ${result.prefix}${reset}`);
    }
    process.exit(1);
  }
  if (argv.includes("--print-settings")) {
    // Fase 3 (B12): layered zelari.config.json report — every knob with the
    // origin of its value (default < user < project < env). Read-only.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { printSettingsReport } =
      require("./userSettings.js") as typeof import("./userSettings.js");
    // eslint-disable-next-line no-console
    console.log(printSettingsReport({ cwd: process.cwd() }));
    process.exit(0);
  }
  if (argv.includes("--permissions")) {
    // W3.3 (t48): permission preset — UX sugar over the category policy.
    // Promoted to env BEFORE any registry is built; it only changes the
    // per-category DEFAULTS (standard == the pre-preset policy). Env vars,
    // policy files and session grants still win in both directions.
    const pIdx = argv.indexOf("--permissions");
    const raw = String(argv[pIdx + 1] ?? "")
      .trim()
      .toLowerCase();
    if (raw !== "strict" && raw !== "standard" && raw !== "yolo") {
      console.error(
        `[permissions] unknown preset '${raw || ""}' — use strict | standard | yolo`,
      );
      process.exit(1);
    }
    process.env.ZELARI_PERMISSION_PRESET = raw;
    console.log(
      `[permissions] preset=${raw} (defaults only — ZELARI_PERMISSION_* env and policy files still win)`,
    );
  }
  if (argv.includes("--evolve-status")) {
    // Evolution Engine v0 (ADR-0036): read-only ledger stats. The ledger is
    // append-only under .zelari/evolution/ and written ONLY when
    // ZELARI_EVOLUTION=shadow; this flag never mutates anything.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { evolutionMode, ledgerStats, readLedger, LEDGER_REL } =
      require("./evolution/ledger.js") as typeof import("./evolution/ledger.js");
    const entries = readLedger(process.cwd());
    const stats = ledgerStats(entries);
    // eslint-disable-next-line no-console
    console.log(
      `evolution mode: ${evolutionMode()} (ZELARI_EVOLUTION)\n` +
        `ledger: ${LEDGER_REL} (project-local, append-only)\n` +
        `runs: ${stats.runs}` +
        (stats.runs > 0
          ? `\nbyVerdict: ${JSON.stringify(stats.byVerdict)}\nbyClass: ${JSON.stringify(stats.byClass)}\nwindow: ${stats.firstAt} → ${stats.lastAt}` +
            (stats.weightedPassRate !== undefined
              ? `\ntier-weighted pass rate: ${stats.weightedPassRate.toFixed(2)} (ADR-0023 ladder)`
              : "") +
            (stats.rollbackRate !== undefined
              ? `\nrollback rate: ${stats.rollbackRate.toFixed(2)}`
              : "") +
            (stats.avgCostUsd !== undefined ? `\navg cost: $${stats.avgCostUsd.toFixed(4)}` : "") +
            Object.entries(stats.byClassFitness)
              .map(
                ([cls, f]) =>
                  `\nfitness ${cls}: pass ${f.passRate.toFixed(2)} · weighted ${f.weightedPassRate.toFixed(2)} · rollback ${f.rollbackRate.toFixed(2)}`,
              )
              .join("")
          : "") +
        `\nproposals: npm run evolve:propose — decisions in npm run evolve:decide (P1: nothing self-promotes)`,
    );
    process.exit(0);
  }
  if (argv.includes("--fix-budget") || argv.includes("fix-budget")) {
    // v1.20.0: runtime tool-budget repair. Sets the recommended ZELARI_*
    // env vars (hard cap, soft cap, context limit) at User scope so multi-step
    // implementations don't get force-summarized mid-work. Windows-only at the
    // effect level; POSIX prints an advisory and exits 1.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { repairWindowsBudget } =
      require("./utils/fixBudget.js") as typeof import("./utils/fixBudget.js");
    const result = repairWindowsBudget();
    const green = "\x1b[32m";
    const red = "\x1b[31m";
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    if (result.ok) {
      if (result.alreadyOk) {
        // eslint-disable-next-line no-console
        console.log(`${green}✔${reset} budget variables already at recommended values (${result.skipped.join(", ")})`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`${green}✔${reset} applied budget variables: ${result.applied.join(", ")}`);
        if (result.skipped.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`${dim}already set: ${result.skipped.join(", ")}${reset}`);
        }
        // eslint-disable-next-line no-console
        console.log(`${dim}open a NEW terminal for the changes to take effect${reset}`);
      }
      process.exit(0);
    }
    // eslint-disable-next-line no-console
    console.error(`${red}✗${reset} ${result.error}`);
    process.exit(1);
  }
  if (argv.includes("--inspect") || argv.includes("inspect")) {
    // v0.10: `inspect <session-id> [--json]` — advisory read-only report of
    // one session's harness_state read-model (ADR-0023). A positional
    // argument after the command selects the session; bare `inspect` keeps
    // the v1.32.0 environment inspection below.
    const inspectAt = argv.findIndex((a) => a === "inspect" || a === "--inspect");
    const sessionId =
      inspectAt >= 0
        ? argv.slice(inspectAt + 1).find((a) => !a.startsWith("-"))
        : undefined;
    if (sessionId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runInspectSession } =
        require("./commands/inspectSession.js") as typeof import("./commands/inspectSession.js");
      const json = argv.includes("--json");
      void runInspectSession({ sessionId, json }).then((code) => process.exit(code));
      return { kind: "done" };
    }
    // v1.32.0: unified environment inspection (config sources, skills,
    // MCP, hooks, plugins, AGENTS.md, phase/mode, trust status).
    // Runs BEFORE the TUI so it works on a broken/mixed project.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runInspect } =
      require("./commands/inspect.js") as typeof import("./commands/inspect.js");
    const json = argv.includes("--json");
    void runInspect({ json }).then((code) => process.exit(code));
    return { kind: "done" };
  }
  if (argv.includes("--trust")) {
    // v1.32.0: trust the cwd (or the given path) so project MCP +
    // project hooks load. Companion to the /trust slash command.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trustFolder } =
      require("./safety/folderTrust.js") as typeof import("./safety/folderTrust.js");
    const i = argv.indexOf("--trust");
    const target = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : process.cwd();
    try {
      const res = trustFolder(target);
      console.log(JSON.stringify({ ok: true, path: res.path }));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --trust] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    // eslint-disable-next-line no-console
    console.log(
      "zelari-code — AI Council coding agent CLI.\n" +
        "\n" +
        "Usage: zelari-code [options]\n" +
        "\n" +
        "Options:\n" +
        "  --version, -v       Print version and exit\n" +
        "  --help, -h          Print this help and exit\n" +
        "  --doctor            Diagnose install health (shim, bundle, PATH, deps,\n" +
        "                      node/git/bash in the agent shell)\n" +
        "  --inspect [--json]  Unified project inspection (config, skills, MCP,\n" +
        "                      hooks, plugins, AGENTS.md, trust status)\n" +
        "  --trust [path]      Trust the cwd (or path) so project MCP + hooks load\n" +
        "  --fix-path          Add the npm global prefix to the user PATH\n" +
        "                      (Windows only; fixes 'command not found' after install)\n" +
        "  --fix-budget        Set recommended ZELARI_MAX_TOOL_LOOP_HARD=180,\n" +
        "                      ZELARI_MAX_TOOL_LOOP_ITERATIONS=60, ZELARI_CONTEXT_LIMIT=400000\n" +
        "                      at User scope (prevents the agent stopping mid-task)\n" +
        "  --permission-mcp <socket>  MCP stdio server for external agent permission prompts\n" +
        "                      (spawned by claude --permission-prompt-tool)\n" +
        "  --memory-mcp       Optional MCP stdio server for project memory\n" +
        "    --cwd <path>      Trusted project root (requires ZELARI_MEMORY_MCP=1)\n" +
        "    --client-id <id>  Stable local owner identity for private memories\n" +
        "  --memory-json <json>  Read-only project-memory bridge for Zelari Desktop\n" +
        "  --skip-checks       Skip the boot-time prerequisite check\n" +
        "                      (alias for ZELARI_SKIP_PREFLIGHT=1)\n" +
        "  --no-wizard         Skip the first-run wizard\n" +
        "  --reset-config      Re-run the wizard (clears provider.json on commit)\n" +
        "  --headless          Run a single task without mounting the TUI\n" +
        "    --task <text>       Task prompt (required in headless mode)\n" +
        "    --output json|plain Output format (default: json)\n" +
        "    --mode kraken|council|zelari  Dispatch mode (default: kraken; agent=alias)\n" +
        "    --council          Alias for --mode council\n" +
        "    --phase plan|build  Work phase (default: build)\n" +
        "    --provider <id>    Provider override (default: active)\n" +
        "    --model <id>       Model override (default: provider default)\n" +
        "    --profile <id>     Capability profile (minimal/v1|kraken/v1|council/v1|mission/v1)\n" +
        "    --resume <id>      Continue a 2.0 spine session\n" +
        "    --export-session <path>  Write zelari-session-export/1 after the run\n" +
        "    --strict-done      Evidence-based BUILD completion gate\n" +
        "    --task-file <path>  Read the task prompt from a file (Windows argv cap)\n" +
        "    --once             Single-cycle run (cron/git-hook triggers, ADR-0014)\n" +
        "    --kraken-graph <goal>  Plan + execute a Kraken task graph\n" +
        "                      (variant: --kraken-graph-file <path>; kill-switch\n" +
        "                      ZELARI_KRAKEN_GRAPH=0)\n" +
        "    --plan-only        Serialize the graph plan to .zelari/radio/ and exit 0\n" +
        "    --run-plan <id>    Execute a pre-built .zelari/radio/plan-<id>.json\n" +
        "    --gauntlet         Host-driven gauntlet loop (builder/critic tentacles)\n" +
        "  --session-export <id>  Print a portable 2.0 session export (no LLM)\n" +
        "  serve               Companion host for Android/remote clients (Tailscale)\n" +
        "    --bind <ip>       Listen address (default: 127.0.0.1; use Tailscale IP)\n" +
        "    --port <n>        Port (default: 7421)\n" +
        "    --token <secret>  Bearer token (default: ~/.zelari-code/companion.token)\n" +
        "    --project <path>  Allowlisted project root (repeatable)\n" +
        "    --save-projects   Persist --project list to companion.json\n" +
        "  --serve-harness     Long-lived harness kernel for hosts (NDJSON JSON-RPC\n" +
        "                      on stdin/stdout; Desktop/companion transport)\n" +
        "  --print-config      Print provider/model config as JSON (no secrets)\n" +
        "  --print-settings    Print zelari.config.json values + the origin of\n" +
        "                      each (default < user < project < env)\n" +
        "  --permissions <p>   Permission preset: strict | standard | yolo — changes\n" +
        "                      category DEFAULTS only (env vars and policy files win)\n" +
        "  --evolve-status     Evolution ledger stats (read-only; ADR-0036; the\n" +
        "                      ledger is written only when ZELARI_EVOLUTION=shadow)\n" +
        "  --plugins-status    JSON status of optional plugins (Playwright, eslint, …)\n" +
        "  --plugins-install <id>  Install plugin (playwright also fetches Chromium)\n" +
        "    --cwd <path>       Workspace for -D installs (default: process.cwd())\n" +
        "  --set-config        Persist provider/model/endpoint\n" +
        "    --provider <id>    Set active provider\n" +
        "    --model <id>       Set model for that provider\n" +
        "    --endpoint <url>   Custom OpenAI-compatible base URL\n" +
        "    --endpoint-clear   Remove custom endpoint override\n" +
        "    --thinking <spec>  Thinking effort (auto|off|low|medium|high|budget:N)\n" +
        "  --set-key           Store an API key (never printed back)\n" +
        "    --provider <id>    Provider id (required)\n" +
        "    --key <secret>     API key (required)\n" +
        "  --login-oauth       Start subscription OAuth (grok, chatgpt, anthropic)\n" +
        "    --provider <id>    grok | chatgpt | anthropic\n" +
        "    --code <paste>    Anthropic magic-link code (CODE#STATE)\n" +
        "    --no-browser      Do not open the system browser\n" +
        "  --refresh-oauth     Force-refresh an OAuth access token\n" +
        "    --provider <id>    grok | chatgpt | anthropic\n" +
        "  --logout-oauth      Clear stored OAuth credentials\n" +
        "    --provider <id>    grok | chatgpt | anthropic\n" +
        "  --discover-models   Refresh model list for a provider\n" +
        "    --provider <id>    Provider (default: active)\n" +
        "  --print-mcp         Print MCP server config (user + project)\n" +
        "    --cwd <path>      Project root for .zelari/mcp.json\n" +
        "  --set-mcp           Add/update an MCP server entry\n" +
        "    --name <id>       Server name (required)\n" +
        "    --command <bin>   Executable for stdio servers\n" +
        "    --url <endpoint>  Streamable HTTP endpoint (e.g. UE 5.8 editor)\n" +
        "    --args <json>     JSON array of args (stdio, optional)\n" +
        "    --timeout <ms>    Per-server request timeout (http, optional)\n" +
        "    --scope user|project  Default: user\n" +
        "    --enabled true|false  Default: true\n" +
        "    --cwd <path>      Required when scope=project\n" +
        "  --set-mcp-preset    Install a named MCP preset (e.g. cua)\n" +
        "    --preset cua      Cua Driver desktop computer-use (MCP)\n" +
        "    --preset unreal-mcp  Unreal Engine 5.8+ editor (MCP over HTTP)\n" +
        "    --scope user|project  Default: user\n" +
        "    --cwd <path>      Required when scope=project\n" +
        "  --remove-mcp        Remove an MCP server entry\n" +
        "    --name <id> --scope user|project [--cwd <path>]\n" +
        "  --print-skills      Print skills (builtin + user + project)\n" +
        "    --cwd <path>      Project root for .zelari/skills\n" +
        "  --set-skill         Add/update a SKILL.md skill\n" +
        "    --name <id>       Skill id (required)\n" +
        "    --description <t> One-line description (required)\n" +
        "    --body <text>     Markdown instructions (required)\n" +
        "    --category <c>    plan|refactor|debug|review|test|docs|ops|git|db|maint\n" +
        "    --tools <csv>     Comma-separated required tools (optional)\n" +
        "    --cost <l>        low|medium|high (default: medium)\n" +
        "    --scope user|project  Default: user\n" +
        "    --cwd <path>      Required when scope=project\n" +
        "  --remove-skill      Remove a user/project SKILL.md\n" +
        "    --name <id> --scope user|project [--cwd <path>]\n" +
        "  --generate-skill-from-url  Fetch URL + draft skill via model (JSON)\n" +
        "    --url <https://...>  Required\n" +
        "    --provider <id>   Override active provider\n" +
        "    --model <name>    Override model for the selected provider\n" +
        "  --print-ssh-targets Print SSH deploy/monitor targets\n" +
        "  --set-ssh-target    Upsert target (--json '{...}' or flags)\n" +
        "  --remove-ssh-target --id <id>\n" +
        "  --test-ssh-target   --id <id>  (BatchMode ssh true)\n" +
        "  --print-ssh-pubkey  --path <private-or-.pub>  (display public key)\n" +
        "\n" +
        "Environment:\n" +
        "  ZELARI_NO_WIZARD=1    Skip the first-run wizard\n" +
        "  ZELARI_SKIP_PREFLIGHT=1  Skip the boot prerequisite check\n" +
        "  ZELARI_NO_PLUGIN_PROMPT=1  Skip the boot plugin-install prompt\n" +
        "  ZELARI_MEMORY_MCP=1  Enable the optional external memory MCP server\n" +
        "  ANATHEMA_DEV=1        Disable background update check + preflight\n",
    );
    process.exit(0);
  }

  // MCP config helpers (Desktop Extensions store).
  if (argv.includes("--print-mcp")) {
    try {
      const cwdIdx = argv.indexOf("--cwd");
      const cwd =
        cwdIdx >= 0 && argv[cwdIdx + 1] ? argv[cwdIdx + 1] : process.cwd();
      const snap = listMcpServers(cwd);
      console.log(JSON.stringify(snap, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --print-mcp] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--set-mcp")) {
    try {
      const get = (flag: string) => {
        const i = argv.indexOf(flag);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
      };
      const name = get("--name");
      const command = get("--command");
      const url = get("--url");
      const timeoutRaw = get("--timeout");
      const scopeRaw = get("--scope") ?? "user";
      const scope = scopeRaw === "project" ? "project" : "user";
      const cwd = get("--cwd") ?? process.cwd();
      const enabledRaw = get("--enabled");
      const enabled = enabledRaw === undefined ? true : enabledRaw !== "false";
      let args: string[] | undefined;
      const argsRaw = get("--args");
      if (argsRaw) {
        const parsed = JSON.parse(argsRaw) as unknown;
        if (!Array.isArray(parsed)) throw new Error("--args must be a JSON array");
        args = parsed.map(String);
      }
      const timeoutMs =
        timeoutRaw !== undefined ? Number(timeoutRaw) : undefined;
      if (
        timeoutMs !== undefined &&
        (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      ) {
        throw new Error("--timeout must be a positive number of milliseconds");
      }
      if (!name) throw new Error("--name is required");
      if (!command && !url) {
        throw new Error("either --command (stdio) or --url (http) is required");
      }
      if (url && !/^https?:\/\//i.test(url)) {
        throw new Error("--url must be an http(s) endpoint");
      }
      const result = upsertMcpServer({
        scope,
        name,
        projectRoot: cwd,
        config: url
          ? { type: "http", url, timeoutMs, serial: true, enabled }
          : { command, args, enabled },
      });
      if (!result.ok) throw new Error(result.error);
      console.log(JSON.stringify({ ok: true, path: result.path, name, scope }));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --set-mcp] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--remove-mcp")) {
    try {
      const get = (flag: string) => {
        const i = argv.indexOf(flag);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
      };
      const name = get("--name");
      const scopeRaw = get("--scope") ?? "user";
      const scope = scopeRaw === "project" ? "project" : "user";
      const cwd = get("--cwd") ?? process.cwd();
      if (!name) throw new Error("--name is required");
      const result = removeMcpServer({ scope, name, projectRoot: cwd });
      if (!result.ok) throw new Error(result.error);
      console.log(JSON.stringify({ ok: true, path: result.path, name, scope }));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --remove-mcp] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  // Skill config helpers (Desktop Extensions store — parity with MCP).
  if (argv.includes("--print-skills")) {
    try {
      const cwdIdx = argv.indexOf("--cwd");
      const cwd =
        cwdIdx >= 0 && argv[cwdIdx + 1] ? argv[cwdIdx + 1] : process.cwd();
      ensureBuiltinSkillsLoadedSync();
      const snap = listSkillsSnapshot(cwd);
      console.log(JSON.stringify(snap, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --print-skills] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--set-skill")) {
    try {
      const get = (flag: string) => {
        const i = argv.indexOf(flag);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
      };
      const name = get("--name");
      const description = get("--description");
      const body = get("--body");
      const category = get("--category");
      const toolsRaw = get("--tools");
      const cost = get("--cost");
      const scopeRaw = get("--scope") ?? "user";
      const scope = scopeRaw === "project" ? "project" : "user";
      const cwd = get("--cwd") ?? process.cwd();
      if (!name) throw new Error("--name is required");
      if (!description) throw new Error("--description is required");
      if (!body) throw new Error("--body is required");
      const tools = toolsRaw
        ? toolsRaw.split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;
      const result = upsertSkill({
        scope,
        name,
        description,
        body,
        category,
        tools,
        cost,
        projectRoot: cwd,
      });
      if (!result.ok) throw new Error(result.error);
      console.log(JSON.stringify({ ok: true, path: result.path, name, scope }));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --set-skill] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--remove-skill")) {
    try {
      const get = (flag: string) => {
        const i = argv.indexOf(flag);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
      };
      const name = get("--name");
      const scopeRaw = get("--scope") ?? "user";
      const scope = scopeRaw === "project" ? "project" : "user";
      const cwd = get("--cwd") ?? process.cwd();
      if (!name) throw new Error("--name is required");
      const result = removeSkill({ scope, name, projectRoot: cwd });
      if (!result.ok) throw new Error(result.error);
      console.log(JSON.stringify({ ok: true, path: result.path, name, scope }));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --remove-skill] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--set-mcp-preset")) {
    try {
      const get = (flag: string) => {
        const i = argv.indexOf(flag);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
      };
      // Allow: --set-mcp-preset cua  OR  --set-mcp-preset --preset cua
      const presetFlag = get("--preset");
      const pos =
        argv[argv.indexOf("--set-mcp-preset") + 1] &&
        !argv[argv.indexOf("--set-mcp-preset") + 1]!.startsWith("-")
          ? argv[argv.indexOf("--set-mcp-preset") + 1]
          : undefined;
      const presetId = presetFlag ?? pos;
      if (!presetId) throw new Error("--preset <id> is required (e.g. cua)");
      const scopeRaw = get("--scope") ?? "user";
      const scope = scopeRaw === "project" ? "project" : "user";
      const cwd = get("--cwd") ?? process.cwd();
      const result = applyMcpPreset({
        presetId,
        scope,
        projectRoot: cwd,
      });
      if (!result.ok) throw new Error(result.error);
      console.log(
        JSON.stringify(
          {
            ok: true,
            path: result.path,
            preset: result.preset.id,
            servers: result.servers,
            scope,
          },
          null,
          2,
        ),
      );
      for (const n of result.preset.notes) {
        console.error(`  ${n}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --set-mcp-preset] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  // SSH targets (Desktop Connections + agent tools).
  if (argv.includes("--print-ssh-targets")) {
    try {
      console.log(JSON.stringify(listSshTargets(), null, 2));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --print-ssh-targets] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--set-ssh-target")) {
    try {
      const get = (flag: string) => {
        const i = argv.indexOf(flag);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
      };
      let target: SshTargetInput;
      const jsonRaw = get("--json");
      if (jsonRaw) {
        target = JSON.parse(jsonRaw) as SshTargetInput;
      } else {
        const id = get("--id");
        const host = get("--host");
        const user = get("--user");
        if (!id || !host || !user) {
          throw new Error("Need --json or --id --host --user");
        }
        const allowedRaw = get("--allowed");
        const authFlag = get("--auth");
        const auth =
          authFlag === "password" || get("--password")
            ? "password"
            : get("--key-path")
              ? "keyPath"
              : "agent";
        target = {
          id,
          name: get("--name") ?? id,
          host,
          user,
          port: get("--port") ? Number(get("--port")) : 22,
          auth,
          keyPath: get("--key-path"),
          password: get("--password"),
          defaultRemotePath: get("--remote-path"),
          allowedCommands: allowedRaw
            ? allowedRaw.split("|").map((s) => s.trim()).filter(Boolean)
            : [],
          enabled: get("--enabled") !== "false",
        };
      }
      const result = upsertSshTarget(target);
      if (!result.ok) throw new Error(result.error);
      console.log(JSON.stringify({ ok: true, id: target.id }));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --set-ssh-target] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--remove-ssh-target")) {
    try {
      const i = argv.indexOf("--id");
      const id = i >= 0 ? argv[i + 1] : undefined;
      if (!id) throw new Error("--id is required");
      const result = removeSshTarget(id);
      if (!result.ok) throw new Error(result.error);
      console.log(JSON.stringify({ ok: true, id }));
      process.exit(0);
    } catch (err) {
      console.error(
        `[zelari-code --remove-ssh-target] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (argv.includes("--test-ssh-target")) {
    const i = argv.indexOf("--id");
    const id = i >= 0 ? argv[i + 1] : undefined;
    if (!id) {
      console.error("[zelari-code --test-ssh-target] --id is required");
      process.exit(1);
    }
    void testSshTarget(id)
      .then((result) => {
        console.log(JSON.stringify(result));
        process.exit(result.ok ? 0 : 1);
      })
      .catch((err) => {
        console.error(
          `[zelari-code --test-ssh-target] ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
    return { kind: "done" };
  }
  if (argv.includes("--print-ssh-pubkey")) {
    try {
      const i = argv.indexOf("--path");
      const p = i >= 0 ? argv[i + 1] : undefined;
      if (!p) throw new Error("--path is required");
      const result = readSshPublicKey(p);
      console.log(JSON.stringify(result));
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      console.error(
        `[zelari-code --print-ssh-pubkey] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  // Desktop / scripting config helpers (no TUI, no task required).
  if (wantsPrintConfig(argv)) {
    try {
      printDesktopConfig();
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[zelari-code --print-config] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  const setConfigParse = parseSetConfigFlags(argv);
  if (setConfigParse.error) {
    // eslint-disable-next-line no-console
    console.error(`[zelari-code --set-config] ${setConfigParse.error}`);
    process.exit(1);
  }
  if (setConfigParse.request) {
    const result = applySetConfig(setConfigParse.request);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`[zelari-code --set-config] ${result.error}`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, message: result.message }));
    process.exit(0);
  }

  if (wantsSetKey(argv)) {
    const keyParse = parseSetKeyFlags(argv);
    if (keyParse.error || !keyParse.request) {
      // eslint-disable-next-line no-console
      console.error(
        `[zelari-code --set-key] ${keyParse.error ?? "invalid arguments"}`,
      );
      process.exit(1);
    }
    const result = applySetKey(keyParse.request);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`[zelari-code --set-key] ${result.error}`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ok: true,
        provider: result.provider,
        masked: result.masked,
      }),
    );
    process.exit(0);
  }

  if (wantsLoginOAuth(argv)) {
    const parsed = parseLoginOAuthFlags(argv);
    if (parsed.error || !parsed.request) {
      console.error(
        `[zelari-code --login-oauth] ${parsed.error ?? "invalid arguments"}`,
      );
      process.exit(1);
    }
    void runLoginOAuth(parsed.request)
      .then((result) => {
        console.log(JSON.stringify(result));
        process.exit(result.ok ? 0 : 1);
      })
      .catch((err) => {
        console.error(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        process.exit(1);
      });
    return { kind: "done" };
  }

  if (wantsRefreshOAuth(argv)) {
    const parsed = parseProviderOnlyFlag(argv, "--refresh-oauth");
    if (parsed.error || !parsed.provider) {
      console.error(
        `[zelari-code --refresh-oauth] ${parsed.error ?? "invalid arguments"}`,
      );
      process.exit(1);
    }
    void runRefreshOAuth(parsed.provider)
      .then((result) => {
        console.log(JSON.stringify(result));
        process.exit(result.ok ? 0 : 1);
      })
      .catch((err) => {
        console.error(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        process.exit(1);
      });
    return { kind: "done" };
  }

  if (wantsLogoutOAuth(argv)) {
    const parsed = parseProviderOnlyFlag(argv, "--logout-oauth");
    if (parsed.error || !parsed.provider) {
      console.error(
        `[zelari-code --logout-oauth] ${parsed.error ?? "invalid arguments"}`,
      );
      process.exit(1);
    }
    const result = runLogoutOAuth(parsed.provider);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  }

  if (wantsDiscoverModels(argv)) {
    const disc = parseDiscoverModelsFlags(argv);
    void runDiscoverModels(disc.provider)
      .then(async (result) => {
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({ ok: false, error: result.error }));
          await new Promise<void>((r) => setImmediate(r));
          process.exit(1);
          return;
        }
        // Single JSON line on stdout — consumers (Desktop) parse this even if
        // the process later aborts on Windows libuv teardown.
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result.payload));
        try {
          await getMetricsLogger().flush();
        } catch {
          /* ignore */
        }
        await new Promise<void>((r) => setImmediate(r));
        process.exit(0);
      })
      .catch(async (err) => {
        // eslint-disable-next-line no-console
        console.error(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        await new Promise<void>((r) => setImmediate(r));
        process.exit(1);
      });
    return { kind: "done" };
  }

  // 2.0 session export (no LLM, no TUI).
  if (argv.includes("--session-export")) {
    const i = argv.indexOf("--session-export");
    const sessionId = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
    if (!sessionId) {
      console.error("[zelari-code --session-export] a session id is required");
      process.exit(1);
    }
    void import("./headlessSpine.js")
      .then(({ exportSessionById }) => exportSessionById(sessionId))
      .then((res) => {
        if (!res.ok) {
          console.error(`[zelari-code --session-export] ${res.error}`);
          process.exit(1);
        }
        process.stdout.write(res.json + "\n");
        process.exit(0);
      })
      .catch((err) => {
        console.error(
          `[zelari-code --session-export] ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
    return { kind: "done" };
  }

  // Headless mode: short-circuit TUI entirely. Must be checked BEFORE
  // the wizard branch so users can run scripted tasks on a fresh
  // install (no provider.json yet) by passing --provider + env var.
  const headlessParse = parseHeadlessFlags(argv);
  if (headlessParse.options !== null) {
    return { kind: "headless", headlessOpts: headlessParse.options };
  }
  if (headlessParse.error !== undefined) {
    // eslint-disable-next-line no-console
    console.error(`[zelari-code --headless] ${headlessParse.error}`);
    process.exit(1);
  }

  const flags = parseWizardFlags(argv);
  const decision = shouldRunWizard({
    configPath: getProviderConfigPath(),
    hasResetConfigFlag: flags.resetConfig,
    hasNoWizardFlag: flags.noWizard,
    noWizardEnv: process.env.ZELARI_NO_WIZARD,
  });
  if (decision.shouldRun) {
    // eslint-disable-next-line no-console
    console.error(`[zelari-code] starting wizard: ${decision.reason}`);
    return { kind: "wizard", element: React.createElement(RunWizard) };
  }
  // v0.7.8: one-shot startup splash (ASCII emblem, ~2s or any-key skip),
  // then the App mounts. Skipped automatically for non-TTY stdout, small
  // terminals, or ZELARI_NO_SPLASH=1 — see components/SplashScreen.tsx.
  // v1.5.0: PluginGate wraps App inside SplashGate — after the splash, it
  // detects missing optional plugins (Playwright, eslint, ruff, LSP servers)
  // and offers to install them before the App mounts. Skips on non-TTY,
  // ZELARI_NO_PLUGIN_PROMPT=1, or when nothing is missing.
  return {
    kind: "app",
    element: React.createElement(
      SplashGate,
      { version: VERSION },
      React.createElement(PluginGate, {
        cwd: process.cwd(),
        children: React.createElement(App),
      }),
    ),
  };
}

/**
 * v0.7.5: load user SKILL.md skills (opencode/Hermes/Claude-compatible
 * format) into the coding-skill catalog BEFORE the App mounts, so
 * `/skill` autocomplete and dispatch see them. Best-effort: a broken
 * SKILL.md is skipped with a one-line stderr note, never a crash.
 */
function loadUserSkills(): void {
  try {
    const existing = new Set(listCodingSkills().map((s) => s.id));
    const summary = loadSkillMdSkills(process.cwd(), { existingIds: existing });
    if (summary.loaded.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[zelari-code] loaded ${summary.loaded.length} SKILL.md skill(s): ${summary.loaded.join(", ")}`,
      );
    }
    for (const s of summary.skipped) {
      // eslint-disable-next-line no-console
      console.error(`[zelari-code] skipped SKILL.md at ${s.path}: ${s.reason}`);
    }
  } catch {
    // Skill loading is an enhancement — the CLI must start without it.
  }
}

function main() {
  const picked = pickRootComponent();
  if (picked.kind === "done") return; // --version or --help printed + exited

  // Companion host: block here (no Ink, no preflight hard-fail for remote).
  if (picked.kind === "serve") {
    void import("./companion/serve.js")
      .then(({ runCompanionServe }) => runCompanionServe(picked.serveOpts ?? {}))
      .then(() => process.exit(0))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[zelari-code serve] ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
    return;
  }

  // t29: long-lived harness kernel (--serve-harness). Host pre-flight is
  // skipped like --serve — a missing git/bash must not kill the server.
  if (picked.kind === "harness-server") {
    void import("./serve/harnessServer.js")
      .then(({ runHarnessServer }) => runHarnessServer())
      .then(() => process.exit(0))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[zelari-code --serve-harness] ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
    return;
  }

  // v1.4.0: verify node/git/bash BEFORE mounting the TUI or running a headless
  // task. Hard-fails on missing node (the agent cannot run npm/build without it),
  // warns on missing git/bash. Skipped for --version/--help/--doctor (handled
  // above) so a broken install can still be diagnosed. See `runPreflight`.
  runPreflight();

  loadUserSkills();

  if (picked.kind === "headless") {
    // Clean exit path: await flush + MCP teardown BEFORE process.exit.
    // Exiting mid-flush on Windows can trip libuv
    // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in async.c
    // when pipes/async handles are still closing.
    void runHeadless(picked.headlessOpts!)
      .then(async (code) => {
        try {
          await getMetricsLogger().flush();
        } catch {
          // best-effort
        }
        try {
          const { closeMcpClients } = await import("./mcp/mcpManager.js");
          closeMcpClients();
        } catch {
          // best-effort
        }
        // Let the event loop drain closed handles one tick before exit.
        await new Promise<void>((resolve) => setImmediate(resolve));
        process.exit(code);
      })
      .catch(async (err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[zelari-code --headless] fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          await getMetricsLogger().flush();
        } catch {
          /* ignore */
        }
        process.exit(2);
      });
    return;
  }

  const { waitUntilExit, unmount } = render(picked.element!);

  process.on("SIGINT", () => {
    unmount();
    void shutdown();
  });
  process.on("SIGTERM", () => {
    unmount();
    void shutdown();
  });

  // Fire-and-forget — the CLI works regardless of the update check result.
  void backgroundUpdateCheck();

  waitUntilExit().then(() => {
    void shutdown();
  });
}

main();


