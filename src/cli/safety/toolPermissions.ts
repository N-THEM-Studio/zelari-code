/**
 * Tool permission policy — allow | ask | deny by permission category.
 *
 * Complements sandbox + shell blocklist. Plan phase still strips mutators at
 * registry build time; this layer adds interactive "ask", session grants
 * ("allow always this session"), and optional env overrides.
 *
 * Env (optional):
 *   ZELARI_AUTO=1              — treat "ask" as "allow" (headless / --auto)
 *   ZELARI_PERMISSION_WRITE    — allow|ask|deny (default allow)
 *   ZELARI_PERMISSION_EXECUTE  — allow|ask|deny (default allow)
 *   ZELARI_PERMISSION_NETWORK  — allow|ask|deny (default allow)
 *   ZELARI_PERMISSION_READ     — allow|ask|deny (default allow)
 *
 * @since v1.21.0
 */

import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionPolicy {
  read: PermissionAction;
  write: PermissionAction;
  execute: PermissionAction;
  network: PermissionAction;
  ui: PermissionAction;
  /** When true, "ask" resolves as allow without UI. */
  auto: boolean;
}

export interface PermissionDecision {
  action: PermissionAction;
  /** Human reason for deny/ask. */
  reason: string;
  /** Categories that triggered ask/deny. */
  categories: ToolPermission[];
}

// ── Session grants ("Allow always this session") ───────────────────────────

const sessionToolGrants = new Set<string>();
const sessionCategoryGrants = new Set<ToolPermission>();

export function grantSessionTool(toolName: string): void {
  const n = toolName.trim();
  if (n) sessionToolGrants.add(n);
}

export function grantSessionCategory(cat: ToolPermission): void {
  sessionCategoryGrants.add(cat);
}

export function clearSessionPermissionGrants(): void {
  sessionToolGrants.clear();
  sessionCategoryGrants.clear();
}

export function listSessionPermissionGrants(): {
  tools: string[];
  categories: ToolPermission[];
} {
  return {
    tools: [...sessionToolGrants].sort(),
    categories: [...sessionCategoryGrants],
  };
}

/** True if this tool is fully covered by session grants (no need to ask). */
export function isSessionGranted(
  toolName: string,
  required: readonly ToolPermission[],
): boolean {
  if (sessionToolGrants.has(toolName)) return true;
  if (!required.length) return false;
  // All required categories must be granted for a category-only grant to apply.
  return required.every((c) => sessionCategoryGrants.has(c));
}

function parseAction(raw: string | undefined, fallback: PermissionAction): PermissionAction {
  const v = raw?.trim().toLowerCase();
  if (v === 'allow' || v === 'ask' || v === 'deny') return v;
  return fallback;
}

export function isAutoPermissions(): boolean {
  const v = process.env.ZELARI_AUTO?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Default policy from env (build phase). */
export function defaultPermissionPolicy(
  overrides?: Partial<PermissionPolicy>,
): PermissionPolicy {
  return {
    read: parseAction(process.env.ZELARI_PERMISSION_READ, 'allow'),
    write: parseAction(process.env.ZELARI_PERMISSION_WRITE, 'allow'),
    execute: parseAction(process.env.ZELARI_PERMISSION_EXECUTE, 'allow'),
    network: parseAction(process.env.ZELARI_PERMISSION_NETWORK, 'allow'),
    ui: 'allow',
    auto: isAutoPermissions(),
    ...overrides,
  };
}

/**
 * Restrictiveness lattice for {@link PermissionAction}: deny > ask > allow
 * (most restrictive wins).
 */
const ACTION_RANK: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

function moreRestrictive(a: PermissionAction, b: PermissionAction): PermissionAction {
  return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b;
}

/**
 * Capability inheritance (P0.4): a Kraken tentacle (sub-agent spawned via
 * the `task` tool) must NEVER hold more permission than its parent. The
 * sub-agent's effective policy is the intersection of the parent's policy
 * and the sub-agent profile's own policy, merged per category with the most
 * restrictive action winning (deny > ask > allow). A category restricted in
 * only ONE of the two policies keeps that restriction.
 *
 * `auto` (ask resolves as allow without UI) intersects as the AND of both:
 * silently auto-allowing a category the parent would have had to ask about
 * would itself be an escalation.
 *
 * If the intersection downgrades a category to `ask` while the sub-agent
 * context has no interactive ask handler, resolution must FAIL CLOSED
 * (deny). That behavior already lives in `wrapWithPermissions`
 * (toolRegistry.ts): `ask` without `onPermissionAsk` returns a typedErr, so
 * the escalation path stays closed with no extra handling here.
 *
 * Pure function, no I/O.
 */
export function intersectPermissionPolicy(
  parent: PermissionPolicy,
  child: PermissionPolicy,
): PermissionPolicy {
  return {
    read: moreRestrictive(parent.read, child.read),
    write: moreRestrictive(parent.write, child.write),
    execute: moreRestrictive(parent.execute, child.execute),
    network: moreRestrictive(parent.network, child.network),
    ui: moreRestrictive(parent.ui, child.ui),
    auto: parent.auto && child.auto,
  };
}

/**
 * Resolve effective action for a tool given its required permission tags.
 * Empty permissions → allow. Most restrictive action wins: deny > ask > allow.
 * Session grants promote ask → allow for the rest of the process.
 */
export function resolveToolPermission(
  toolName: string,
  required: readonly ToolPermission[],
  policy: PermissionPolicy,
): PermissionDecision {
  if (!required.length) {
    return { action: 'allow', reason: '', categories: [] };
  }

  // Session "allow always" short-circuit (before deny? No — explicit deny wins).
  // We still evaluate deny first.

  let worst: PermissionAction = 'allow';
  const hit: ToolPermission[] = [];

  for (const cat of required) {
    const a =
      cat === 'read'
        ? policy.read
        : cat === 'write'
          ? policy.write
          : cat === 'execute'
            ? policy.execute
            : cat === 'network'
              ? policy.network
              : cat === 'ui'
                ? policy.ui
                : 'allow';
    if (a === 'deny') {
      worst = 'deny';
      hit.push(cat);
    } else if (a === 'ask' && worst !== 'deny') {
      worst = 'ask';
      hit.push(cat);
    }
  }

  if (worst === 'allow') {
    return { action: 'allow', reason: '', categories: [] };
  }

  if (worst === 'deny') {
    return {
      action: 'deny',
      reason: `Permission denied for tool "${toolName}" (${hit.join(', ')}). Policy forbids this action.`,
      categories: hit,
    };
  }

  // ask — auto mode or session grant promotes to allow
  if (policy.auto || isSessionGranted(toolName, hit.length ? hit : required)) {
    return { action: 'allow', reason: '', categories: [] };
  }

  return {
    action: 'ask',
    reason: `Tool "${toolName}" requires approval (${hit.join(', ')}).`,
    categories: hit,
  };
}

export type PermissionAskHandler = (req: {
  toolName: string;
  reason: string;
  categories: ToolPermission[];
  args: unknown;
}) => Promise<boolean>;
