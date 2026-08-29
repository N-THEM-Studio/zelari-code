/**
 * ExtensionAPI seam types (t30, Pilastro C).
 *
 * Dependency direction: this module (and extensionApi.ts) live in
 * @zelari/core and MUST NOT import CLI code. The host (zelari-code CLI)
 * injects the real sandboxed-fs implementation the same DI way it binds
 * runOneTurn into the App Server kernel (t29).
 *
 * SEAM, not a framework (ADR-0022 rejected a generic plugin system):
 *  - `ZelariExtension.register(ExtensionHost)` is the ONLY entrypoint;
 *  - the host exposes registerTool + onPreToolUse + a sandboxed fs — and
 *    NOTHING else (no process / child_process / net surface);
 *  - code is loaded from disk by the host, never eval'd from a prompt;
 *  - MCP stays a remote tool; plugins/registry.ts (binary catalog) is a
 *    different subsystem and is not involved.
 *
 * Enforcement lives with the host that registers the collected tools: the
 * CLI pushes every `registerTool` through the SAME wrapWithPermissions
 * path as builtins (category policy → agent rules → resource claims →
 * ContractCompiler intersect LAST), so an extension can declare whatever
 * permissions it wants — it can never WIDEN the parent policy.
 */

import type { ZodSchema } from 'zod';
import type { ToolPermission, TypedResult } from '../core/tools/toolTypes.js';

/**
 * Sandboxed FS surface handed to extensions — the ONLY filesystem reach an
 * extension gets. Core defines the shape; the CLI binds an implementation
 * rooted at the workspace and backed by the symlink-safe sandbox resolver
 * (src/cli/safety/sandboxPath.ts). All paths are ROOT-RELATIVE; anything
 * resolving outside the root is a typed error, never a throw into the
 * extension's caller.
 */
export interface SandboxedFs {
  /** Absolute root every path is resolved against (the workspace root). */
  readonly root: string;
  /** Read a UTF-8 text file inside the root. */
  readFile(relativePath: string): Promise<TypedResult<string>>;
  /** Write a UTF-8 text file inside the root (containment re-verified). */
  writeFile(
    relativePath: string,
    data: string,
  ): Promise<TypedResult<{ path: string }>>;
  /** List direct entries of a directory inside the root (names only). */
  listFiles(relativePath?: string): Promise<TypedResult<string[]>>;
}

/**
 * Declaration-only tool spec an extension may register. The PERMISSIONS
 * here are a declaration the host feeds into its own policy intersection —
 * never a grant. `execute` receives VALIDATED input only.
 */
export interface ExtensionToolSpec<I = unknown, O = unknown> {
  /** Stable tool name. Must not collide with an existing tool. */
  name: string;
  /** Human-readable description (shown to the model). */
  description: string;
  /** Zod schema — the SAME validation gate builtin tools go through. */
  inputSchema: ZodSchema<I>;
  /** Permission categories this tool needs (read|write|execute|network|ui). */
  permissions: readonly ToolPermission[];
  /** Async executor over validated input. */
  execute: (input: I) => Promise<TypedResult<O>>;
}

/** A tool as collected by the registry, stamped with its extension id. */
export interface RegisteredExtensionTool {
  readonly extensionId: string;
  readonly spec: ExtensionToolSpec;
}

/** Pre-tool-use event passed to extension handlers (read-only view). */
export interface ExtensionPreToolUseEvent {
  readonly toolName: string;
  readonly toolInput: unknown;
}

/** What a handler may return to influence the call. Absent ⇒ no opinion. */
export interface ExtensionPreToolUseDecision {
  /** True blocks the tool call. */
  deny?: boolean | undefined;
  /** Human reason attached to a deny. */
  reason?: string | undefined;
}

export type ExtensionPreToolUseHandler = (
  event: ExtensionPreToolUseEvent,
) =>
  | Promise<ExtensionPreToolUseDecision | void>
  | ExtensionPreToolUseDecision
  | void;

/** A handler as collected, attributed to the extension that registered it. */
export interface RegisteredPreToolUseHandler {
  readonly extensionId: string;
  /** Exact tool name (case-insensitive) or '*' for every tool. */
  readonly matcher: string;
  readonly handler: ExtensionPreToolUseHandler;
}

/**
 * The narrow host object an extension receives in register(). Deliberately
 * minimal: two registration methods + the sandboxed fs. Nothing here can
 * spawn processes, open sockets, or read the raw filesystem.
 */
export interface ExtensionHost {
  /** Register a tool (goes through the host's permission wrapper later). */
  registerTool(spec: ExtensionToolSpec): void;
  /** Observe tool calls before execution; may deny with a typed reason. */
  onPreToolUse(matcher: string, handler: ExtensionPreToolUseHandler): void;
  /** Root-constrained filesystem helpers (the ONLY fs reach). */
  readonly fs: SandboxedFs;
}

/** The extension contract: an id + a register function. That is all. */
export interface ZelariExtension {
  /** Stable identifier (used in denies, logs and lockfile diagnostics). */
  readonly id: string;
  register(host: ExtensionHost): void | Promise<void>;
}

/** Verdict of the extension PreToolUse phase (mirrors PreToolUseResult). */
export interface ExtensionPreToolUseVerdict {
  /** false ⇒ the tool call must be denied. */
  ok: boolean;
  /** Extension that denied (or whose handler crashed) — for diagnostics. */
  extensionId?: string;
  /** Deny reason (explicit, or 'extension-hook-failed' in fail-closed). */
  reason?: string;
}
