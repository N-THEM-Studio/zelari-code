/**
 * permissions.ts — `/permissions` slash handler (WS1 / t133).
 *
 *   /permissions                    — every ACTIVE rule with its source
 *                                     (default | project | session) + the most
 *                                     recent session denials
 *   /permissions list               — same as above
 *   /permissions add <id> <effect> [tool=…] [category=…] [pathPrefix=…]
 *                                  [host=…] [note=…]
 *                                   — add/replace a SESSION rule (runtime-only,
 *                                     zod-validated; an invalid rule is
 *                                     REJECTED and nothing is stored)
 *   /permissions remove <id>        — drop a SESSION rule
 *   /permissions clear              — drop every SESSION rule
 *   /permissions denials            — recent denials only
 *   /permissions help               — usage
 *
 * The 5 CATEGORY semantics (read/write/execute/network/ui) are the 'default'
 * source and are never editable here — env/preset flags own them. Project
 * rules come from the user-authored `.zelari/permissions.json`.
 *
 * @since v2.56.0 (WS1 / t133)
 */
import type { ChatMessage } from '../components/ChatStream.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import { defaultPermissionPolicy } from '../safety/toolPermissions.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildProjection,
  parseSessionLogText,
  resolveSessionsDir,
  type PermissionDenialSummary,
} from '@zelari/core/session';
import { getCurrentSessionId } from '../sessionManager.js';

export interface PermissionsHandlerCtx {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export const PERMISSIONS_USAGE = [
  '/permissions - category defaults + recent denials',
  '/permissions denials - recent denials (derived from the session spine)',
].join('\n');

export function formatPermissionDenialLine(d: PermissionDenialSummary): string {
  const when = new Date(d.at).toISOString();
  return `  ${when} ${d.tool} blocked by [${d.source}] '${d.matchedRuleId}'`;
}

/**
 * t142 — the denial ledger is DERIVE-ONLY: `/permissions` reads the
 * `permission.denied` events this session already wrote to the spine
 * (ADR-0016/0024 — same discipline as the inbox; the old 20-entry RAM
 * buffer is gone). `limit` caps the DISPLAY only, never the storage.
 * Fail-soft like /report: no marker or unreadable spine ⇒ [] (diagnostics,
 * never a gate).
 */
export function listSessionPermissionDenials(
  cwd: string,
  limit = 20,
  sessionId?: string,
): PermissionDenialSummary[] {
  try {
    const sessionsDir = resolveSessionsDir({ workspaceRoot: cwd, env: process.env });
    const marker = sessionId ?? getCurrentSessionId();
    const eventsPath = marker !== null ? path.join(sessionsDir, marker, 'events.jsonl') : null;
    if (eventsPath === null || !existsSync(eventsPath)) return [];
    const parsed = parseSessionLogText(eventsPath, readFileSync(eventsPath, 'utf-8'));
    const all = buildProjection(parsed.events, parsed.issues).permissionDenials;
    return all.slice(-Math.max(0, limit)).reverse(); // newest first
  } catch {
    return [];
  }
}

/** The full `/permissions` report (pure - same input, same text). */
export function formatPermissionsReport(cwd: string): string {
  // ADR-0039 P3b (t149): engine A (project permissions.json + session rules) is
  // gone - the report shows the category defaults and the spine-derived denial
  // ledger. Rules live in engine B (.zelari/policy.json).
  const policy = defaultPermissionPolicy();
  const denials = listSessionPermissionDenials(cwd, 10);
  const lines: string[] = [
    '[permissions] categories (evaluated before every tool dispatch)',
    '  rule layer: engine B (.zelari/policy.json) - see MIGRATION.md (ADR-0039)',
    '',
    `default (5 categories, unchanged): read=${policy.read} write=${policy.write} execute=${policy.execute} network=${policy.network} ui=${policy.ui}${policy.auto ? ' auto=on' : ''}`,
    `  editable via ZELARI_PERMISSION_<CATEGORY> / --permissions <preset> - not here`,
    '',
    `recent denials (${denials.length})`,
  ];
  if (denials.length === 0) lines.push('  (none this session)');
  else for (const d of denials) lines.push(formatPermissionDenialLine(d));
  lines.push('', PERMISSIONS_USAGE);
  return lines.join('\n');
}

export function handlePermissions(
  ctx: PermissionsHandlerCtx,
  subcommand: string | undefined,
  args: readonly string[] = [],
  cwd: string = process.cwd(),
): string {
  const sub = (subcommand ?? '').toLowerCase();
  switch (sub) {
    case '':
    case 'list':
    case 'show': {
      const text = formatPermissionsReport(cwd);
      appendSystem(ctx.setMessages, text);
      return text;
    }
    case 'add':
    case 'remove':
    case 'rm':
    case 'delete':
    case 'clear': {
      // ADR-0039 P3b (t149): the engine-A session-rule surface is gone.
      const text = `[permissions] '${sub}' is gone (ADR-0039 P3b): engine-A rules no longer exist. Configure engine B in .zelari/policy.json (see MIGRATION.md).`;
      appendSystem(ctx.setMessages, text);
      return text;
    }
    case 'denials':    case 'denials':
    case 'denied': {
      if (args[0] === '--clear') {
        // t142: derive-only - the spine is append-only, nothing to clear.
        const cleared = '[permissions] denial ledger is derived from the session spine (append-only) - nothing to clear.';
        appendSystem(ctx.setMessages, cleared);
        return cleared;
      }
      const denials = listSessionPermissionDenials(cwd, 20);
      const text =
        denials.length === 0
          ? '[permissions] no denials recorded this session.'
          : ['[permissions] recent denials (session spine):', ...denials.map(formatPermissionDenialLine)].join('\n');
      appendSystem(ctx.setMessages, text);
      return text;
    }
    default: {
      // Return the text that was rendered — it names the bogus subcommand —
      // instead of the bare usage block, so a caller can SEE the rejection.
      const text = `[permissions] unknown subcommand '${sub}'.\n\n${PERMISSIONS_USAGE}`;
      appendSystem(ctx.setMessages, text);
      return text;
    }
  }
}
