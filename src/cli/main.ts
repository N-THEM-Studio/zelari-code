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
  parseSetConfigFlags,
  parseSetKeyFlags,
  printDesktopConfig,
  runDiscoverModels,
  wantsDiscoverModels,
  wantsPrintConfig,
  wantsSetKey,
} from "./desktopConfig.js";
import { loadSkillMdSkills } from "./skillsMd.js";
import { listCodingSkills } from "@zelari/core/skills";
import { getCurrentVersion } from "./updater.js";
import {
  listMcpServers,
  removeMcpServer,
  upsertMcpServer,
} from "./mcp/mcpConfigIo.js";
import { applyMcpPreset } from "./mcp/mcpPresets.js";
import {
  listSshTargets,
  readSshPublicKey,
  removeSshTarget,
  testSshTarget,
  upsertSshTarget,
  type SshTargetInput,
} from "./ssh/targets.js";

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
  // land in `~/.tmp/anathema-coder/metrics.jsonl`. Awaiting `flush()`
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
  kind: "wizard" | "app" | "headless" | "done";
  element?: React.ReactElement;
  headlessOpts?: Parameters<typeof runHeadless>[0];
} {
  const argv = process.argv.slice(2);

  if (argv.includes("--version") || argv.includes("-v")) {
    // eslint-disable-next-line no-console
    console.log(`zelari-code v${VERSION}`);
    process.exit(0);
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
        "  --fix-path          Add the npm global prefix to the user PATH\n" +
        "                      (Windows only; fixes 'command not found' after install)\n" +
        "  --skip-checks       Skip the boot-time prerequisite check\n" +
        "                      (alias for ZELARI_SKIP_PREFLIGHT=1)\n" +
        "  --no-wizard         Skip the first-run wizard\n" +
        "  --reset-config      Re-run the wizard (clears provider.json on commit)\n" +
        "  --headless          Run a single task without mounting the TUI\n" +
        "    --task <text>       Task prompt (required in headless mode)\n" +
        "    --output json|plain Output format (default: json)\n" +
        "    --mode agent|council|zelari  Dispatch mode (default: agent)\n" +
        "    --council          Alias for --mode council\n" +
        "    --phase plan|build  Work phase (default: build)\n" +
        "    --provider <id>    Provider override (default: active)\n" +
        "    --model <id>       Model override (default: provider default)\n" +
        "  --print-config      Print provider/model config as JSON (no secrets)\n" +
        "  --set-config        Persist provider/model/endpoint\n" +
        "    --provider <id>    Set active provider\n" +
        "    --model <id>       Set model for that provider\n" +
        "    --endpoint <url>   Custom OpenAI-compatible base URL\n" +
        "    --endpoint-clear   Remove custom endpoint override\n" +
        "  --set-key           Store an API key (never printed back)\n" +
        "    --provider <id>    Provider id (required)\n" +
        "    --key <secret>     API key (required)\n" +
        "  --discover-models   Refresh model list for a provider\n" +
        "    --provider <id>    Provider (default: active)\n" +
        "  --print-mcp         Print MCP server config (user + project)\n" +
        "    --cwd <path>      Project root for .zelari/mcp.json\n" +
        "  --set-mcp           Add/update an MCP server entry\n" +
        "    --name <id>       Server name (required)\n" +
        "    --command <bin>   Executable (required)\n" +
        "    --args <json>     JSON array of args (optional)\n" +
        "    --scope user|project  Default: user\n" +
        "    --enabled true|false  Default: true\n" +
        "    --cwd <path>      Required when scope=project\n" +
        "  --set-mcp-preset    Install a named MCP preset (e.g. cua)\n" +
        "    --preset cua      Cua Driver desktop computer-use (MCP)\n" +
        "    --scope user|project  Default: user\n" +
        "    --cwd <path>      Required when scope=project\n" +
        "  --remove-mcp        Remove an MCP server entry\n" +
        "    --name <id> --scope user|project [--cwd <path>]\n" +
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
      if (!name || !command) {
        throw new Error("--name and --command are required");
      }
      const result = upsertMcpServer({
        scope,
        name,
        projectRoot: cwd,
        config: { command, args, enabled },
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
