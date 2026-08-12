/**
 * brokerHandlers — turn zelari's existing permission machinery into broker
 * handlers for external agents (OpenMausBot permission-proxy pattern).
 *
 * Reuses, without refactor:
 *   - `defaultPermissionPolicy()` — env-driven allow|ask|deny + ZELARI_AUTO
 *   - `resolveToolPermission()` — deny > ask > allow, session grants
 *   - `createPermissionAskHandler` (TUI) via the injected `onPermissionAsk`
 *
 * "Always this session" works across external requests too: the TUI picker
 * records session grants (`grantSessionTool`), and the next request for the
 * same tool short-circuits to allow without UI.
 *
 * @since v1.30.0
 */

import type { ToolPermission } from "@zelari/core/harness/tools/toolTypes";
import {
  defaultPermissionPolicy,
  isSessionGranted,
  resolveToolPermission,
  type PermissionAskHandler,
  type PermissionPolicy,
} from "../safety/toolPermissions.js";
import type {
  BrokerPermissionAnswer,
  BrokerPermissionRequest,
  BrokerQuestionAnswer,
  BrokerQuestionRequest,
} from "./permissionBroker.js";

/**
 * Map an external tool call to the permission categories zelari's policy
 * understands. Heuristic, conservative: anything path-like → `write`,
 * shell-ish tool names → `execute`, URL-ish inputs → `network`, otherwise
 * the default `['execute','network']` (matches the plan's default policy).
 */
export function inferPermissionCategories(
  toolName: string,
  input: unknown,
): ToolPermission[] {
  const cats = new Set<ToolPermission>();
  const name = toolName.toLowerCase();
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  if (/bash|shell|exec|command|run|npm|npx|yarn|pnpm|git|deno|bun|make/.test(name)) {
    cats.add("execute");
  }
  if (
    typeof obj.file_path === "string" ||
    typeof obj.path === "string" ||
    typeof obj.file === "string" ||
    typeof obj.destination === "string" ||
    typeof obj.repo === "string" ||
    typeof obj.target === "string"
  ) {
    cats.add("write");
  }
  if (
    typeof obj.url === "string" ||
    typeof obj.endpoint === "string" ||
    typeof obj.host === "string" ||
    /fetch|http|web|network|request/.test(name)
  ) {
    cats.add("network");
  }
  if (cats.size === 0) {
    cats.add("execute");
    cats.add("network");
  }
  return [...cats];
}

/**
 * Build the broker `onPermission` handler from zelari's policy.
 *
 * Flow: resolveToolPermission → allow (policy/session/auto) | deny | ask.
 * In ask state without an interactive handler (headless, tests) → deny with
 * a clear message — never hang.
 *
 * `always: true` is propagated to the external agent when the decision is a
 * SESSION GRANT (the TUI picker granted the tool/category, or the grant
 * already existed) — the external CLI can then skip re-asking for the same
 * tool for the rest of the session (mirrors OpenMausBot `updatedPermissions`).
 */
export function createBrokerPermissionHandler(opts: {
  onPermissionAsk?: PermissionAskHandler;
  policy?: PermissionPolicy;
}): (req: BrokerPermissionRequest) => Promise<BrokerPermissionAnswer> {
  const policy = opts.policy ?? defaultPermissionPolicy();
  return async (req) => {
    const categories = inferPermissionCategories(req.tool, req.input);
    const decision = resolveToolPermission(req.tool, categories, policy);

    if (decision.action === "allow") {
      // Distinguish policy allow from SESSION GRANT allow: a grant (tool or
      // category) must be surfaced as `always: true` so the external agent
      // stops re-asking; a plain policy allow carries no session meaning.
      const granted = isSessionGranted(
        req.tool,
        categories.length ? categories : ["execute"],
      );
      return granted ? { behavior: "allow", always: true } : { behavior: "allow" };
    }
    if (decision.action === "deny") {
      return { behavior: "deny", message: decision.reason };
    }
    if (!opts.onPermissionAsk) {
      return {
        behavior: "deny",
        message:
          `[zelari] no interactive approval available for "${req.tool}" ` +
          `(set ZELARI_AUTO=1 to auto-allow).`,
      };
    }
    const ok = await opts.onPermissionAsk({
      toolName: req.tool,
      reason: decision.reason,
      categories,
      args: req.input,
    });
    if (!ok) {
      return { behavior: "deny", message: "[zelari] denied by user" };
    }
    // The TUI picker grants the session BEFORE resolving true ("Always").
    // Detect it here so the external agent learns the grant too.
    if (isSessionGranted(req.tool, categories.length ? categories : ["execute"])) {
      return { behavior: "allow", always: true };
    }
    return { behavior: "allow" };
  };
}

/**
 * Build the broker `onQuestion` handler from an interactive question
 * callback (the TUI clarification picker). Returns null when there is no
 * callback or the human cancels → broker answers deny with a message.
 */
export function createBrokerQuestionHandler(opts: {
  onQuestion?: (req: {
    question: string;
    choices?: string[];
    context?: string;
  }) => Promise<string | null>;
}): (req: BrokerQuestionRequest) => Promise<BrokerQuestionAnswer | null> {
  return async (req) => {
    if (!opts.onQuestion) return null;
    const answer = await opts.onQuestion({
      question: req.question,
      choices: req.choices,
      context: req.context,
    });
    if (answer == null || !String(answer).trim()) {
      return { behavior: "deny", message: "[zelari] question cancelled" };
    }
    return { behavior: "allow", answer: String(answer).trim() };
  };
}
