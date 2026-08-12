/**
 * trust.ts — /trust slash handler (v1.32.0).
 *
 * Manages the FolderTrustStore from the TUI:
 *   /trust               — show current trust status for the cwd
 *   /trust <path>        — trust the given folder (default: cwd)
 *   /trust remove <path> — remove trust for the given folder (default: cwd)
 *
 * Project MCP servers + project lifecycle hooks load only for trusted
 * folders; user-global (~/.zelari-code) config is always active.
 *
 * @since v1.32.0
 */

import type { ChatMessage } from '../components/ChatStream.js';
import {
  isFolderTrusted,
  listTrustedFolders,
  trustFolder,
  untrustFolder,
  getTrustStorePath,
} from '../safety/folderTrust.js';
import { appendSystem } from '../hooks/messageHelpers.js';

export interface TrustHandlerCtx {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

function resolvePath(raw: string | undefined): string {
  if (!raw || raw === '.' || raw === './') return process.cwd();
  return raw;
}

/** Render the current trust status as a system message. */
export function handleTrustStatus(
  ctx: TrustHandlerCtx,
  target: string,
): void {
  const trusted = isFolderTrusted(target);
  const all = listTrustedFolders();
  const lines = [
    `[trust] ${target}`,
    `  status: ${trusted ? 'trusted ✔' : 'NOT trusted ✖'}`,
    `  store:  ${getTrustStorePath()}`,
    `  folders: ${all.length === 0 ? '(none)' : ''}`,
    ...all.map((f) => `    - ${f.path} (${f.trustedAt})`),
    '',
    trusted
      ? '  Project MCP + project hooks are enabled for this folder.'
      : '  Project MCP (.zelari/mcp.json) and project hooks (.zelari/hooks/) are IGNORED until you run /trust .',
  ];
  appendSystem(ctx.setMessages, lines.join('\n'));
}

/** Trust a folder and report. */
export function handleTrust(ctx: TrustHandlerCtx, rawPath?: string): void {
  const target = resolvePath(rawPath);
  const res = trustFolder(target);
  appendSystem(
    ctx.setMessages,
    `[trust] trusted ${res.path}\n  Project MCP + project hooks will load on the next session/turn (run /trust to confirm).`,
  );
}

/** Remove trust for a folder and report. */
export function handleUntrust(ctx: TrustHandlerCtx, rawPath?: string): void {
  const target = resolvePath(rawPath);
  const res = untrustFolder(target);
  appendSystem(
    ctx.setMessages,
    res.removed
      ? `[trust] removed trust for ${target}\n  Project MCP + project hooks are now ignored for this folder.`
      : `[trust] ${target} was not trusted (nothing to remove).`,
  );
}
