/**
 * slashHandlers/plugins — `/plugins` command: list optional-tool plugin status
 * and install them on demand.
 *
 * Two forms:
 *   /plugins            — print a status table (installed / missing) for all
 *                         plugins, IGNORING dontAskAgain so the user can
 *                         re-offer a previously-dismissed plugin.
 *   /plugins install <id> — install a specific plugin now (buffered, like /update).
 *
 * The interactive boot gate (PluginGate) is the proactive path; this command
 * is the on-demand path for users who skipped the gate (ZELARI_NO_PLUGIN_PROMPT,
 * non-TTY, or "maybe later"). The two share detectMissingPlugins + installPlugin,
 * so behaviour stays consistent.
 *
 * @see src/cli/components/PluginGate.tsx — boot gate (proactive)
 * @see src/cli/plugins/registry.ts       — detection
 * @see src/cli/plugins/installer.ts      — installation
 */

import type React from 'react';
import { PLUGINS, findPlugin } from '../plugins/registry.js';
import { installPlugin } from '../plugins/installer.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';

export interface PluginsSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

/**
 * `/plugins` — print the status of every optional plugin (installed/missing),
 * ignoring dontAskAgain so users can see what's available even if they muted
 * the boot prompt. Missing entries get an install hint.
 */
export async function handlePluginsList(ctx: PluginsSlashContext, cwd: string): Promise<void> {
  const lines: string[] = ['[plugins] optional tool plugins:'];
  for (const spec of PLUGINS) {
    let present = false;
    try {
      present = await spec.detect(cwd);
    } catch {
      present = false;
    }
    const mark = present ? '✓' : '✗';
    const state = present ? 'installed' : 'missing';
    const hint = present ? '' : ` — run \`/plugins install ${spec.id}\``;
    lines.push(`  ${mark} ${spec.label.padEnd(38)} ${state}${hint}`);
  }
  lines.push('Missing plugins are optional — features degrade silently without them.');
  appendSystem(ctx.setMessages, lines.join('\n'));
}

/**
 * `/plugins install <id>` — install a plugin now (buffered, like /update).
 * Validates the id, surfaces npm progress + result via system messages.
 */
export async function handlePluginsInstall(
  ctx: PluginsSlashContext,
  cwd: string,
  pluginId: string,
): Promise<void> {
  const spec = findPlugin(pluginId);
  if (!spec) {
    appendSystem(
      ctx.setMessages,
      `[plugins] unknown plugin id: '${pluginId}'. Available: ${PLUGINS.map((p) => p.id).join(', ')}`,
    );
    return;
  }
  const scopeFlag = spec.installScope === 'global' ? '-g' : '-D';
  appendSystem(
    ctx.setMessages,
    `[plugins] installing ${spec.label} (\`npm i ${scopeFlag} ${spec.npmPackage}\`)…`,
  );
  let result;
  try {
    result = await installPlugin(spec, cwd);
  } catch {
    // installPlugin never throws, but guard for robustness.
    result = { ok: false, output: '', exitCode: null, error: 'unexpected error' };
  }
  if (result.ok) {
    const post = spec.postInstallHint ? `\n  → ${spec.postInstallHint}` : '';
    appendSystem(ctx.setMessages, `[plugins] ✓ installed ${spec.label}${post}`);
  } else {
    const tail = result.output ? `\n${result.output.split('\n').slice(-8).join('\n')}` : '';
    appendSystem(
      ctx.setMessages,
      `[plugins] ✗ install failed for ${spec.label}: ${result.error ?? 'unknown error'}${tail}`,
    );
  }
}
