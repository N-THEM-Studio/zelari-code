/**
 * slashHandlers/statusline — `/statusline` (t114).
 *
 * Minimal, numeric-selection-free interaction that matches the other slash
 * handlers: every sub-command is idempotent, prints a compact table, and
 * persists the config (fail-soft — a failed write is REPORTED, never thrown).
 *
 *   /statusline                      show the current order + availability
 *   /statusline on <item>            enable an item
 *   /statusline off <item>           disable an item
 *   /statusline up <item>            move an item one slot earlier
 *   /statusline down <item>          move an item one slot later
 *   /statusline custom <command>     set (and preview) the custom script
 *   /statusline custom clear         drop the custom script
 *   /statusline timeout <ms>         change the custom script timeout
 *   /statusline reset                back to the default chip order
 *
 * The pure text rendering lives in `renderStatusLine` so it is testable
 * without touching disk; `handleStatusLine` performs the read-modify-write.
 */
import {
  DEFAULT_STATUSLINE_TIMEOUT_MS,
  STATUSLINE_MAX_TEXT_CHARS,
  defaultStatusLineConfig,
  loadStatusLineConfig,
  moveItem,
  setCustomCommand,
  setItemEnabled,
  updateStatusLineConfig,
  type StatusLineConfig,
} from '../statusline/statuslineConfig.js';
import { previewStatusLineCustomItem } from '../statusline/statuslineCustom.js';
import { formatStatusLineItems, statusLineItemLabel } from '../statusline/statuslineItems.js';

export interface StatusLineHandlerOptions {
  /** Config file override (tests / CI isolation). */
  file?: string;
  /** Skip persisting (dry-run used by tests). */
  dryRun?: boolean;
}

/** `1. mode → 2. model …` — the configured order, numbered. */
function orderLine(config: StatusLineConfig): string {
  if (config.items.length === 0) return '(none — the bar will show nothing)';
  return config.items.map((id, i) => `${i + 1}.${statusLineItemLabel(id)}`).join(' ');
}

/** Pure report body: current order + the catalog with on/off marks. */
export function renderStatusLine(config: StatusLineConfig, notice?: string): string {
  const lines: string[] = [];
  if (notice) lines.push(`[statusline] ${notice}`, '');
  lines.push(`order: ${orderLine(config)}`);
  lines.push(
    config.custom
      ? `custom: ${config.custom.command} (timeout ${config.custom.timeoutMs}ms, 1 line, ≤${STATUSLINE_MAX_TEXT_CHARS} chars)`
      : `custom: (not configured) — set one with /statusline custom <command>`,
  );
  lines.push('', 'items:');
  lines.push(formatStatusLineItems(config.items));
  lines.push(
    '',
    'usage: /statusline [on|off|up|down] <item> · /statusline custom <command|clear> · /statusline timeout <ms> · /statusline reset',
  );
  return lines.join('\n');
}

/**
 * Apply one `/statusline` invocation. Returns the message to print; the
 * persistence failure (if any) is folded into the message, never thrown.
 */
export function handleStatusLine(
  args: readonly string[],
  opts: StatusLineHandlerOptions = {},
): string {
  const io = { file: opts.file };
  const sub = (args[0] ?? '').toLowerCase();
  const target = args[1] ?? '';
  if (sub === '' || sub === 'show' || sub === 'list') {
    return renderStatusLine(loadStatusLineConfig(io));
  }
  if (sub === 'reset') {
    if (opts.dryRun) return `[statusline] reset (dry-run)`;
    // Write the DEFAULT list explicitly: an empty `items` now means "nothing
    // enabled" (see normalizeStatusLineConfig), so it can no longer double as
    // the reset sentinel.
    const { ok } = updateStatusLineConfig(() => defaultStatusLineConfig(), io);
    return ok
      ? renderStatusLine(loadStatusLineConfig(io), 'reset to the default chip order')
      : '[statusline] reset failed: cannot write the config file — the current order stays active';
  }
  if (sub === 'custom') {
    if (target === '') return '[statusline] usage: /statusline custom <command> | /statusline custom clear';
    if (target.toLowerCase() === 'clear') {
      if (opts.dryRun) return '[statusline] custom cleared (dry-run)';
      const { ok } = updateStatusLineConfig((c) => setCustomCommand(c, null), io);
      return ok
        ? renderStatusLine(loadStatusLineConfig(io), 'custom item removed')
        : '[statusline] cannot write the config file';
    }
    const command = args.slice(1).join(' ');
    const preview = previewStatusLineCustomItem({ command });
    if (opts.dryRun) return `[statusline] custom = ${command} (dry-run; preview: ${preview ?? '(hidden)'})`;
    const { ok, config } = updateStatusLineConfig(
      (c) => setCustomCommand(c, command, c.custom?.timeoutMs ?? DEFAULT_STATUSLINE_TIMEOUT_MS),
      io,
    );
    if (!ok) return '[statusline] cannot write the config file';
    const notice =
      preview === null
        ? `custom script set but produced no usable first line (item stays hidden): ${command}`
        : `custom script set — first line: ${preview}`;
    return renderStatusLine(config, notice);
  }
  if (sub === 'timeout') {
    const ms = Number.parseInt(target, 10);
    if (!Number.isFinite(ms) || ms <= 0) return '[statusline] usage: /statusline timeout <ms>';
    const existing = loadStatusLineConfig(io).custom;
    if (!existing) return '[statusline] no custom script configured — set one first';
    if (opts.dryRun) return `[statusline] timeout = ${ms}ms (dry-run)`;
    const { ok, config } = updateStatusLineConfig(
      (c) => setCustomCommand(c, c.custom?.command ?? null, ms),
      io,
    );
    return ok ? renderStatusLine(config, `custom timeout set to ${ms}ms`) : '[statusline] cannot write the config file';
  }
  if (sub === 'on' || sub === 'off' || sub === 'up' || sub === 'down') {
    if (target === '') return `[statusline] usage: /statusline ${sub} <item>`;
    const before = loadStatusLineConfig(io);
    if (!before.items.includes(target) && sub !== 'on') {
      return `[statusline] '${target}' is not enabled — see /statusline for the available items`;
    }
    if (!before.items.includes(target) && sub === 'on' && target === 'custom' && !before.custom) {
      return `[statusline] configure the script first: /statusline custom <command>`;
    }
    if (opts.dryRun) return `[statusline] ${sub} ${target} (dry-run)`;
    const { ok, config } = updateStatusLineConfig(
      (c) =>
        sub === 'on'
          ? setItemEnabled(c, target, true)
          : sub === 'off'
            ? setItemEnabled(c, target, false)
            : moveItem(c, target, sub === 'up' ? -1 : 1),
      io,
    );
    if (!ok) return '[statusline] cannot write the config file';
    const verb = sub === 'on' ? 'enabled' : sub === 'off' ? 'disabled' : `moved ${sub}`;
    return renderStatusLine(config, `${target} ${verb}`);
  }
  const unknownReason = `unknown sub-command '${sub}'`;
  return renderStatusLine(loadStatusLineConfig(io), unknownReason);
}
