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
import { PERMISSION_RULE_CATEGORIES } from '../safety/permissionPolicy.js';
import {
  addSessionPermissionRule,
  listSessionPermissionRules,
  loadProjectPermissionRules,
  removeSessionPermissionRule,
  clearSessionPermissionRules,
} from '../safety/permissionRules.js';
import {
  clearPermissionDenials,
  listRecentPermissionDenials,
  type PermissionDenialRecord,
} from '../safety/permissionGate.js';

export interface PermissionsHandlerCtx {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export const PERMISSIONS_USAGE = [
  '/permissions — active rules (source: default | project | session) + recent denials',
  '/permissions add <id> <allow|ask|deny> [tool=<name|glob>] [category=read|write|execute|network|ui] [pathPrefix=<p>] [host=<h>] [note=<text>]',
  '/permissions remove <id> — drop a session rule',
  '/permissions clear — drop every session rule',
  '/permissions denials [--clear] — recent denials',
].join('\n');

const MATCHER_KEYS = ['tool', 'category', 'pathPrefix', 'host', 'note'] as const;

/** `id effect tool=bash pathPrefix=docs` → the raw rule object (zod validates it). */
function parseRuleArgs(args: readonly string[]):
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string } {
  const [id, effect, ...rest] = args;
  if (!id || !effect) return { ok: false, error: 'usage: /permissions add <id> <allow|ask|deny> [matchers…]' };
  const raw: Record<string, unknown> = { id, effect };
  for (const token of rest) {
    const eq = token.indexOf('=');
    if (eq <= 0) return { ok: false, error: `unparseable argument '${token}' (expected key=value)` };
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!(MATCHER_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown matcher '${key}' (expected ${MATCHER_KEYS.join('/')})` };
    }
    if (value === '') return { ok: false, error: `empty value for '${key}'` };
    raw[key] = value;
  }
  return { ok: true, raw };
}

function formatRuleLine(source: string, id: string, effect: string, matchers: string, note?: string): string {
  return `  [${source}] ${id} → ${effect}${matchers ? ` (${matchers})` : ''}${note ? ` — ${note}` : ''}`;
}

function matchersOf(rule: {
  tool?: string;
  category?: string;
  pathPrefix?: string;
  host?: string;
}): string {
  return [
    rule.tool !== undefined ? `tool=${rule.tool}` : '',
    rule.category !== undefined ? `category=${rule.category}` : '',
    rule.pathPrefix !== undefined ? `pathPrefix=${rule.pathPrefix}` : '',
    rule.host !== undefined ? `host=${rule.host}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatPermissionDenialLine(d: PermissionDenialRecord): string {
  const when = new Date(d.ts).toISOString();
  return `  ${when} ${d.tool} blocked by [${d.source}] '${d.matchedRuleId}'`;
}

/** The full `/permissions` report (pure — same input, same text). */
export function formatPermissionsReport(cwd: string): string {
  const policy = defaultPermissionPolicy();
  const project = loadProjectPermissionRules(cwd);
  const session = listSessionPermissionRules();
  const denials = listRecentPermissionDenials(10);
  const lines: string[] = [
    '[permissions] local policy engine (WS1) — evaluated before every tool dispatch',
    '  precedence: deny > ask > allow, then most specific rule, then session before project',
    '',
    `default (5 categories, unchanged): read=${policy.read} write=${policy.write} execute=${policy.execute} network=${policy.network} ui=${policy.ui}${policy.auto ? ' auto=on' : ''}`,
    `  editable via ZELARI_PERMISSION_<CATEGORY> / --permissions <preset> — not here`,
    '',
    `project: ${project.path}`,
  ];
  if (project.error !== undefined) {
    lines.push(`  FAIL-CLOSED: ${project.error}`, '  (every unmatched tool call asks until the file is fixed)');
  } else if (project.rules.length === 0) {
    lines.push('  (no rules — absent or empty file)');
  } else {
    for (const { rule } of project.rules) {
      lines.push(formatRuleLine('project', rule.id, rule.effect, matchersOf(rule), rule.note));
    }
  }
  lines.push('', `session (${session.length} rule${session.length === 1 ? '' : 's'}, runtime-only)`);
  if (session.length === 0) lines.push('  (none — /permissions add <id> <effect> [matchers…])');
  else {
    for (const { rule } of session) {
      lines.push(formatRuleLine('session', rule.id, rule.effect, matchersOf(rule), rule.note));
    }
  }
  lines.push('', `recent denials (${denials.length})`);
  if (denials.length === 0) lines.push('  (none this session)');
  else for (const d of denials) lines.push(formatPermissionDenialLine(d));
  lines.push('', `categories: ${PERMISSION_RULE_CATEGORIES.join(', ')}`, '', PERMISSIONS_USAGE);
  return lines.join('\n');
}

/**
 * `/permissions [subcommand] …`. Mirrors the /trust handler shape: it renders
 * a system message and returns the text it renders (handy for tests).
 */
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
    case 'add': {
      const parsed = parseRuleArgs(args);
      if (!parsed.ok) {
        appendSystem(ctx.setMessages, `[permissions] ${parsed.error}\n\n${PERMISSIONS_USAGE}`);
        return parsed.error;
      }
      const res = addSessionPermissionRule(parsed.raw);
      if (!res.ok) {
        // Return what is rendered: the caller-facing text must carry the
        // REJECTION verdict, not just the bare schema error.
        const rejected = `[permissions] rejected: ${res.error}`;
        appendSystem(ctx.setMessages, rejected);
        return rejected;
      }
      const text = `[permissions] session rule '${res.rule.id}' → ${res.rule.effect}${
        matchersOf(res.rule) ? ` (${matchersOf(res.rule)})` : ''
      } — effective on the next dispatch (this process only, never persisted).`;
      appendSystem(ctx.setMessages, text);
      return text;
    }
    case 'remove':
    case 'rm':
    case 'delete': {
      const id = args[0];
      if (!id) {
        appendSystem(ctx.setMessages, '[permissions] usage: /permissions remove <id>');
        return '';
      }
      const removed = removeSessionPermissionRule(id);
      const text = removed
        ? `[permissions] removed session rule '${id}'.`
        : `[permissions] no session rule '${id}' (project rules are edited in ${loadProjectPermissionRules(cwd).path}).`;
      appendSystem(ctx.setMessages, text);
      return text;
    }
    case 'clear': {
      clearSessionPermissionRules();
      appendSystem(ctx.setMessages, '[permissions] all session rules cleared.');
      return 'cleared';
    }
    case 'denials':
    case 'denied': {
      if (args[0] === '--clear') {
        clearPermissionDenials();
        appendSystem(ctx.setMessages, '[permissions] denial ledger cleared.');
        return 'cleared';
      }
      const denials = listRecentPermissionDenials(20);
      const text =
        denials.length === 0
          ? '[permissions] no denials recorded this session.'
          : ['[permissions] recent denials:', ...denials.map(formatPermissionDenialLine)].join('\n');
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
