/**
 * ExtensionAPI seam runtime (t30, Pilastro C).
 *
 * `ExtensionRegistry` COLLECTS what extensions register — it never executes
 * tools and never grants permissions. The host (zelari-code CLI) later:
 *   1. turns every collected spec into a real ToolDefinition and pushes it
 *      through the SAME wrapWithPermissions path as builtin tools, so the
 *      declared permissions are intersected DOWN against the parent policy
 *      and the TaskContract capability layer still intersects LAST;
 *   2. runs the collected onPreToolUse handlers through
 *      {@link runExtensionPreToolUse} with the t22 failure semantics:
 *      a crashing/hanging handler is fail-open (log + allow, interactive
 *      TUI) or fail-closed (deny with reason 'extension-hook-failed',
 *      strict headless/mission/CI surfaces).
 *
 * @since 2.22.0 (t30)
 */

import type { HookFailureMode } from '../core/hooks/lifecycleHookRunner.js';
import type {
  ExtensionHost,
  ExtensionPreToolUseEvent,
  ExtensionPreToolUseHandler,
  RegisteredExtensionTool,
  RegisteredPreToolUseHandler,
  SandboxedFs,
  ExtensionPreToolUseVerdict,
  ZelariExtension,
} from './extensionApiTypes.js';

/** True when a handler matcher applies to this tool name ('*' or exact, case-insensitive). */
export function extensionMatcherMatches(matcher: string, toolName: string): boolean {
  const m = matcher.trim().toLowerCase();
  if (m === '' || m === '*') return true;
  return m === toolName.trim().toLowerCase();
}

/**
 * Collection-only registry. One instance per host load; the loader feeds
 * each on-disk extension through {@link registerExtension}, which builds
 * the narrow {@link ExtensionHost} and awaits `register()`.
 */
export class ExtensionRegistry {
  private tools: RegisteredExtensionTool[] = [];
  private handlers: RegisteredPreToolUseHandler[] = [];
  private readonly toolNames = new Set<string>();

  /**
   * Run one extension's register() against a host bound to THIS registry.
   * A duplicate tool name (vs builtins checked later by the host, or vs
   * another extension checked here) throws — the loader catches and skips
   * the offending extension loudly instead of letting it shadow a tool.
   */
  async registerExtension(
    extension: ZelariExtension,
    options: { fs: SandboxedFs },
  ): Promise<void> {
    const extensionId = extension.id;
    const host: ExtensionHost = {
      fs: options.fs,
      registerTool: (spec) => {
        const name = spec.name?.trim();
        if (!name) throw new Error(`extension "${extensionId}" registered a tool with an empty name`);
        if (this.toolNames.has(name)) {
          throw new Error(`extension "${extensionId}" tried to register duplicate tool "${name}"`);
        }
        this.toolNames.add(name);
        this.tools.push({ extensionId, spec });
      },
      onPreToolUse: (matcher, handler) => {
        this.handlers.push({ extensionId, matcher, handler });
      },
    };
    await extension.register(host);
  }

  /** Collected tool declarations (unwrapped — NOT yet policy-checked). */
  listExtensionTools(): readonly RegisteredExtensionTool[] {
    return [...this.tools];
  }

  /** Collected PreToolUse observers, in registration order. */
  get preToolUseHandlers(): readonly RegisteredPreToolUseHandler[] {
    return [...this.handlers];
  }

  /**
   * Drop everything one extension registered (loader cleanup when its
   * register() throws halfway: a partial registration must not linger).
   */
  removeExtension(extensionId: string): void {
    this.tools = this.tools.filter((t) => t.extensionId !== extensionId);
    this.handlers = this.handlers.filter((h) => h.extensionId !== extensionId);
    this.toolNames.clear();
    for (const t of this.tools) this.toolNames.add(t.spec.name);
  }
}

export interface RunExtensionPreToolUseOptions {
  /** t22: 'fail-closed' denies on handler crash; 'fail-open' logs + allows. */
  failureMode?: HookFailureMode;
  /** Logger sink (default: console.error). */
  logger?: (msg: string) => void;
}

/**
 * Run the extension PreToolUse phase for one tool call. ONLY an explicit
 * `{ deny: true }` decision blocks the call. An unreliable handler
 * (crash / rejection / non-object return) is logged and — per failureMode —
 * either allows the call (fail-open, default) or denies it with reason
 * 'extension-hook-failed' (fail-closed, same shape as the JSON-hook runner
 * of t22). Never throws.
 */
export async function runExtensionPreToolUse(
  handlers: readonly RegisteredPreToolUseHandler[],
  event: ExtensionPreToolUseEvent,
  options: RunExtensionPreToolUseOptions = {},
): Promise<ExtensionPreToolUseVerdict> {
  const logger = options.logger ?? ((msg: string) => console.error(`[extensions] ${msg}`));
  const failureMode: HookFailureMode = options.failureMode ?? 'fail-open';
  for (const entry of handlers) {
    if (!extensionMatcherMatches(entry.matcher, event.toolName)) continue;
    let decision: unknown;
    try {
      decision = await entry.handler(event);
    } catch (err) {
      if (failureMode === 'fail-closed') {
        return {
          ok: false,
          extensionId: entry.extensionId,
          reason: 'extension-hook-failed',
        };
      }
      logger(
        `extension "${entry.extensionId}" PreToolUse handler failed (fail-open, allowing): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (
      decision !== null &&
      typeof decision === 'object' &&
      (decision as { deny?: unknown }).deny === true
    ) {
      const reason = (decision as { reason?: unknown }).reason;
      return {
        ok: false,
        extensionId: entry.extensionId,
        reason:
          typeof reason === 'string' && reason.trim() !== ''
            ? reason
            : `denied by extension "${entry.extensionId}"`,
      };
    }
  }
  return { ok: true };
}
