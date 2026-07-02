#!/usr/bin/env node
/**
 * zelari-code — CLI coding agent on top of AnathemaBrain.
 * Phase 14 Task 14.3 + 14.4: multi-panel TUI + slash command wiring.
 */

import React from 'react';
import { render } from 'ink';
// @ts-ignore
import { App } from './app.js';
import { getMetricsLogger } from './metrics.js';
import { getProviderConfigPath } from './providerConfig.js';
import {
  parseWizardFlags,
  shouldRunWizard,
} from './wizard/firstRun.js';
import { RunWizard } from './wizard/runWizard.js';
import { parseHeadlessFlags } from './headless.js';
import { runHeadless } from './runHeadless.js';

export const VERSION = '0.6.1';

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
async function backgroundUpdateCheck(): Promise<void> {
  if (process.env.ANATHEMA_DEV === '1') return;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    const { checkForUpdate } = await import('./updater.js');
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
function pickRootComponent(): { kind: 'wizard' | 'app' | 'headless' | 'done'; element?: React.ReactElement; headlessOpts?: Parameters<typeof runHeadless>[0] } {
  const argv = process.argv.slice(2);

  if (argv.includes('--version') || argv.includes('-v')) {
    // eslint-disable-next-line no-console
    console.log(`zelari-code v${VERSION}`);
    process.exit(0);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(
      'zelari-code — AI Council coding agent CLI.\n' +
        '\n' +
        'Usage: zelari-code [options]\n' +
        '\n' +
        'Options:\n' +
        '  --version, -v       Print version and exit\n' +
        '  --help, -h          Print this help and exit\n' +
        '  --no-wizard         Skip the first-run wizard\n' +
        '  --reset-config      Re-run the wizard (clears provider.json on commit)\n' +
        '  --headless          Run a single task without mounting the TUI\n' +
        '    --task <text>       Task prompt (required in headless mode)\n' +
        '    --output json|plain Output format (default: json)\n' +
        '    --council          Use the 6-member council pipeline\n' +
        '    --provider <id>    Provider override (default: active)\n' +
        '    --model <id>       Model override (default: provider default)\n' +
        '\n' +
        'Environment:\n' +
        '  ZELARI_NO_WIZARD=1  Skip the first-run wizard\n' +
        '  ANATHEMA_DEV=1      Disable background update check\n',
    );
    process.exit(0);
  }

  // Headless mode: short-circuit TUI entirely. Must be checked BEFORE
  // the wizard branch so users can run scripted tasks on a fresh
  // install (no provider.json yet) by passing --provider + env var.
  const headlessParse = parseHeadlessFlags(argv);
  if (headlessParse.options !== null) {
    return { kind: 'headless', headlessOpts: headlessParse.options };
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
    return { kind: 'wizard', element: React.createElement(RunWizard) };
  }
  return { kind: 'app', element: React.createElement(App) };
}

function main() {
  const picked = pickRootComponent();
  if (picked.kind === 'done') return; // --version or --help printed + exited

  if (picked.kind === 'headless') {
    void runHeadless(picked.headlessOpts!).then((code) => {
      void getMetricsLogger().flush().catch(() => {});
      process.exit(code);
    });
    return;
  }

  const { waitUntilExit, unmount } = render(picked.element!);

  process.on('SIGINT', () => {
    unmount();
    void shutdown();
  });
  process.on('SIGTERM', () => {
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
