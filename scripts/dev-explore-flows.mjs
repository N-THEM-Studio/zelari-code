#!/usr/bin/env node
/**
 * dev-explore-flows — Probe the Zelari Code CLI's command handlers
 * directly, without going through the TUI. Same code paths as the
 * TUI (slashCommands.ts + app.tsx handlers) — only the rendering is
 * skipped.
 *
 * Useful for:
 *  - CI smoke tests
 *  - Headless verification of CLI behavior
 *  - Agent-driven exploration of the CLI surface
 */

import { handleSlashCommand, expandSkillTemplate } from '../dist/cli/slashCommands.js';
import { getProviderConfig } from '../dist/cli/providerConfig.js';
import { listSkills, SKILL_CATALOG } from '../dist/agents/skills.js';

const section = (title) => {
  console.log('\n\x1b[1m\x1b[36m' + '═'.repeat(78) + '\x1b[0m');
  console.log('\x1b[1m\x1b[36m  ' + title + '\x1b[0m');
  console.log('\x1b[1m\x1b[36m' + '═'.repeat(78) + '\x1b[0m');
};

const ok = (msg) => console.log('\x1b[32m✓\x1b[0m ' + msg);
const info = (msg) => console.log('\x1b[34mℹ\x1b[0m ' + msg);
const warn = (msg) => console.log('\x1b[33m⚠\x1b[0m ' + msg);

// ── 1. PROVIDER STATE ────────────────────────────────────────────────
section('FLOW 1 — Provider config (active + models)');
const cfg = getProviderConfig();
ok(`Active provider: ${cfg.activeProviderId}`);
info(`Model for grok: ${cfg.modelByProvider?.grok ?? '(unset)'}`);
info(`Model for glm:  ${cfg.modelByProvider?.glm  ?? '(unset)'}`);
info(`Model for openai-compatible: ${cfg.modelByProvider?.['openai-compatible'] ?? '(unset)'}`);
info(`Model for minimax: ${cfg.modelByProvider?.minimax ?? '(unset)'}`);
info(`Custom endpoints: ${Object.keys(cfg.customEndpoints ?? {}).length}`);

// ── 2. SLASH COMMAND PARSER ──────────────────────────────────────────
section('FLOW 2 — Slash command parser (handles 30+ commands)');
const commands = [
  '/help',
  '/skills',
  '/provider',
  '/model grok-4',
  '/cost',
  '/sessions',
  '/skill reproduce-bug',
  '/skill-suggest refactor auth',
  '/provider custom http://localhost:11434',
  '/provider list',
  '/quit',
  '/model set grok-4-fast-reasoning',
  '/model refresh',
  '/bogus-command',
  '/update',
  '/update --yes',
  '/update force',
  '/steer follow up question',
  '/steer --interrupt cancel',
  '/branch feature/foo',
  '/diff',
  '/undo',
  '/compact',
  '/session',
  '/resume last',
  '/council refactor the auth module',
  '/promote-member hephaestus',
];
for (const cmd of commands) {
  const r = handleSlashCommand(cmd, SKILL_CATALOG);
  if (r.handled) {
    ok(`${cmd.padEnd(45)} → kind=${r.kind}` + (r.provider ? ` provider=${r.provider}` : '') + (r.model ? ` model=${r.model}` : '') + (r.message ? ` msg="${r.message.slice(0, 40)}"` : ''));
  } else {
    warn(`${cmd.padEnd(45)} → UNHANDLED`);
  }
}

// ── 3. SKILLS REGISTRY ───────────────────────────────────────────────
section('FLOW 3 — Skills registry (23 coding skills)');
const skills = listSkills();
ok(`${skills.length} skills loaded`);
const grouped = {};
for (const s of skills) {
  const cat = s.category ?? s.group ?? 'uncategorized';
  if (!grouped[cat]) grouped[cat] = [];
  grouped[cat].push(s);
}
for (const [cat, list] of Object.entries(grouped).sort()) {
  info(`${cat}: ${list.length} skill(s) — ${list.map(s => s.name).slice(0, 3).join(', ')}${list.length > 3 ? '…' : ''}`);
}

// ── 4. COMMAND LIST (what /help would print) ─────────────────────────
section('FLOW 4 — /help command list');
const helpCommands = [
  ['/help', 'List all available commands'],
  ['/skill <name>', 'Invoke a coding skill'],
  ['/skills', 'List available skills'],
  ['/skill-suggest <query>', 'Get skill suggestions for a query'],
  ['/skill-history', 'Show skill invocation history'],
  ['/skill-compare <id1> <id2>', 'Compare two skills'],
  ['/provider', 'Show/set active LLM provider'],
  ['/model <model>', 'Set model for current provider'],
  ['/key <provider>', 'Set API key (or start OAuth for Grok)'],
  ['/cost', 'Show session cost breakdown'],
  ['/compact', 'Compact the chat transcript'],
  ['/session', 'Show session info'],
  ['/sessions', 'List past sessions'],
  ['/resume [id]', 'Resume a past session'],
  ['/branch [name]', 'Create/list/switch git branches'],
  ['/diff', 'Show working diff'],
  ['/undo', 'Undo working changes'],
  ['/update', 'Check for CLI updates'],
  ['/update --yes', 'Apply update'],
  ['/update force', 'Reinstall latest version'],
  ['/steer <text>', 'Queue follow-up prompt during active run'],
  ['/steer --interrupt <text>', 'Cancel current run + enqueue'],
  ['/promote-member <role>', 'Promote a council member'],
  ['/council', 'Dispatch council task'],
  ['/quit', 'Exit the CLI'],
];
for (const [c, d] of helpCommands) {
  console.log(`  \x1b[33m${c.padEnd(28)}\x1b[0m ${d}`);
}

console.log('\n\x1b[1m\x1b[32m✓ All flows probed without errors.\x1b[0m');
console.log('\nNext: a live Grok turn to verify end-to-end LLM streaming.');