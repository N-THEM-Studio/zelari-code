#!/usr/bin/env node
/**
 * anathema-coder — CLI coding agent on top of AnathemaBrain.
 * Phase 14 Task 14.3 + 14.4: multi-panel TUI + slash command wiring.
 */

import React from 'react';
import { render } from 'ink';
// @ts-ignore
import { App } from './app.js';
import { getMetricsLogger } from './metrics.js';

export const VERSION = '0.1.0';

/**
 * Silent background update check (Task N.6, v3-N).
 *
 * Runs ~3s after startup. If a newer version exists on npm, prints a
 * one-line hint to stderr (so it doesn't pollute the TUI). Failures
 * are swallowed silently — registry outages must NEVER block the CLI.
 *
 * Disabled in dev mode (`ZELARI_DEV=1`) to avoid noise during local
 * development where the bundled version is the source repo.
 */
async function backgroundUpdateCheck(): Promise<void> {
  if (process.env.ZELARI_DEV === '1') return;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    const { checkForUpdate } = await import('./updater.js');
    const info = await checkForUpdate();
    if (info.updateAvailable && !info.error) {
      // eslint-disable-next-line no-console
      console.error(
        `[zelari-coder] 🆕 v${info.latestVersion} available (current: v${info.currentVersion}). ` +
          `Run \`zelari-coder\` then \`/update --yes\` to upgrade.`,
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

function main() {
  const { waitUntilExit, unmount } = render(React.createElement(App));

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
