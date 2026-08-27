/**
 * toolRegistry — default ToolRegistry for the zelari-code CLI.
 *
 * Wires the 8 built-in tools (filesystem read/write/edit + bash + grep/list +
 * show_diff/apply_diff) into a ToolRegistry instance that the AgentHarness can
 * hand to the provider via `tools: registry.toOpenAITools()` + `toolRegistry: registry`.
 *
 * Task A1 of AnathemaCoder v3-A: enable the existing tool pipeline.
 * Task A2 of v3-A: wrap each tool with the safety layer (sandbox path,
 * shell blocklist, audit log).
 * v0.4.0: added show_diff + apply_diff + recursive grep_content.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3.md (Tasks A1 + A2)
 * @see docs/plans/2026-07-01-v0-4-0-fix-audit.md (v0.4.0 scope)
 */
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
} from '@zelari/core/harness/tools/builtin/filesystem';
import { bashTool } from '@zelari/core/harness/tools/builtin/shell';
import { grepContentTool } from '@zelari/core/harness/tools/builtin/search';
import { listFilesTool } from '@zelari/core/harness/tools/builtin/listFiles';
import { showDiffTool, applyDiffTool } from '@zelari/core/harness/tools/builtin/diff';
import { fetchUrlTool, webSearchTool } from '@zelari/core/harness/tools/builtin/web';
import { resolveSandboxedPath, SandboxViolationError } from './safety/sandboxPath.js';
import { assertShellAllowed, ShellBlockedError } from './safety/shellBlocklist.js';
import { AuditLogger } from './safety/auditLogger.js';
import { runDiagnosticsForFile, formatDiagnostics, type Runner } from './diagnostics/engine.js';
import type { BrainEvent } from '@zelari/core/shared/events';
import { createTaskTool, type TaskAgentKind, type TaskToolDeps } from './tools/taskTool.js';
import { createKrakenSelectTool } from './tools/krakenSelectTool.js';
import { createAskUserTool, type AskUserHandler } from './tools/askUser.js';
import { createSkillTool } from './tools/skillTool.js';
import { createTodoReadTool, createTodoWriteTool } from './tools/todoTools.js';
import {
  createPlanTaskTools,
  type PlanTaskEventSink,
} from './tools/planTaskTools.js';
import { createInspectCommandTool } from './tools/inspectCommand.js';
import { createExecProcessTool } from './tools/execProcess.js';
import { createObserveBatchTool } from './tools/observeBatch.js';
import { createRetrieveObservationTool } from './tools/retrieveObservation.js';
import { createLspTools } from './lsp/tools.js';
import { getSharedLspManager, type LspProvider } from './lsp/manager.js';
import { createAstTools } from './ast/tools.js';
import { createSemanticTool } from './semantic/tools.js';
import { createBrowserTool } from './browser/tools.js';
import { createSshTools } from './ssh/tools.js';
import { createWorldModelTools } from './workspace/worldModel.js';
import {
  providerFromEnv,
  providerConfigFor,
} from './provider/openai-compatible.js';
import { buildProviderStream } from './provider/resolveStream.js';
import { getKrakenVerifierOverride } from './providerConfig.js';
import type { ProviderName } from './keyStore.js';
import {
  defaultPermissionPolicy,
  intersectPermissionPolicy,
  resolveToolPermission,
  type PermissionAskHandler,
  type PermissionPolicy,
} from './safety/toolPermissions.js';
import { createDefaultLifecycleHooks } from './safety/lifecycleHooks.js';
import {
  agentLayersFor,
  emptyPolicySet,
  loadPolicySet,
  mergeRuleEffect,
  PolicyLoadError,
  type LayeredPolicyRuleSet,
  type PolicyPrecedence,
} from './safety/policyEngine.js';
import { activePolicyLoadMode } from './safety/policyLoadMode.js';
import { intersectEffects, matchAgentPolicyRuleLayered } from './safety/policyLayers.js';
// t22: the TaskContract compiles into a NON-OVERRIDABLE restrict-only layer.
import { matchContractCapabilityRule } from './kraken/contractCompiler.js';
import { resolveClaimsVerdict } from './safety/resourceClaims.js';
import { withResultCache } from './toolResultCache.js';
import type { LifecycleHookRunner } from '@zelari/core/harness';
import type {
  ToolDefinition,
  TypedResult,
  ToolContext,
  ToolPermission,
} from '@zelari/core/harness/tools/toolTypes';
import { typedErr } from '@zelari/core/harness/tools/toolTypes';
import { cliToolToEnhanced, registerCustomTool } from '@zelari/core/skills';
import type { EnhancedToolDefinition } from '@zelari/core/skills';
import type { MemoryService } from '@zelari/core/memory';

export interface BuiltinToolSummary {
  /** Tool name as registered. */
  name: string;
  /** Tool description. */
  description: string;
  /** Required permission (read | write | execute). */
  permissions: readonly string[];
}

export interface CreateRegistryOptions {
  /** Sandbox root. Defaults to process.cwd(). */
  root?: string;
  /** Audit logger instance. If omitted, creates a default file-backed one. */
  audit?: AuditLogger;
  /** Session id used in audit entries. */
  sessionId?: string;
  /**
   * Enable the post-edit diagnostics loop (fast file-scoped checker runs
   * after write_file/edit_file/apply_diff, appending errors to the result).
   * Defaults to true unless `ZELARI_DIAGNOSTICS=0` is set.
   */
  diagnostics?: boolean;
  /** Inject the diagnostics process runner (tests). Defaults to real spawn. */
  diagnosticsRunner?: Runner;
  /**
   * Read-only registry: register only observe tools (read/list/grep/show_diff/
   * fetch/web) and omit write/edit/apply_diff/bash + the `task` tool. Used to
   * build the isolated, non-recursive registry each sub-agent runs with.
   */
  readOnly?: boolean;
  /** Register the `task` sub-agent tool (default true unless readOnly). */
  enableTask?: boolean;
  /**
   * Fase 1 (ADR-0020): anchor the sub-agents spawned by `task` to this
   * provider/model (the resolved provider/model of the CURRENT turn).
   * Without this, tentacles silently fall back to the persisted
   * provider.json default, which can diverge from what the user selected.
   */
  subAgentProvider?: string;
  subAgentModel?: string;
  /**
   * Register the plan-safe explore-only `task` tool when planMode is on
   * (default true). Set false to restore the pre-ADR-0020 behaviour of
   * omitting `task` entirely from the plan registry.
   */
  planExploreTask?: boolean;
  /** Sink for tentacle activity events (Frontier plan §37); forwarded to the `task` tool. */
  onTentacleEvent?: (ev: BrainEvent) => void;
  /**
   * Fase 4 (ADR-0020): register `kraken_select` on the PARENT Kraken
   * registry. Callers set it only for kraken runs with the alpha
   * selection flag on; tentacle profiles never pass it, so sub-agents
   * can never nest a selection call.
   */
  krakenSelect?: boolean;
  /**
   * LSP navigation provider. Omit to use the shared, real language-server
   * manager; pass a fake in tests; pass `null` to disable the LSP tools.
   */
  lspProvider?: LspProvider | null;
  /**
   * v1.8.0 plan phase: omit mutating builtins (write/edit/bash/apply_diff).
   * Fase 1 (ADR-0020): the `task` tool now STAYS available in plan,
   * restricted to explore-only (read-only) tentacles — see planExploreTask.
   * Workspace plan tools can still be registered by the
   * caller. Equivalent to a soft read-only for project files.
   */
  planMode?: boolean;
  /**
   * Gauntlet conductor parent (P2): keep `task` so the host can fan out
   * builder/critic tentacles, but omit write/edit/bash and other mutators
   * so the lead cannot eat the work itself.
   */
  gauntletParent?: boolean;
  /**
   * Interactive ask_user tool (Grok-style). When provided, the tool blocks
   * the harness until the UI resolves. Omit for headless / readOnly subagents.
   */
  onAskUser?: AskUserHandler;
  /**
   * Permission policy (allow/ask/deny by category). Defaults from env via
   * {@link defaultPermissionPolicy}.
   */
  permissionPolicy?: PermissionPolicy;
  /**
   * Interactive approval when a tool resolves to "ask". If omitted and action
   * is ask (and not auto), the tool is denied with a clear message.
   */
  onPermissionAsk?: PermissionAskHandler;
  /**
   * P0.5 policy engine: the agent identity this registry runs as — 'lead'
   * (the default when omitted) for the main registry, or the sub-agent kind
   * ('explore' | 'general' | 'verify') for tentacle registries. Selects the
   * per-agent rule lists from `.zelari/policy.json` (project) and
   * `~/.zelari/policy.json` (global); a missing/broken file or
   * ZELARI_POLICY=0 yields no rules. createKrakenSubAgentContextFactory
   * passes the tentacle's kind here — that is how per-AGENT rules reach
   * sub-agents without threading identity through ToolContext.
   */
  policyAgent?: string;
  /**
   * Sub-agent tool profile:
   * - full: default parent registry
   * - explore: read-only observe tools
   * - verify: observe + bash (no writes, no task)
   * - general: full mutators but no nested task
   */
  profile?: 'full' | 'explore' | 'verify' | 'general';
  /** Register the lazy `skill` tool (default true unless readOnly/sub profile). */
  enableSkill?: boolean;
  /** Register session todo_write/todo_read (default true for full/plan parent). */
  enableTodos?: boolean;
  /**
   * Register the durable workspace plan-task tools (task_create/task_update/
   * task_list on .zelari/plan.json, ADR-0018). Default: enabled for the full
   * profile and in planMode (the plan is the plan-phase domain). Never
   * readOnly/explore/verify/general.
   */
  enablePlanTasks?: boolean;
  /**
   * Optional sink for first-class task events (task_update / task_snapshot,
   * ADR-0018 3b) emitted by the plan-task tools after durable writes. The
   * headless runner wires it to the NDJSON stream so the Desktop Live Tasks
   * panel needs no tool parsing.
   */
  onTaskEvent?: PlanTaskEventSink;
  /**
   * v0.10.0 lifecycle hooks. Default: auto — global hooks always +
   * project hooks when the folder is trusted (parent profiles only).
   * Pass a runner to override; pass null to disable.
   */
  lifecycleHooks?: LifecycleHookRunner | null;
  /** Native project memory shared by task-tool tentacles. */
  memoryService?: MemoryService;
  memoryAutoWrite?: boolean;
}

/**
 * Create a fresh ToolRegistry pre-populated with the 5 built-in tools,
 * each wrapped with the safety layer (Task A2).
 *
 * Safety policy applied:
 *  - filesystem tools: resolveSandboxedPath() on every path arg; throws
 *    SandboxViolationError if the path escapes the root.
 *  - bash: assertShellAllowed() on the command; throws ShellBlockedError
 *    on any blocklist match.
 *  - every tool: AuditLogger.runTool() wraps the call to record ts,
 *    args (redacted), ok, duration, summary.
 */
export function createBuiltinToolRegistry(
  options: CreateRegistryOptions = {},
): { registry: ToolRegistry; tools: BuiltinToolSummary[] } {
  const root = options.root ?? process.cwd();
  const audit = options.audit ?? new AuditLogger();
  const sessionId = options.sessionId ?? 'cli';

  // Wrap filesystem tools: sandbox the path argument before delegating.
  // Edit tools (write/edit/apply_diff) are ALSO wrapped with the diagnostics
  // loop: after a successful edit, a fast file-scoped checker runs on the
  // touched file and its errors/warnings are appended to the tool result so
  // the model sees compiler feedback in the same turn (opt out: ZELARI_DIAGNOSTICS=0).
  const diagnosticsOn = options.diagnostics ?? process.env.ZELARI_DIAGNOSTICS !== '0';
  const withDiag = <I extends Record<string, unknown>, O>(t: ToolDefinition<I, O>) =>
    diagnosticsOn ? wrapWithDiagnostics(t, root, options.diagnosticsRunner) : t;
  // Cache sits inside the sandbox wrap so permission + path checks still
  // run on every call; only the disk/search work is skipped on a hit.
  const safeReadFile = wrapWithSandbox(
    withResultCache(readFileTool, { kind: 'stat' }),
    ['path'],
    root,
    audit,
    sessionId,
  );
  const safeWriteFile = withDiag(wrapWithSandbox(writeFileTool, ['path'], root, audit, sessionId));
  const safeEditFile = withDiag(wrapWithSandbox(editFileTool, ['path'], root, audit, sessionId));
  const safeGrepContent = wrapWithSandbox(
    withResultCache(grepContentTool, { kind: 'ttl' }),
    ['path'],
    root,
    audit,
    sessionId,
  );
  const safeListFiles = wrapWithSandbox(
    withResultCache(listFilesTool, { kind: 'ttl' }),
    ['path'],
    root,
    audit,
    sessionId,
  );
  const safeShowDiff = wrapWithSandbox(showDiffTool, ['path'], root, audit, sessionId);
  const safeApplyDiff = withDiag(wrapWithSandbox(applyDiffTool, ['path'], root, audit, sessionId));

  // Wrap bash: shell blocklist + audit.
  const safeBash = wrapWithShellSafety(bashTool, audit, sessionId);

  // P0.C2 (t17): structured exec_process — same shell-safety discipline as
  // bash (blocklist + audit) with an evidence-grade audit summary
  // (`program argv -> exitCode=N`); registered THROUGH the permission
  // wrapper below so policy claims gate every execution.
  const safeExecProcess = wrapWithExecEvidence(createExecProcessTool(root), audit, sessionId);

  // v0.7.5: network tools — audit-only wrap (no filesystem paths to sandbox;
  // the tools themselves enforce http(s)-only + timeout + size caps).
  const safeFetchUrl = wrapWithAudit(fetchUrlTool, audit, sessionId);
  const safeWebSearch = wrapWithAudit(webSearchTool, audit, sessionId);

  const registry = new ToolRegistry();
  const profile = options.profile ?? 'full';

  // v0.10.0 P0: lifecycle hooks on parent registries. Sub-agent registries
  // (explore/verify/general) skip hooks — the parent already gates them.
  const isParent = !options.profile || options.profile === 'full';
  const hooks = isParent ? (options.lifecycleHooks ?? createDefaultLifecycleHooks(root)) : null;
  if (hooks) registry.setLifecycleHooks(hooks);
  // Read-only / plan / explore: observe only.
  // verify: observe + bash.
  // general: mutators but no nested task (handled below).
  const readOnly =
    options.readOnly === true ||
    options.planMode === true ||
    profile === 'explore';
  const verifyMode = profile === 'verify';
  const gauntletParent = options.gauntletParent === true;
  const allowMutators = !readOnly && !verifyMode && !gauntletParent;
  const allowBash = (allowMutators || verifyMode) && !gauntletParent;

  const permPolicy = options.permissionPolicy ?? defaultPermissionPolicy();
// P0.A layered policy engine: per-command/per-path rules for THIS agent
// identity with global and project kept as DISTINCT layers. Default
// evaluation is restrict-only (a global deny/ask can never be relaxed by the
// project file); ZELARI_POLICY_PRECEDENCE=legacy restores the v1
// project-first override. Loaded once per registry build; empty when
// absent/invalid/disabled (ZELARI_POLICY=0).
const agentPolicySet = (() => {
  // P0.B: load in the ACTIVE policy-load mode (resolvePolicyLoadMode:
  // ZELARI_POLICY_LOAD_MODE > strict for headless/CI/mission > permissive
  // TUI). Registry construction stays infallible — a strict-mode
  // PolicyLoadError degrades to the empty set with a loud stderr line here;
  // the HARD block happens in the runHeadless pre-flight gate
  // (headless/policyGate.ts), which returns exit 2 / `policy-load-failed`
  // before any registry is ever built.
  try {
    return loadPolicySet(root, { mode: activePolicyLoadMode() });
  } catch (err) {
    if (err instanceof PolicyLoadError) {
      process.stderr.write(`[policy] ${err.message} — registry continues WITHOUT agent rules.\n`);
      return emptyPolicySet();
    }
    throw err;
  }
})();
const agentPolicyLayers: LayeredPolicyRuleSet = agentLayersFor(
  agentPolicySet,
  options.policyAgent ?? 'lead',
);
  const withPerm = <I, O>(t: ToolDefinition<I, O>) =>
    wrapWithPermissions(
      t,
      permPolicy,
      options.onPermissionAsk,
      agentPolicyLayers,
      agentPolicySet.precedence,
      root,
    );

  // Observe tools — always registered.
  registry.register(withPerm(safeReadFile));
  registry.register(withPerm(safeGrepContent));
  registry.register(withPerm(safeListFiles));
  registry.register(withPerm(safeShowDiff));
  registry.register(withPerm(safeFetchUrl));
  registry.register(withPerm(safeWebSearch));

  // observe_batch — N read-only observations in one round-trip (2026-07
  // context-growth plan, Fase 1). Registered in BOTH full and read-only
  // registries; reuses the sandbox+permission+cache-wrapped tools above.
  // Kill switch ZELARI_OBSERVE_BATCH=0 (A/B against the Fase M baseline).
  const observeBatchTool =
    process.env.ZELARI_OBSERVE_BATCH !== '0'
      ? withPerm(
          createObserveBatchTool({
            tools: {
              read_file: safeReadFile,
              grep_content: safeGrepContent,
              list_files: safeListFiles,
            },
          }),
        )
      : null;
  if (observeBatchTool) {
    registry.register(observeBatchTool);
  }

  // retrieve_observation — rematerialize a projected tool result by seq
  // (2026-07 context-growth plan, Fase 2). Read-only; both registries.
  const retrieveObservationTool =
    process.env.ZELARI_SESSION_SURFACE !== '0'
      ? withPerm(createRetrieveObservationTool())
      : null;
  if (retrieveObservationTool) {
    registry.register(retrieveObservationTool);
  }

  // Mutating tools — full/general only.
  if (allowMutators) {
    registry.register(withPerm(safeWriteFile));
    registry.register(withPerm(safeEditFile));
    registry.register(withPerm(safeApplyDiff));
  }
  if (allowBash) {
    registry.register(withPerm(safeBash));
    // P0.C2: unlike legacy bash, exec_process is ALWAYS behind the
    // permission + resource-claims choke-point.
    registry.register(withPerm(safeExecProcess));
  }

  // Interactive clarification — available in plan + build (not pure explore RO).
  const askUserTool =
    options.readOnly === true ||
    profile === 'explore' ||
    profile === 'verify' ||
    gauntletParent
      ? null
      : createAskUserTool(options.onAskUser);
  if (askUserTool) {
    registry.register(withPerm(askUserTool));
  }

  // Lazy skill loader — parent (plan/build) and general subagent; not explore/verify.
  const enableSkill =
    options.enableSkill !== false &&
    options.readOnly !== true &&
    !gauntletParent &&
    profile !== 'explore' &&
    profile !== 'verify';
  const skillTool = enableSkill ? withPerm(createSkillTool({ cwd: root })) : null;
  if (skillTool) {
    registry.register(skillTool);
  }

  // Session todos — parent agent only (not explore/verify; general skips like OpenCode).
  const enableTodos =
    options.enableTodos !== false &&
    options.readOnly !== true &&
    !gauntletParent &&
    profile === 'full';
  const todoWrite = enableTodos ? withPerm(createTodoWriteTool()) : null;
  const todoRead = enableTodos ? withPerm(createTodoReadTool()) : null;
  if (todoWrite) registry.register(todoWrite);
  if (todoRead) registry.register(todoRead);

  // Durable workspace plan tasks (ADR-0018) - .zelari/plan.json store shared
  // with the council stubs. Full build agent + plan phase only.
  const enablePlanTasks =
    options.enablePlanTasks !== false &&
    options.readOnly !== true &&
    !gauntletParent &&
    (profile === 'full' || options.planMode === true) &&
    profile !== 'explore' &&
    profile !== 'verify' &&
    profile !== 'general';
  const planTaskToolsWrapped = (
    enablePlanTasks
      ? createPlanTaskTools({ projectRoot: root, onTaskEvent: options.onTaskEvent })
      : []
  ).map((t) => withPerm(t));
  for (const t of planTaskToolsWrapped) {
    registry.register(t);
  }

  const summary = [
    safeReadFile,
    safeGrepContent,
    safeListFiles,
    safeShowDiff,
    safeFetchUrl,
    safeWebSearch,
    ...(observeBatchTool ? [observeBatchTool] : []),
    ...(retrieveObservationTool ? [retrieveObservationTool] : []),
    ...(allowMutators ? [safeWriteFile, safeEditFile, safeApplyDiff] : []),
    ...(allowBash ? [safeBash, safeExecProcess] : []),
    ...(askUserTool ? [askUserTool] : []),
    ...(skillTool ? [skillTool] : []),
    ...(todoWrite ? [todoWrite] : []),
    ...(todoRead ? [todoRead] : []),
    ...(planTaskToolsWrapped.length > 0 ? planTaskToolsWrapped : []),
  ];
  const tools: BuiltinToolSummary[] = summary.map((t) => ({
    name: t.name,
    description: t.description,
    permissions: t.permissions ?? [],
  }));

  // inspect_command — allowlisted no-shell inspector (git status/log/diff/
  // show, tsc --noEmit with S3.5 artifact safety) registered exactly where
  // bash is NOT: readOnly subagents, planMode sessions and the explore
  // profile. Full/verify keep the real bash. Kill-switch: ZELARI_INSPECT_COMMAND=0.
  if (readOnly && process.env.ZELARI_INSPECT_COMMAND !== '0') {
    const inspectTool = createInspectCommandTool(root);
    registry.register(withPerm(inspectTool));
    tools.push({
      name: inspectTool.name,
      description: inspectTool.description,
      permissions: inspectTool.permissions ?? [],
    });
  }

  // AST structural tools (ast_outline, find_symbol) — read-only, so available
  // in BOTH the full registry and read-only sub-agents. Gated by ZELARI_AST.
  if (process.env.ZELARI_AST !== '0') {
    for (const t of createAstTools(root)) {
      registry.register(t);
      tools.push({ name: t.name, description: t.description, permissions: t.permissions ?? [] });
    }
  }

  // Semantic code search — read-only, available in both registries. Gated by
  // ZELARI_SEMANTIC. Needs a prior index (/index); the tool self-reports when
  // none exists, so it's always safe to register.
  if (process.env.ZELARI_SEMANTIC !== '0') {
    const semanticTool = createSemanticTool({ root });
    registry.register(semanticTool);
    tools.push({
      name: semanticTool.name,
      description: semanticTool.description,
      permissions: semanticTool.permissions ?? [],
    });
  }

  // Browser verification (browser_check) — full registry only (it drives a
  // real browser). Gated by ZELARI_BROWSER; self-reports install steps when
  // Playwright is absent, so it's safe to register unconditionally.
  if (!readOnly && !gauntletParent && process.env.ZELARI_BROWSER !== '0') {
    const browserTool = createBrowserTool();
    registry.register(browserTool);
    tools.push({
      name: browserTool.name,
      description: browserTool.description,
      permissions: browserTool.permissions ?? [],
    });
  }

  // SSH deploy/monitor tools — full registry only. Gated by ZELARI_SSH=0.
  // Targets from ~/.zelari-code/ssh-targets.json; ssh_run is allowlist-only.
  if (!readOnly && !gauntletParent && process.env.ZELARI_SSH !== '0') {
    for (const t of createSshTools()) {
      registry.register(t);
      tools.push({
        name: t.name,
        description: t.description,
        permissions: t.permissions ?? [],
      });
    }
  }

  // Schema-inspired world model (hypothesis / checks / run_backtest / timeline).
  // Full registry only. Kill switch: ZELARI_SCHEMA_LOOP=0.
  if (!readOnly && !gauntletParent) {
    for (const t of createWorldModelTools()) {
      const safe = wrapWithAudit(t as ToolDefinition<Record<string, unknown>, unknown>, audit, sessionId);
      registry.register(safe);
      tools.push({
        name: t.name,
        description: t.description,
        permissions: t.permissions ?? [],
      });
    }
  }

  // The `task` sub-agent tool — parent full registry only (not explore/verify/general
  // sub-agents). Sub-agents get a profile-specific registry and never nest another
  // `task`. Fase 1 (ADR-0020): PLAN keeps the `task` tool restricted to
  // explore-only (plan-safe) tentacles unless planExploreTask=false; the explore
  // profile is read-only, so PLAN gains parallel research without write/execute reach.
  const enableTask =
    options.enableTask !== false &&
    options.readOnly !== true &&
    !verifyMode &&
    profile === 'full' &&
    (!options.planMode || options.planExploreTask !== false);
  if (enableTask) {
    const taskTool = createTaskTool(
      {
        createSubAgentContext: createKrakenSubAgentContextFactory({
          root,
          audit,
          sessionId,
          // P0.4 capability inheritance: tentacles intersect THIS
          // registry's own policy (permPolicy above) — they can never
          // exceed it.
          parentPolicy: permPolicy,
          ...(options.subAgentProvider ? { provider: options.subAgentProvider } : {}),
          ...(options.subAgentModel ? { model: options.subAgentModel } : {}),
        }),
        ...(options.memoryService ? { memoryService: options.memoryService } : {}),
        ...(options.memoryAutoWrite !== undefined
          ? { memoryAutoWrite: options.memoryAutoWrite }
          : {}),
        ...(options.onTentacleEvent ? { onTentacleEvent: options.onTentacleEvent } : {}),
      },
      options.planMode === true ? { allowedAgents: ['explore'] } : undefined,
    );
    registry.register(withPerm(taskTool));
    tools.push({
      name: taskTool.name,
      description: taskTool.description,
      permissions: taskTool.permissions ?? [],
    });
  }

  // Fase 4 (ADR-0020): `kraken_select` — parent Kraken ONLY. Gated on
  // enableTask (full profile, not read-only, not verifyMode) AND the
  // explicit krakenSelect option, so tentacles/council/zelari never see
  // it. The verifier defaults to the EXACT parent provider/model
  // (subAgentProvider/subAgentModel of this turn/run).
  if (options.krakenSelect === true && enableTask) {
    const selectTool = createKrakenSelectTool({
      loadParentIdentity: async () => {
        const cfg = options.subAgentProvider
          ? await providerConfigFor(options.subAgentProvider as ProviderName)
          : await providerFromEnv();
        if (!cfg) return null;
        return {
          provider: cfg.providerId,
          model: options.subAgentModel || cfg.model,
        };
      },
      loadStream: async (provider) => {
        const cfg = await providerConfigFor(provider as ProviderName);
        return cfg ? buildProviderStream(cfg) : null;
      },
      // Fase 9 (ADR-0020): persisted verifier override (provider.json
      // `krakenVerifier`). undefined = inherit the EXACT parent model.
      loadVerifierOverride: () => getKrakenVerifierOverride(),
    });
    registry.register(withPerm(selectTool));
    tools.push({
      name: selectTool.name,
      description: selectTool.description,
      permissions: selectTool.permissions ?? [],
    });
  }

  // LSP navigation tools (go_to_definition, find_references, hover_type,
  // document_symbols, rename_symbol). Full + plan (read-only) registry,
  // gated by ZELARI_LSP. All five tools are permissions: ['read']
  // (rename_symbol is preview-only), so plan sessions keep the full
  // navigation ladder ast → lsp → grep → read_file.
  // The shared manager degrades into an explicit degraded field in tool
  // results when a server is not installed (EMPTY is never silently faked).
  if (process.env.ZELARI_LSP !== '0' && options.lspProvider !== null) {
    const lspTools = options.lspProvider
      ? createLspTools(options.lspProvider, root)
      : createLspTools(getSharedLspManager(root), root);
    for (const t of lspTools) {
      registry.register(t);
      tools.push({ name: t.name, description: t.description, permissions: t.permissions ?? [] });
    }
  }

  return { registry, tools };
}

/**
 * The 10 harness builtin tool names already bridged into the agents catalog
 * by harnessToolBridge.ts (getHarnessToolDefinitions). Used by
 * {@link getCliToolCatalogEntries} to skip them — re-bridging would duplicate
 * catalog entries (the dedupe-by-name in buildBuiltinRegistry would drop the
 * duplicate anyway, but skipping is cleaner and avoids warn noise).
 */
const HARNESS_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'bash',
  'grep_content',
  'list_files',
  'show_diff',
  'apply_diff',
  'fetch_url',
  'web_search',
]);

/**
 * Derive agents-catalog entries for the CLI-only tools in an executor registry
 * (browser_check, the LSP navigation tools, AST outline, semantic search).
 *
 * The council and zelari paths advertise tools through the static catalog
 * (`getAllTools()` → `getProviderTools()`), not through the executor's
 * `toOpenAITools()` like the main agent does. browser_check / LSP / AST are
 * registered in the executor (so `filterExecutable` keeps their names) but
 * absent from the catalog, so `getProviderTools` silently dropped them — the
 * council's models were never told these tools existed.
 *
 * This bridges that gap: for every tool in `registry` that is NOT one of the
 * 10 harness builtins, derive an `EnhancedToolDefinition` (same JSON Schema
 * the executor uses, guard-stub `execute` since real execution flows through
 * the council's shared ToolRegistry). The CLI then registers these into the
 * catalog via {@link registerCliToolsIntoCouncilCatalog}.
 *
 * Kill-switches are respected at registration time (createBuiltinToolRegistry
 * only registers browser_check when ZELARI_BROWSER !== '0', etc.), so this
 * function simply reflects whatever the executor actually has — no env check
 * needed here.
 *
 * @param registry  The executor registry (typically the council's shared one).
 * @returns Catalog entries for every non-harness-builtin tool present.
 */
export function getCliToolCatalogEntries(registry: ToolRegistry): EnhancedToolDefinition[] {
  const entries: EnhancedToolDefinition[] = [];
  for (const name of registry.list()) {
    if (HARNESS_BUILTIN_NAMES.has(name)) continue;
    const def = registry.get(name);
    if (!def) continue;
    try {
      entries.push(cliToolToEnhanced(def as unknown as ToolDefinition<never, unknown>));
    } catch {
      // A tool whose inputSchema can't be converted to JSON Schema is skipped
      // (matches getProviderTools' own skip-on-no-schema behaviour). Never throw.
    }
  }
  return entries;
}

/**
 * Register the CLI-only tools (browser_check, LSP, AST, semantic) into the
 * shared agents catalog so the council and zelari paths advertise them.
 *
 * Companion to the workspace-stub injection in councilDispatcher.ts: same
 * mechanism (registerCustomTool), same direction (CLI → core), same contract
 * (catalog entries carry schemas; execution flows through the executor).
 *
 * Idempotent in effect: registerCustomTool replaces by name, so re-calling
 * with the same registry is safe. Safe to call with a registry that has only
 * harness builtins (returns without registering anything).
 */
export function registerCliToolsIntoCouncilCatalog(registry: ToolRegistry): void {
  for (const entry of getCliToolCatalogEntries(registry)) {
    try {
      registerCustomTool(entry);
    } catch {
      // registerCustomTool rebuilds an internal index; a failure there must
      // never block the council from booting. Swallow and continue.
    }
  }
}


function taskAgentToProfile(agent: TaskAgentKind): 'explore' | 'verify' | 'general' {
  if (agent === 'general') return 'general';
  if (agent === 'verify') return 'verify';
  return 'explore';
}

/**
 * Build the `TaskToolDeps.createSubAgentContext` closure used by the `task`
 * tool: resolves a cheap/strong sub-model, builds a profile-scoped
 * registry (no nested `task`), and wraps it into a `SubAgentContext`.
 * Exported so other Kraken orchestration entry points — the graph executor
 * (F3) driven from the `/kraken graph` slash handler and headless flag
 * (F6) — can build a `TaskToolDeps` without duplicating this wiring.
 */
export function createKrakenSubAgentContextFactory(opts: {
  root: string;
  audit: AuditLogger;
  sessionId: string;
  /**
   * Explicit provider/model to anchor sub-agents to (e.g. the resolved
   * --provider/--model of a `--kraken-graph` headless run, itself sourced
   * from Desktop's provider/model selector). Without this, every tentacle
   * silently used the persisted `provider.json` `activeProviderId` instead
   * of whatever the caller actually selected — for the graph executor,
   * where ~all real work happens in tentacles, that made the provider
   * picker effectively a no-op. Falls back to `providerFromEnv()`'s
   * persisted default when omitted, preserving the `task` tool's existing
   * behavior exactly (it doesn't pass an override today).
   */
  provider?: string;
  model?: string;
  /**
   * P0.4 capability inheritance: the PARENT agent's permission policy.
   * The sub-agent registry is built with intersectPermissionPolicy(
   * parentPolicy, subProfilePolicy) — deny > ask > allow per category — so
   * a tentacle can NEVER hold more permission than its parent. Callers
   * that have a policy in scope (the parent registry builder, headless
   * runs) pass it here; when omitted the all-allow/auto default is used,
   * which makes the intersection a no-op rather than an escalation.
   */
  parentPolicy?: PermissionPolicy;
}): TaskToolDeps['createSubAgentContext'] {
  const { root, audit, sessionId, provider: providerOverride, model: modelOverride, parentPolicy } = opts;
  return async ({ agent, cwd: subCwd }) => {
    const cfg = providerOverride
      ? await providerConfigFor(providerOverride as ProviderName)
      : await providerFromEnv();
    if (!cfg) return null;
    const { resolveKrakenSubModel, parseQualifiedModelRef } = await import('./tools/krakenModel.js');
    const resolvedModel = resolveKrakenSubModel(agent, modelOverride || cfg.model);
    // Cross-provider tentacles (Desktop Settings → ZELARI_KRAKEN_*_MODEL): a
    // provider-qualified ref ("grok/grok-4") selects both provider and model.
    // Unknown provider → keep the raw id (previous behavior: sent to the lead
    // provider unchanged).
    let effCfg = cfg;
    let model = resolvedModel;
    const ref = parseQualifiedModelRef(resolvedModel);
    if (ref) {
      const cross =
        ref.provider === cfg.providerId
          ? cfg
          : await providerConfigFor(ref.provider as ProviderName);
      if (cross) {
        effCfg = cross;
        model = ref.model;
      }
    }
    const subCfg = { ...effCfg, model };
    const subProfile = taskAgentToProfile(agent);
    const subRoot = subCwd || root;
    // P0.4 capability inheritance: a tentacle NEVER holds more permission
    // than its parent. The sub-profile policy this factory builds is
    // headless-style auto-allow (a tentacle has no interactive prompt to
    // ask at); the effective policy is its intersection with the parent
    // policy — deny > ask > allow per category, `auto` is the AND of both.
    // If the intersection downgrades a category to `ask`, resolution must
    // FAIL CLOSED: the sub-agent context has no interactive ask handler, and
    // `wrapWithPermissions` already returns typedErr for `ask` without
    // `onPermissionAsk`, so that guarantee is reused as-is here (no extra
    // handling needed).
    const agentPolicyForSubProfile = defaultPermissionPolicy({ auto: true });
    const effectiveSubPolicy = intersectPermissionPolicy(
      parentPolicy ?? agentPolicyForSubProfile,
      agentPolicyForSubProfile,
    );
    const { registry: subRegistry } = createBuiltinToolRegistry({
      root: subRoot,
      audit,
      sessionId,
      profile: subProfile,
      enableTask: false,
      enableSkill: agent === 'general',
      diagnostics: false,
      lspProvider: null,
      permissionPolicy: effectiveSubPolicy,
      // P0.5: the tentacle's agent identity drives per-agent policy rules.
      policyAgent: agent,
    });
    return {
      providerStream: buildProviderStream(subCfg),
      model,
      provider: subCfg.providerId,
      registry: subRegistry,
      tools: subRegistry.toOpenAITools().map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
      agent,
      cwd: subRoot,
    };
  };
}

/**
 * Gate tool execution with allow/ask/deny policy (OpenCode-style permissions).
 */
function wrapWithPermissions<I, O>(
  original: ToolDefinition<I, O>,
  policy: PermissionPolicy,
  onAsk?: PermissionAskHandler,
  agentLayers?: LayeredPolicyRuleSet,
  precedence: PolicyPrecedence = 'restrict-only',
  root?: string,
): ToolDefinition<I, O> {
  const required = (original.permissions ?? []) as ToolPermission[];
  // Pure read tools under allow policy — no wrap overhead.
  const decisionProbe = resolveToolPermission(original.name, required, policy);
  if (decisionProbe.action === 'allow' && !required.includes('write') && !required.includes('execute')) {
    // Still wrap write/execute categories; for read-only allow skip? Keep wrap
    // always for consistency when policy might deny network later.
  }
  return {
    ...original,
    execute: async (input: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      const decision = resolveToolPermission(original.name, required, policy);
      // P0.A: resolve this agent's rule across the global+project layers —
      // restrict-only by default (deny > ask > allow; a global deny/ask can
      // never be relaxed by the project file; legacy precedence restores the
      // v1 project-first override). The survivor only ever ADDS restriction
      // to the category decision (mergeRuleEffect).
      const rule = agentLayers
        ? matchAgentPolicyRuleLayered(
            agentLayers,
            precedence,
            required,
            (input ?? {}) as Record<string, unknown>,
            root ?? process.cwd(),
          )
        : null;
      // P0.C1 resource claims: EVERY resource this invocation can touch gets
      // its own layered match and the per-claim effects intersect into the
      // decision (deny > ask > allow) — a multi-path tool can no longer pass
      // because only its first path was checked. No matched claim ⇒
      // undefined ⇒ the category + single-rule decision is untouched.
      const claims = agentLayers
        ? resolveClaimsVerdict(
            agentLayers,
            precedence,
            original.name,
            (input ?? {}) as Record<string, unknown>,
            root ?? process.cwd(),
          )
        : undefined;
      // t22: the active TaskContract's compiled capability layer matches as a
      // THIRD independent source and its effect intersects LAST — a contract
      // deny can never be relaxed and a contract allow can never widen any
      // other layer or the category decision (same deny>ask>allow lattice).
      // No scoped contract ⇒ null ⇒ this slot is inert.
      const contractRule = matchContractCapabilityRule(
        required,
        (input ?? {}) as Record<string, unknown>,
        root ?? process.cwd(),
      );
      const action = intersectEffects(mergeRuleEffect(decision.action, rule), claims?.effect, contractRule?.effect);
      const claimHit =
        claims && claims.effect !== undefined
          ? claims.matchedRules.find((x) => x.effect === claims.effect)
          : undefined;
      const rulePrefix = contractRule
        ? `[contract] rule '${contractRule.match}'${contractRule.reason ? ` — ${contractRule.reason}` : ''}`
        : rule
          ? `[policy] rule '${rule.match}'${rule.reason ? ` — ${rule.reason}` : ''}`
          : claimHit
            ? `[policy] claim '${claimHit.match}'${claimHit.reason ? ` — ${claimHit.reason}` : ''}`
            : '';
      if (action === 'deny') {
        return typedErr(`[permission] ${rulePrefix || decision.reason}`);
      }
      if (action === 'ask') {
        if (!onAsk) {
          return typedErr(
            `[permission] ${rulePrefix ? `${rulePrefix} ` : ''}${decision.reason} No interactive approval available ` +
              `(set ZELARI_AUTO=1 to auto-allow, or configure onPermissionAsk).`,
          );
        }
        try {
          const ok = await onAsk({
            toolName: original.name,
            reason: decision.reason,
            categories: decision.categories,
            args: input,
          });
          if (!ok) {
            return typedErr(
              `[permission] User denied "${original.name}" (${decision.categories.join(', ')}).`,
            );
          }
        } catch (err) {
          return typedErr(
            `[permission] Approval UI failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return original.execute(input, ctx);
    },
  };
}

function wrapWithSandbox<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  pathArgs: readonly string[],
  root: string,
  audit: AuditLogger,
  sessionId: string,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      // Pre-flight: sandbox all path args; rewrite them in-place.
      const args = rawArgs as Record<string, unknown>;
      for (const key of pathArgs) {
        const v = args[key];
        if (typeof v === 'string' && v.length > 0) {
          try {
            args[key] = resolveSandboxedPath(v, { root });
          } catch (err) {
            if (err instanceof SandboxViolationError) {
              // Audit + return typedErr so the caller gets a friendly error.
              await audit.append({
                ts: new Date().toISOString(),
                sessionId,
                tool: original.name,
                args: redactForAudit(args),
                ok: false,
                resultSummary: err.message,
                durationMs: 0,
                error: 'sandbox_violation',
              });
              return {
                ok: false,
                error: `[sandbox] ${err.message}`,
              } as TypedResult<O>;
            }
            throw err;
          }
        }
      }
      // Audit-wrapped execution.
      try {
        return await audit.runTool({
          tool: original.name,
          args: redactForAudit(args),
          sessionId,
          fn: () => original.execute(rawArgs, ctx),
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as TypedResult<O>;
      }
    },
  };
}

/**
 * Wrap an edit tool (write_file / edit_file / apply_diff) with the
 * post-edit diagnostics loop. After a successful, non-dry-run edit, a fast
 * file-scoped checker runs on the touched file (`result.value.path`) and, if
 * it finds anything, a compact diagnostics block is appended to the result
 * value under `diagnostics`. The harness serializes the value into the tool
 * message, so the model sees compiler errors in the same turn and can fix
 * them immediately.
 *
 * Best-effort and non-blocking-by-design: unsupported file types, missing
 * linters, timeouts, and parse failures all yield no diagnostics and leave
 * the original result untouched. Never changes a failed result or a dryRun.
 */
function wrapWithDiagnostics<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  root: string,
  runner?: Runner,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      const result = await original.execute(rawArgs, ctx);
      if (!result.ok) return result;
      // A dry-run edit (apply_diff dryRun) writes nothing — nothing to check.
      if ((rawArgs as Record<string, unknown>).dryRun === true) return result;
      const value = result.value as { path?: unknown } | null;
      const filePath =
        value && typeof value === 'object' && typeof value.path === 'string'
          ? value.path
          : undefined;
      if (!filePath) return result;
      try {
        const timeoutMs = Number(process.env.ZELARI_DIAGNOSTICS_TIMEOUT_MS) || 5000;
        const diags = await runDiagnosticsForFile(filePath, {
          cwd: root,
          timeoutMs,
          ...(runner ? { runner } : {}),
        });
        const formatted = formatDiagnostics(diags, { relativeTo: root });
        if (formatted) {
          return {
            ok: true,
            value: { ...(value as Record<string, unknown>), diagnostics: formatted },
          } as TypedResult<O>;
        }
      } catch {
        // Diagnostics must never break an edit — swallow and return as-is.
      }
      return result;
    },
  };
}

/** Audit-only wrap for tools with no path/shell args (network tools). */
function wrapWithAudit<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  audit: AuditLogger,
  sessionId: string,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      try {
        return await audit.runTool({
          tool: original.name,
          args: redactForAudit(rawArgs as Record<string, unknown>),
          sessionId,
          fn: () => original.execute(rawArgs, ctx),
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as TypedResult<O>;
      }
    },
  };
}

/**
 * P0.C2 (t17) evidence seam for exec_process: blocklist-style guard plus an
 * audit entry whose summary records program + argv + exitCode so executed
 * structured commands survive as verifiable evidence in the audit trail and
 * the session spine (tool events feed Completion Proof evidence refs).
 */
function wrapWithExecEvidence<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  audit: AuditLogger,
  sessionId: string,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      const args = rawArgs as Record<string, unknown>;
      const program = typeof args['program'] === 'string' ? args['program'] : '';
      const argv = Array.isArray(args['args'])
        ? args['args'].filter((x): x is string => typeof x === 'string')
        : [];
      const what = [program, ...argv].join(' ');
      try {
        return await audit.runTool({
          tool: original.name,
          args: redactForAudit(args),
          sessionId,
          summarize: (result) => {
            const r = result as TypedResult<{ exitCode?: number }>;
            const code = r.ok ? r.value.exitCode : undefined;
            return `${what}${code !== undefined ? ` -> exitCode=${code}` : ''}`;
          },
          fn: () => original.execute(rawArgs, ctx),
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as TypedResult<O>;
      }
    },
  };
}

/**
 * Wrap the bash tool: assertShellAllowed() runs before execute(), and
 * every invocation is audited.
 */
function wrapWithShellSafety<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  audit: AuditLogger,
  sessionId: string,
): ToolDefinition<I, O> {
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      const args = rawArgs as Record<string, unknown>;
      const cmd = args['command'];
      if (typeof cmd === 'string') {
        try {
          assertShellAllowed(cmd);
        } catch (err) {
          if (err instanceof ShellBlockedError) {
            await audit.append({
              ts: new Date().toISOString(),
              sessionId,
              tool: original.name,
              args: redactForAudit(args),
              ok: false,
              resultSummary: err.message,
              durationMs: 0,
              error: 'shell_blocked',
            });
            return {
              ok: false,
              error: `[shell-blocked] ${err.message}`,
            } as TypedResult<O>;
          }
          throw err;
        }
      }
      try {
        return await audit.runTool({
          tool: original.name,
          args: redactForAudit(args),
          sessionId,
          fn: () => original.execute(rawArgs, ctx),
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as TypedResult<O>;
      }
    },
  };
}

function redactForAudit(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (/(api[_-]?key|secret|token|password)/i.test(k) && typeof v === 'string') {
      out[k] = '***';
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '…';
    } else {
      out[k] = v;
    }
  }
  return out;
}
