/**
 * workspace/postCouncilHook.ts — Run the AGENTS.MD auto-maintenance
 * after every council run completes.
 *
 * Used by `councilDispatcher` (Phase 4 wiring) to keep AGENTS.MD in sync
 * with the latest `.zelari/` artifacts.
 */

import { updateAgentsMd } from './agentsMd.js';
import type { WorkspaceContext } from './types.js';

export interface HookResult {
  ran: boolean;
  changed: boolean;
  sections: string[];
  reason?: string;
}

/**
 * Run the post-council AGENTS.MD maintenance hook.
 * Returns info about what happened so the CLI can show a one-line summary
 * to the user (e.g. "AGENTS.MD updated: 2 sections changed (decisions, conventions)").
 *
 * Respects `ZELARI_AGENTS_MD=0` env var to opt out.
 */
export async function runPostCouncilHook(ctx: WorkspaceContext): Promise<HookResult> {
  if (process.env['ZELARI_AGENTS_MD'] === '0') {
    return { ran: false, changed: false, sections: [], reason: 'ZELARI_AGENTS_MD=0 (disabled)' };
  }

  try {
    const result = await updateAgentsMd(ctx, ctx.projectRoot);
    return {
      ran: true,
      changed: result.changed,
      sections: result.sections,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  } catch (err) {
    return {
      ran: false,
      changed: false,
      sections: [],
      reason: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}