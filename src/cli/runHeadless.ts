/**
 * runHeadless — execute a single task without mounting Ink.
 *
 * Streams BrainEvents either as NDJSON (one JSON object per line on
 * stdout) or as plain text (just the assistant message body).
 *
 * Modes:
 *   - kraken (default): one AgentHarness super-agent run (alias: agent)
 *   - council (`--mode council` / `--council`): 6-member pipeline
 *   - zelari (`--mode zelari`): autonomous multi-run mission
 *
 * Phase (`--phase plan|build`): plan strips mutating project tools.
 *
 * @public
 * @since 0.5.0
 */
import { AgentHarness, type ProviderStreamFn } from '@zelari/core/harness';
import type { AgentMessage, AgentToolSpec } from '@zelari/core/harness';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
import type { MemoryService } from '@zelari/core/memory';
import { cleanAgentContent } from '@zelari/core';
import { createBrainEvent } from '@zelari/core/events';
import {
  buildAgentUserWithHistory,
  buildCouncilTaskWithHistory,
  expectsDiskImplementation,
} from './hooks/conversationContext.js';
import { createBuiltinToolRegistry } from './toolRegistry.js';
import { KrakenTurnRuntime } from './kraken/turnRuntime.js';
import { isKrakenSelectionEnabled, krakenChecksPassed, krakenRequiredChecks, resetKrakenCandidates } from './kraken/candidateRegistry.js';
import { collectKrakenTurnMetrics, markRepairSucceeded, markRepairTriggered, resetKrakenTurnMetrics } from './kraken/metrics.js';
import { buildKrakenRepairPrompt, evaluateKrakenCompletionGate } from './kraken/completionGate.js';
import { krakenSelectionPlaybook } from './kraken/selectionPlaybook.js';
// ADR-0024 v1.1: types for the host-owned per-node spine envelope wrapper.
import type { RunTentacleOptions, TentacleResult } from './kraken/tentacle.js';
import { krakenDelegationPlaybook, resolveDelegationPolicyForRun } from './kraken/delegationPolicy.js';
import { chooseOrchestration } from './orchestration/policy.js';
import { collectOrchestrationFacts, spineOrchestrationNote } from './orchestration/facts.js';
// W2: memory telemetry projected onto the session spine as state-only notes.
import { flushMemorySpineNotes, memorySinkFor, spineMemoryEventNote, type LateBindingSpineHolder, type SpineNoteHandle } from './memory/spineTelemetry.js';
import { COUNCIL_TIER_SIZES } from './councilConfig.js';

import {
  emitEvent,
  resolveHeadlessCwd,
  resolveHeadlessKey,
  resolveHeadlessProvider,
  type HeadlessOptions,
} from './headless.js';
import { createLocalCliProvider } from './provider/localCli/claudeProvider.js';
import {
  buildSystemPromptSplit,
  systemMessagesFromSplit,
  getAllTools,
  KRAKEN_IDENTITY_MODULE,
  KRAKEN_LEAD_PLAYBOOK_MODULE,
  buildLanguagePolicyModuleFor,
} from '@zelari/core/skills';
import { envNumber } from './utils/envNumber.js';
import { setPhase } from './phaseState.js';
import { describePhase } from './phase.js';
import { parseMode } from './mode.js';
import { createStreamScrubber } from './utils/streamScrub.js';
import { resetTaskSpawnCount, resetTaskVerifyObligation } from './tools/taskTool.js';
import { writeSessionTodos } from './sessionTodos.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateStrictBuildGate, strictEnvOverlay, strictGateEventPayload, strictGateExitCode } from './kraken/verificationBridge.js';

import { writeCompletionProofDetailed } from './kraken/completionProof.js';
import {
  enforceRequiredProofPersistence,
  setActiveProofPersistenceSurface,
} from './kraken/completionProofPersist.js';
import { nativePackEnabled } from './kraken/nativeVerification.js';
import { runAdvisoryVerifierReview } from './kraken/verifierLifecycle.js';
import { buildModelContext, resourceStatusTail } from './budget/modelContextBuilder.js';
import { recordCompactionMetrics } from './metrics.js';
import {
  openHeadlessSpine,
  resolveHeadlessProfileId,
  seedHeadlessModelHistory,
  sessionStartedEvent,
  type HeadlessSpineHandle,
} from './headlessSpine.js';
import { RuntimeControlQueue } from '@zelari/core/runtime';
import { attachControlPlane, type ControlPlaneHandle } from './headless/controlBridge.js';
import { protocolInfoEvent } from './headless/protocol.js';
import { emitHarnessStateEvent } from './headless/harnessStateEmit.js';
import {
  checkStrictPolicyLoad,
  recordPolicyLoadBlockedOnSpine,
  reportPolicyLoadBlocked,
} from './headless/policyGate.js';
import {
  activePolicyLoadMode,
  setActivePolicyLoadSurface,
} from './safety/policyLoadMode.js';
import { HOOKS_FAILURE_ENV, resolveHookFailureMode } from './safety/lifecycleHooks.js';
import { planModeFromOpts, registerHeadlessMcp, runOneTurn, writeProofSafe, type TurnExtras } from './headless/runOneTurn.js';

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  resetTaskSpawnCount();
  resetTaskVerifyObligation();
  // H10-fix1: strictDone/missionStrict NEVER touch process.env (not even
  // once-per-process) — each gate site builds a per-invocation overlay via
  // strictEnvOverlay(opts), so `--no-strict-done` (false→'0') is honored
  // and a concurrent sidecar can never race on the real env.

  // === Global crash handlers (headless-only) ===
  // Without these, an uncaught exception during a tool call (e.g. write_file
  // failing deep in the harness) kills the process silently: no agent_end,
  // no run-finished, and the desktop hangs forever waiting for output that
  // never comes. Here we surface the failure as a final NDJSON error event
  // + stderr line, then exit non-zero, so the desktop can show the cause.
  let crashed = false;
  const handleFatal = (label: string, err: unknown) => {
    if (crashed) return; // Re-entrant: log only the first fatal cause.
    crashed = true;
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
    const line = `[zelari-code --headless] FATAL ${label}: ${msg}${stack}`;
    try {
      // Emit a structured error event the desktop renders in the chat.
      emitEvent({
        type: 'error',
        severity: 'fatal',
        message: `${label}: ${msg}`,
        code: 'uncaught',
      });
    } catch {
      // If stdout is already gone, at least try stderr.
    }
    try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
    // Force exit: the default Node behavior would print to stderr and keep
    // an exit code 1, but for unhandledRejection it just warns and continues
    // (which leaves the desktop hanging). We make both fatal + explicit.
    process.exit(2);
  };
  process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
  process.on('unhandledRejection', (err) => handleFatal('unhandledRejection', err));

  // v1.30.0: external-agent permission broker (ZELARI_PERM_SOCKET). Serves
  // `claude --permission-prompt-tool "zelari-code --permission-mcp <socket>"`
  // with a policy-only handler: ZELARI_AUTO=1 auto-allows, otherwise ask
  // resolves to deny (never hangs). Best-effort — a bind failure logs to
  // stderr and the run continues.
  let permBrokerStop: (() => Promise<void>) | null = null;
  const permSocket = process.env.ZELARI_PERM_SOCKET?.trim();
  if (permSocket) {
    try {
      const { startPermissionBroker } = await import('./mcp/permissionBroker.js');
      const { createBrokerPermissionHandler } = await import('./mcp/brokerHandlers.js');
      const h = await startPermissionBroker(permSocket, {
        onPermission: createBrokerPermissionHandler({}),
      });
      permBrokerStop = h.stop;
      process.stderr.write(
        `[zelari-code] permission broker listening on ${permSocket}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[zelari-code] permission broker failed to start: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
  process.once('exit', () => {
    void permBrokerStop?.();
  });

  // P0.B — strict policy-load BEFORE key resolution. A broken policy file
  // must exit 2 (policy-load-failed), never fall through to "no API key"
  // (exit 1). Sidecar turns hit the same gate inside dispatchHeadlessTurn.
  const policyBlock = await applyHeadlessPolicyGate(opts);
  if (policyBlock !== undefined) return policyBlock;

  const { provider: resolvedProvider, model } = resolveHeadlessProvider(opts);
  let provider = resolvedProvider;

  // Local-CLI provider (Slice B): opt-in via ZELARI_LOCAL_CLI=claude|codex|...
  // No API key needed — the CLI is authenticated on its own. Permission
  // prompts flow to the zelari broker via ZELARI_PERM_SOCKET (Slice A).
  const localCli = (process.env.ZELARI_LOCAL_CLI ?? '').trim();
  let providerStream;
  if (localCli) {
    provider = 'local-cli';
    providerStream = createLocalCliProvider({ cli: localCli, model });
  } else {
    const key = await resolveHeadlessKey(provider);
    if ('error' in key) {
      process.stderr.write(`[zelari-code --headless] ${key.error}\n`);
      return 1;
    }
    const { buildProviderStream } = await import('./provider/resolveStream.js');
    providerStream = buildProviderStream({
      providerId: provider as import('./keyStore.js').ProviderName,
      apiKey: key.apiKey,
      baseUrl: key.baseUrl,
      model,
    });
  }

  return dispatchHeadlessTurn(opts, provider, model, providerStream, {
    // H10-fix3: the gate already ran above on the SAME input (no chdir in
    // between) — the one-shot marker keeps dispatchHeadlessTurn from
    // re-running it (duplicate `[policy]` stderr warning + double policy
    // load). Per-invocation flag only; never process-global.
    policyGateDone: true,
  });
}

/** Strict policy-load + phase/proof surfaces. Returns the block exit code, or undefined. */
async function applyHeadlessPolicyGate(opts: HeadlessOptions): Promise<number | undefined> {
  const cwd = resolveHeadlessCwd(opts);
  setPhase(opts.phase ?? 'build');
  setActivePolicyLoadSurface(opts.mode === 'zelari' ? 'mission' : 'headless');
  setActiveProofPersistenceSurface(opts.mode === 'zelari' ? 'mission' : 'headless');
  const policyLoad = checkStrictPolicyLoad(cwd, { mode: activePolicyLoadMode() });
  if (policyLoad.blocked && policyLoad.block) {
    reportPolicyLoadBlocked(policyLoad.block, opts.output);
    await recordPolicyLoadBlockedOnSpine(policyLoad.block, {
      mode: opts.mode,
      // H10-fix2: the spine must land in the RESOLVED workspace, not the
      // process cwd — a sidecar hosts N workspaces without `chdir`.
      workspace: cwd,
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    });
    return policyLoad.block.exitCode;
  }
  for (const w of policyLoad.warnings) {
    process.stderr.write(`[zelari-code --headless] [policy] ${w}\n`);
  }
  return undefined;
}

/**
 * Per-turn dispatch shared by `--headless` (one-shot process) and
 * `--serve-harness` (long-lived sidecar). Does NOT install process-fatal
 * handlers or touch `ZELARI_STRICT_DONE` — the strict knobs ride
 * HeadlessOptions into a per-invocation env overlay (strictEnvOverlay)
 * consumed at each gate site (runOneTurn / runHeadlessZelari). Honors
 * `opts.cwd` so N sidecar sessions can sit on
 * different folders without `chdir`. `oneShot.policyGateDone` is set by
 * the one-shot wrapper ONLY (its gate already ran); the sidecar never
 * passes it, so the gate keeps running every turn here.
 */
const KRAKEN_TURN_ENV: Array<[keyof HeadlessOptions, string]> = [
  ['krakenExploreModel', 'ZELARI_KRAKEN_EXPLORE_MODEL'],
  ['krakenGeneralModel', 'ZELARI_KRAKEN_GENERAL_MODEL'],
  ['krakenVerifyModel', 'ZELARI_KRAKEN_VERIFY_MODEL'],
  ['krakenPlannerModel', 'ZELARI_KRAKEN_PLANNER_MODEL'],
  ['krakenDelegation', 'ZELARI_KRAKEN_DELEGATION'],
];

function applyKrakenTurnEnv(opts: HeadlessOptions): void {
  for (const [field, envKey] of KRAKEN_TURN_ENV) {
    const raw = opts[field];
    if (typeof raw === 'string' && raw.trim()) {
      process.env[envKey] = raw.trim();
    }
  }
}

export async function dispatchHeadlessTurn(
  opts: HeadlessOptions,
  provider: string,
  model: string,
  providerStream: ProviderStreamFn,
  oneShot?: { policyGateDone?: boolean },
  // t37: serve hosts pass the kernel-owned workspace LspManager here so
  // every dispatch path (kraken single / council / zelari) registers the
  // LSP tools against THAT server instead of the shared per-root manager.
  extras?: TurnExtras,
): Promise<number> {
  const cwd = resolveHeadlessCwd(opts);
  if (typeof opts.mode === 'string') {
    const parsed = parseMode(opts.mode);
    opts = { ...opts, cwd, ...(parsed ? { mode: parsed } : {}) };
  } else {
    opts = { ...opts, cwd };
  }
  applyKrakenTurnEnv(opts);
  // Each parent user turn gets a fresh tentacle budget (GUIDA: default 6).
  // Desktop sidecar never enters runHeadless(), so without this the counter
  // lives for the whole Node process — 6 tentacles total, then spawn cap.
  resetTaskSpawnCount();
  // t78: the general⇒verify obligation is per-turn too — a turn that ends
  // with open debt is closed blocked by the strict-done gate in runOneTurn.
  resetTaskVerifyObligation();

  if (opts.todos && opts.todos.length > 0) {
    writeSessionTodos(opts.todos, { merge: false });
  }

  try {
    const { expandAtMentions } = await import('./atMentions.js');
    const task = typeof opts.task === 'string' ? opts.task : '';
    if (task.includes('@')) {
      const { text, hits } = expandAtMentions(task, cwd);
      if (text !== task) {
        opts = { ...opts, task: text };
      }
      const images = hits.filter((h) => h.image).map((h) => h.image!);
      if (images.length > 0) {
        opts = { ...opts, images };
      }
    }
  } catch {
    /* non-fatal */
  }

  // H10-fix3: the sidecar (serve/harnessServer) needs this gate EVERY turn —
  // it also re-pins setPhase/setActivePolicyLoadSurface/setActiveProof-
  // PersistenceSurface per turn. The one-shot wrapper passes
  // `policyGateDone` because runHeadless() already ran the identical gate
  // moments ago; re-running it would emit the same `[policy]` warning twice
  // and reload the policy set for nothing.
  if (!oneShot?.policyGateDone) {
    const policyBlock = await applyHeadlessPolicyGate(opts);
    if (policyBlock !== undefined) return policyBlock;
  }

  // P1.1 (t12) -> t23 (P1.E): `--mode auto` resolves ONCE here, before any
  // dispatch check. Pure classifier (./orchestration/policy.js); the only
  // I/O is the CHEAP FACTS collection (bounded repo walk + active-contract
  // seam read). The parser pins mode to the ordinary default ('kraken'), so
  // when the flag is absent this block never runs and behavior stays
  // byte-identical. V2 wiring: strategy maps onto mode (council => council
  // pipeline), a REAL delegation policy (replacing the no-op injection),
  // and the orchestration_decision spine telemetry note emitted by hosts.
  if (opts.orchestrationAuto) {
    const facts = await collectOrchestrationFacts(cwd);
    const verdict = chooseOrchestration(opts.task ?? '', facts);
    opts = { ...opts, orchestrationDecision: verdict };
    const line = `[orchestration] --mode auto -> surface=${verdict.surface} strategy=${verdict.strategy} confidence=${verdict.confidence} latency~${verdict.estimatedLatencyMs}ms (${verdict.rationaleCode})`;
    if (opts.output === 'json') emitEvent({ type: 'log', message: line });
    else process.stderr.write(`[zelari-code --headless] ${line}
`);
  }

  let mode = opts.mode ?? (opts.useCouncil ? 'council' : 'kraken');
  // t23 mapping v1: council is the ONLY strategy that changes dispatch mode
  // (lead-only|explore and lead+verify|parallel-build|graph all ride the
  // single-harness path — the delegation policy differentiates them).
  if (opts.orchestrationDecision?.strategy === 'council') {
    mode = 'council';
  }
  const profileId = resolveHeadlessProfileId(mode, opts.profile);

  if (opts.output === 'json') {
    emitEvent({
      type: 'log',
      message: `[headless] mode=${mode} phase=${opts.phase ?? 'build'} profile=${profileId} provider=${provider} model=${model}`,
    });
  } else {
    process.stderr.write(
      `[zelari-code --headless] mode=${mode} phase=${describePhase(opts.phase ?? 'build')} profile=${profileId}
`,
    );
  }

  if (opts.krakenGraph) {
    return runHeadlessKrakenGraph(opts, provider, model);
  }

  const { shouldRunGauntletHostLoop } = await import('./gauntlet/policy.js');
  if (shouldRunGauntletHostLoop(opts)) {
    const { runHeadlessGauntlet } = await import('./gauntlet/run.js');
    return runHeadlessGauntlet(opts, provider, model);
  }
  if (opts.gauntlet) {
    const why = opts.krakenGraph
      ? 'kraken-graph owns dispatch'
      : (opts.phase ?? 'build') === 'plan'
        ? 'PLAN is already write-stripped; host loop is BUILD-only'
        : 'mode is not kraken-build';
    const line = `[gauntlet] flag set but host loop skipped (${why})`;
    if (opts.output === 'json') emitEvent({ type: 'log', message: line });
    else process.stderr.write(`[zelari-code --headless] ${line}\n`);
  }

  if (mode === 'zelari') {
    return runHeadlessZelari(opts, provider, model, providerStream, extras);
  }
  if (mode === 'council' || opts.useCouncil) {
    return runHeadlessCouncil(opts, provider, model, providerStream, extras);
  }
  return runOneTurn(opts, provider, model, providerStream, extras);
}

/**
 * `--kraken-graph <goal>`: plan (F4) + execute (F3) a Kraken task graph,
 * bypassing the normal single-agent/council/zelari dispatch entirely.
 * Gated by ZELARI_KRAKEN_GRAPH (kill-switch, default on).
 */
async function runHeadlessKrakenGraph(
  opts: HeadlessOptions,
  provider: string,
  model: string,
): Promise<number> {
  const { isKrakenGraphEnabled, KrakenGraphExecutor } = await import('./kraken/executor.js');
  if (!isKrakenGraphEnabled()) {
    process.stderr.write('[zelari-code --headless] ZELARI_KRAKEN_GRAPH=0 — graph engine disabled\n');
    return 1;
  }

  const prompt = (opts.krakenGraph ?? '').trim();
  if (!prompt) {
    process.stderr.write('[zelari-code --headless] --kraken-graph requires a non-empty goal\n');
    return 1;
  }

  const { planTaskGraph } = await import('./kraken/planner.js');
  const { loadGraphSnapshot, formatSnapshotForPlanner } = await import('./kraken/graphMemory.js');
  const { formatKrakenGraphAscii, formatKrakenGraphDigest } = await import(
    './kraken/graphStatus.js'
  );
  const { AuditLogger } = await import('./safety/auditLogger.js');
  const { createKrakenSubAgentContextFactory } = await import('./toolRegistry.js');

  const cwd = resolveHeadlessCwd(opts);
  const sessionId = crypto.randomUUID();
  // W1: kraken-graph was the only headless dispatch path with no ADR-0016
  // session spine — hosts had no event log to resume or replay. Mirror the
  // council/zelari hosts: same open shape, same degrade-and-stop discipline.
  const spine = await openHeadlessSpine({ sessionId, mode: 'kraken', workspace: cwd });
  // E1.4: advertise the spine session id so hosts (Desktop) resume the same
  // event log next turn. Gated to json output — plain stdout must stay
  // byte-for-byte identical to the pre-spine behavior.
  if (opts.output === 'json') emitEvent(sessionStartedEvent(spine));
  spine.userMessage(prompt);
  const { getMemoryService, isMemoryAutoWriteEnabled, isMemoryV2Enabled } =
    await import('./memory/serviceFactory.js');
  const graphMemory = isMemoryV2Enabled()
    ? await getMemoryService(cwd, process.env, {
        // W2: the spine is already open here — memory events are noted
        // directly (context.projection / memory_event state-only payloads).
        onEvent: (event) => spineMemoryEventNote(spine, event),
      })
    : undefined;
  const log = (message: string): void => {
    if (opts.output === 'json') {
      emitEvent({ type: 'log', message });
    } else {
      process.stderr.write(`[zelari-code --headless] ${message}\n`);
    }
  };

  // Ctrl-C used to SIGKILL the process mid-graph, leaving tentacles' worktrees
  // and half-written files behind with no summary. The first SIGINT now asks
  // the executor to stop: tentacles are cancelled, the graph settles, and the
  // digest still prints. `once` means a second Ctrl-C falls through to Node's
  // default handler and hard-exits, which is the right escape hatch.
  const abort = new AbortController();
  const onSigint = (): void => {
    log('SIGINT — cancelling the graph; press Ctrl-C again to force quit');
    abort.abort();
  };
  process.once('SIGINT', onSigint);

  // W1: every return below records its code first so the finally can close
  // the spine with the matching status (completed / error / cancelled).
  let exitCode = 0;

  try {
    // ---- Pre-flight: run a pre-built plan from disk, skipping the planner.
    let preflightGraph: import('@zelari/core').TaskGraph | undefined;
    if (opts.runPlan && opts.runPlan.trim() !== '') {
      const planPath = path.join(cwd, '.zelari', 'radio', `plan-${opts.runPlan}.json`);
      log(`loading pre-flight plan: ${planPath}`);
      let raw: string;
      try {
        raw = await fs.readFile(planPath, 'utf8');
      } catch (e) {
        log(`plan file not found: ${planPath} (${(e as Error).message})`);
        exitCode = 1;
        return exitCode;
      }
      let planJson: { graphId?: string; nodes?: unknown[] };
      try {
        planJson = JSON.parse(raw);
      } catch (e) {
        log(`plan file is malformed JSON: ${(e as Error).message}`);
        exitCode = 1;
        return exitCode;
      }
      if (!planJson || !Array.isArray(planJson.nodes)) {
        log(`plan file is malformed: missing "nodes" array`);
        exitCode = 1;
        return exitCode;
      }
      const { createGraph, validateGraph } = await import('@zelari/core');
      const validated = createGraph(planJson.graphId ?? opts.runPlan, planJson.nodes as never);
      validateGraph(validated);
      preflightGraph = validated;
      log(`pre-flight plan loaded (${validated.nodes.size} nodes); executing`);
    }

    // ---- Normal flow: plan, then optionally execute.
    log(`planning kraken graph: ${prompt}`);
    // Resume context: if the last graph in this project stopped short, tell
    // the planner what already exists and what still needs doing, so a
    // follow-up ("continua") plans the remainder instead of starting over.
    const previous = await loadGraphSnapshot(cwd);
    const previousAttempt = formatSnapshotForPlanner(previous);
    if (previousAttempt) log('resuming from the previous unfinished graph');
    const graph =
      preflightGraph ??
      (await planTaskGraph({
        prompt,
        provider,
        model,
        cwd,
        ...(previousAttempt ? { previousAttempt } : {}),
      }));
    log(formatKrakenGraphAscii(graph));

    // ---- Plan-only mode: serialize and exit before executing.
    if (opts.planOnly) {
      const planId = randomUUID();
      const planDir = path.join(cwd, '.zelari', 'radio');
      const planPath = path.join(planDir, `plan-${planId}.json`);
      await fs.mkdir(planDir, { recursive: true });
      await fs.writeFile(
        planPath,
        JSON.stringify(
          { id: graph.id, nodes: [...graph.nodes.values()] },
          null,
          2,
        ),
        'utf8',
      );
      log(`plan-only: wrote ${planPath} (${graph.nodes.size} nodes)`);
      log(
        `re-run with ZELARI_KRAKEN_RUN_PLAN=${planId} to execute (or --run-plan <id> when the desktop wiring is in place)`,
      );
      if (opts.output === 'json') {
        emitEvent({ type: 'log', message: `plan_only_id=${planId}` });
        emitEvent({ type: 'log', message: `plan_only_path=${planPath}` });
      }
      exitCode = 0;
      return exitCode;
    }

    const audit = new AuditLogger();
    // ADR-0024 v1.1: per-node ENVELOPE events on the spine — written HERE, by
    // the host (the sole spine writer), around the executor's tentacle-run
    // seam. Tentacles/subagents never touch the spine: their turn internals
    // (assistant text, tool calls/results) stay on the kraken radio JSONL.
    // Envelope/metadata only — nodeId, agent, graphId, ok/cancelled and
    // host-measured durationMs; never label/prompt/result (model content).
    // One pair per ATTEMPT (a retry/rework produces a fresh pair); merge
    // nodes drive no tentacle, so they stay radio-only. Additive state kinds
    // need no SCHEMA_VERSION bump: older readers skip them via the tolerant
    // replay (ADR-0021 schema review recorded in the ADR amendment).
    const { runTentacle } = await import('./kraken/tentacle.js');
    const executor = new KrakenGraphExecutor({
      taskToolDeps: {
        createSubAgentContext: createKrakenSubAgentContextFactory({
          root: cwd,
          audit,
          sessionId,
          // P0.4 capability inheritance: tentacles intersect the headless
          // parent policy. Headless runs are auto-allow (the same literal
          // the main headless registry below uses), so this is a no-op
          // today — wired for correctness if that default ever tightens.
          parentPolicy: {
            read: 'allow',
            write: 'allow',
            execute: 'allow',
            network: 'allow',
            ui: 'allow',
            auto: true,
          },
          // Anchor every tentacle to the SAME provider/model this run
          // resolved (Desktop's selector, or --provider/--model), instead
          // of the persisted provider.json default the factory falls back
          // to otherwise — the graph executor is ~all tentacles, so without
          // this the provider picker silently did nothing for Kraken Graph.
          provider,
          model,
        }),
        ...(graphMemory ? { memoryService: graphMemory } : {}),
        memoryAutoWrite: isMemoryAutoWriteEnabled(),
      },
      parentCwd: cwd,
      sessionId,
      goal: prompt,
      signal: abort.signal,
      // ADR-0024 v1.1: same delegate (`runTentacle`), wrapped so each node
      // turn leaves a graph.node_started / graph.node_ended envelope pair on
      // the spine. The executor owns scheduling; the HOST owns the spine.
      runTentacleFn: (runOpts) => nodeSpineEnvelopeRun(spine, runOpts, () => runTentacle(runOpts)),
    });
    const summary = await executor.execute(graph);
    if (summary.cancelled) log('graph cancelled — partial results below');
    // Topology answers "did it converge"; the digest answers "what did the
    // eight tentacles actually do", which otherwise meant reading the radio
    // JSONL by hand.
    const finalAscii = `${formatKrakenGraphAscii(summary.graph)}\n\n${formatKrakenGraphDigest(
      summary.graph,
      {
        durationsMs: summary.durationsMs,
        unresolvedFindings: summary.unresolvedFindings,
      },
    )}`;

    if (opts.output === 'json') {
      // Desktop's chat transcript is built ONLY from a message_start ->
      // message_delta -> message_end/agent_end sequence (assistantIdRef is
      // set on message_start; agent_end never reads a `message` field on
      // its own — see apps/desktop/src/App.tsx's onAgentEvent handler).
      // Emitting bare log/agent_end events (the previous behavior) left the
      // result completely invisible in the UI even though the graph ran
      // and converged/failed correctly — it just looked like nothing
      // happened. Match the same event shape every other dispatch path
      // produces so this renders as a normal assistant reply.
      emitEvent({ type: 'message_start' });
      emitEvent({ type: 'message_delta', delta: finalAscii });
      emitEvent({ type: 'message_end' });
      emitEvent({ type: 'agent_end', reason: summary.converged ? 'completed' : 'error' });
    } else {
      process.stdout.write(`${finalAscii}\n`);
    }

    exitCode = summary.converged ? 0 : 3;
    return exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.output === 'json') {
      emitEvent({ type: 'error', severity: 'fatal', message, code: 'kraken_graph' });
    } else {
      process.stderr.write(`[zelari-code --headless] kraken graph failed: ${message}\n`);
    }
    exitCode = 2;
    return exitCode;
  } finally {
    process.off('SIGINT', onSigint);
    await graphMemory?.close().catch(() => undefined);
    // W1: the spine closes on EVERY exit (completed / error / cancelled) and
    // must never change the exit code.
    try {
      const closeReason = abort.signal.aborted
        ? 'cancelled'
        : exitCode === 0
          ? 'completed'
          : 'error';
      await spine.close(closeReason);
    } catch { /* spine never fails the run */ }
    // Evolution ledger v0 (ADR-0036): shadow-mode outcome telemetry only.
    try {
      const { appendLedgerEntry, evolutionMode } = await import('./evolution/ledger.js');
      const { classifyTask } = await import('./evolution/classifyTask.js');
      if (evolutionMode() === 'shadow') {
        appendLedgerEntry(cwd, {
          runId: spine.sessionId,
          at: new Date().toISOString(),
          mode: 'shadow',
          taskClass: classifyTask({ prompt: opts.task ?? '' }).taskClass,
          verdict: exitCode === 0 ? 'PASS' : exitCode === 3 ? 'FAIL' : 'UNKNOWN',
        });
      }
    } catch { /* ledger never fails the run (ADR-0036) */ }
    // HarnessState inc.3: final read-model event for JSON hosts (best-effort).
    await emitHarnessStateEvent({ spine, workspaceRoot: cwd, output: opts.output, emitEvent });
  }
}

/**
 * ADR-0024 v1.1: wrap one tentacle run with a host-written spine ENVELOPE
 * pair — `graph.node_started` before, `graph.node_ended` after (ok/cancelled
 * + host-measured durationMs; a thrown run ends `ok:false`). Metadata only:
 * no node label, no prompt, no assistant/tool output ever reaches the spine.
 * Runs without a nodeId (none today) are passed through un-noted. Failures
 * of the note path never affect the run — `appendEvent` is degrade-and-stop
 * on the mirror side; the rethrow below preserves the executor's contract.
 */
function nodeSpineEnvelopeRun(
  spine: HeadlessSpineHandle,
  runOpts: RunTentacleOptions,
  run: () => Promise<TentacleResult>,
): Promise<TentacleResult> {
  const startedAt = Date.now();
  const noteNode = (
    kind: 'graph.node_started' | 'graph.node_ended',
    extra?: Record<string, unknown>,
  ): void => {
    if (!runOpts.nodeId) return;
    void spine.appendEvent({
      kind,
      actor: { type: 'system' },
      data: {
        nodeId: runOpts.nodeId,
        agent: runOpts.agent,
        ...(runOpts.graphId ? { graphId: runOpts.graphId } : {}),
        ...extra,
      },
    });
  };
  noteNode('graph.node_started');
  return run().then(
    (res) => {
      noteNode('graph.node_ended', {
        ok: res.ok,
        ...(!res.ok && res.cancelled ? { cancelled: true } : {}),
        durationMs: Date.now() - startedAt,
      });
      return res;
    },
    (err) => {
      noteNode('graph.node_ended', { ok: false, durationMs: Date.now() - startedAt });
      throw err;
    },
  );
}
async function buildCouncilToolRegistry(
  planMode: boolean,
  opts?: HeadlessOptions,
  memoryService?: MemoryService,
  memoryAutoWrite = false,
  // t37: the council/zelari parent registry honors the same TurnExtras as
  // the single-agent path. TODO(t37): the deeper council mission-slice
  // per-agent registries (~runAgentMissionSlice below) still resolve via
  // the shared per-root map — same anti-thrash behavior (one manager per
  // root, no cross-workspace kills), just not the kernel-owned instance.
  extras?: TurnExtras,
) {
  const cwd = opts ? resolveHeadlessCwd(opts) : process.cwd();
  const { registry: toolRegistry } = createBuiltinToolRegistry({
    root: cwd,
    planMode,
    ...(extras?.lspProvider ? { lspProvider: extras.lspProvider } : {}),
    permissionPolicy: {
      read: 'allow',
      write: 'allow',
      execute: 'allow',
      network: 'allow',
      ui: 'allow',
      auto: true,
    },
    ...(memoryService ? { memoryService } : {}),
    memoryAutoWrite,
  });
  const { createWorkspaceContext, createWorkspaceStubs } = await import('./workspace/stubs.js');
  const { createWorkspaceToolRegistry } = await import('./workspace/toolRegistry.js');
  const { setWorkspaceStubs } = await import('@zelari/core/skills');

  const realCtx = createWorkspaceContext(cwd);
  const realReg = createWorkspaceToolRegistry(realCtx);
  for (const name of realReg.list()) {
    const td = realReg.get(name);
    if (td) toolRegistry.register(td);
  }
  setWorkspaceStubs(createWorkspaceStubs(realCtx));
  if (opts) {
    await registerHeadlessMcp(toolRegistry, opts);
  }
  return { toolRegistry, workspaceCtx: realCtx };
}

async function runHeadlessCouncil(
  opts: HeadlessOptions,
  provider: string,
  model: string,
  providerStream: ProviderStreamFn,
  extras?: TurnExtras,
): Promise<number> {
  const { dispatchCouncil } = await import('./councilDispatcher.js');
  const sessionId = crypto.randomUUID();
  const cwd = resolveHeadlessCwd(opts);
  const memoryFactory = await import('./memory/serviceFactory.js');
  // W2: memory events project onto the session spine (late-binding holder —
  // the spine opens below; pre-bind events are buffered (cap 32) and
  // drained on bind — overflow counts in droppedEvents, advisory only).
  const spineHolder: LateBindingSpineHolder = {};
  const nativeMemory = memoryFactory.isMemoryV2Enabled()
    ? await memoryFactory.getMemoryService(cwd, process.env, {
        onEvent: memorySinkFor(spineHolder),
      })
    : undefined;
  const memoryAutoWrite = memoryFactory.isMemoryAutoWriteEnabled();

  const spine = await openHeadlessSpine({
    sessionId: opts.resumeSessionId ?? sessionId,
    mode: opts.mode,
    profile: opts.profile,
    workspace: cwd,
  });
  // W2: bind the memory telemetry sink to the now-open spine.
  spineHolder.current = spine;
  // T4-S3: drain pre-bind buffered memory events (cap 32) onto the spine.
  flushMemorySpineNotes(spineHolder);
  // Exit-1/E1.2: the session spine is the model-context source of truth.
  // Legacy `--history` is imported one-shot into a fresh log; prior turns
  // are then derived from events. The 1.x rolling history no longer feeds
  // the harness messages directly (degraded spine falls back to it).
  const seededHistory = await seedHeadlessModelHistory(spine, opts.history);
  // E1.4: advertise the spine session id so hosts (Desktop) resume the
  // same event log next turn instead of replaying 1.x history JSON.
  emitEvent(sessionStartedEvent(spine));

  // t23 telemetry: same spine note on the council host (--mode auto can
  // route here when the design-conflict trigger fires).
  if (opts.orchestrationDecision) {
    spineOrchestrationNote(spine, opts.orchestrationDecision);
  }

  // Experiment: free-form council+build soft-gated to design-phase unless
  // ZELARI_COUNCIL_CAN_BUILD=1. Also strip project mutators (planMode tools).
  const { shouldAllowCouncilBuild } = await import('./buildPolicy.js');
  let councilRunMode: 'design-phase' | 'implementation' = planModeFromOpts(opts)
    ? 'design-phase'
    : 'implementation';
  let softGated = false;
  if (councilRunMode === 'implementation' && !shouldAllowCouncilBuild()) {
    councilRunMode = 'design-phase';
    softGated = true;
    process.stderr.write(
      '[zelari-code --headless] council build soft-gate: forced design-phase ' +
        '(set ZELARI_COUNCIL_CAN_BUILD=1 to allow Lucifero implement)\n',
    );
  }
  const { toolRegistry } = await buildCouncilToolRegistry(
    planModeFromOpts(opts) || softGated,
    opts,
    nativeMemory,
    memoryAutoWrite,
    extras,
  );
  const { FeedbackStore } = await import('./councilFeedback.js');
  const feedbackStore = new FeedbackStore();

  // Multi-turn: Desktop passes --history, but council used to ignore it →
  // "procedi" looked like a brand-new empty request. Inject prior transcript
  // into the user task (2.1 T9: the history_snapshot emission is gone; the
  // spine carries the transcript).
  // Exit-1/E1.2: spine-derived prior turns (legacy --history is the
  // one-shot import source, not the model-context brain).
  const contextTools: AgentToolSpec[] = toolRegistry.toOpenAITools().map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters as Record<string, unknown>,
  }));
  await spine.beginResourceTurn();
  const councilContext = await buildModelContext({
    fallbackHistory: seededHistory.history,
    session: spine.spine,
    phase: councilRunMode === 'design-phase' ? 'plan' : 'build',
    model,
    provider,
    tools: contextTools,
    sessionId: spine.sessionId,
    providerStream,
    // T4-S2: budget occupancy/policy onto the spine (context.projection note).
    budgetNoteHandle: spine,
    onCompactionMetric: (metrics) => recordCompactionMetrics(spine.sessionId, provider, model, metrics),
    persistCompaction: async (payload) => {
      await spine.appendEvent({
        kind: 'session.compacted',
        actor: { type: 'system' },
        data: { ...payload },
      });
    },
  });
  const historySeed: AgentMessage[] = councilContext.history;
  for (const warning of councilContext.budget.warnings) {
    if (opts.output === 'json') emitEvent({ type: 'log', message: warning });
    else process.stderr.write('[zelari-code --headless] ' + warning + '\n');
  }
  const effectiveTask = buildCouncilTaskWithHistory(opts.task, historySeed);
  if (opts.task) spine.userMessage(effectiveTask);

  let exitCode = 0;
  const scrub = createStreamScrubber();
  /** Last finished assistant blob this run (chairman / specialist). */
  let lastAssistantText = '';
  let currentAssistantText = '';
  try {
    const { composeProjectContext } = await import('./workspace/composeContext.js');
    const { loadDurableContext } = await import('./state/loadDurableContext.js');
    const durableState = await loadDurableContext(cwd);
    // Budget-aware retrieval (T4 follow-up): occupancy comes from the
    // canonical budget pipeline (councilContext) built right above.
    const { resolveRetrievalPolicy } = await import('./budget/retrievalPolicy.js');
    const retrieval = resolveRetrievalPolicy(councilContext.budget.occupancy);
    const memoryContext = nativeMemory
      ? (await nativeMemory.buildContext({
          text: effectiveTask,
          useGraph: true,
          maxChars: retrieval.maxChars,
          maxMemories: retrieval.maxMemories,
          ...(retrieval.weights ? { weights: retrieval.weights } : {}),
        })).text
      : '';
    const composed = composeProjectContext({
      mode: 'council',
      cwd,
      userMessage: opts.task,
      includeLessons: true,
      memoryHits: memoryContext || undefined,
      durableState: durableState || undefined,
      includeDurableState: false,
    });
    for await (const event of dispatchCouncil(effectiveTask, {
      apiKey: 'REDACTED',
      model,
      provider: 'openai-compatible',
      providerStream,
      sessionId,
      workspaceRoot: cwd,
      tools: toolRegistry,
      feedbackStore,
      runMode: councilRunMode,
      // t23: an auto-SELECTED council runs the LITE tier (3 members) unless
      // ZELARI_COUNCIL_TIER / ZELARI_COUNCIL_SIZE explicitly opt into full.
      ...(opts.orchestrationDecision?.strategy === 'council' &&
        process.env['ZELARI_COUNCIL_TIER'] === undefined &&
        process.env['ZELARI_COUNCIL_SIZE'] === undefined
        ? { councilSize: COUNCIL_TIER_SIZES.lite }
        : {}),
      workspaceContext: composed.workspaceContext,
      ...(composed.ragContext ? { ragContext: composed.ragContext } : {}),
      maxToolLoopIterations: envNumber(process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS, {
        default: 60,
        min: 1,
      }),
      ...(() => {
        const hard = envNumber(process.env.ZELARI_MAX_TOOL_LOOP_HARD, {
          default: 0,
          min: 0,
        });
        return hard > 0 ? { maxToolLoopHardCap: hard } : {};
      })(),
    })) {
      if (event.type === 'message_start') {
        scrub.reset();
        currentAssistantText = '';
      }
      spine.observe(event);
      if (event.type === 'message_delta' && typeof event.delta === 'string') {
        const cleanDelta = scrub.push(event.delta);
        if (cleanDelta.length > 0) currentAssistantText += cleanDelta;
        if (opts.output === 'json') {
          if (cleanDelta.length > 0) emitEvent({ ...event, delta: cleanDelta });
        } else if (opts.output === 'plain' && cleanDelta.length > 0) {
          process.stdout.write(cleanDelta);
        }
      } else {
        if (opts.output === 'json') emitEvent(event);
        if (event.type === 'message_end' || event.type === 'agent_end') {
          const tail = scrub.flush();
          if (tail.length > 0) {
            currentAssistantText += tail;
            if (opts.output === 'plain') process.stdout.write(tail);
          }
          if (currentAssistantText.trim()) {
            lastAssistantText = currentAssistantText.trim();
          }
          if (event.type === 'agent_end' && event.reason === 'error') {
            exitCode = 3;
          }
        } else if (event.type === 'error' && event.severity === 'fatal') {
          exitCode = 2;
        }
      }
    }
  } catch (err) {
    process.stderr.write(
      `[zelari-code --headless] council error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await nativeMemory?.close().catch(() => undefined);
    return 2;
  }

  // Desktop multi-turn: append this turn so the next "procedi" has context.
  try {
    await spine.close(exitCode === 0 ? 'completed' : 'error');
  } catch { /* spine never fails the run */ }
  // Evolution ledger v0 (ADR-0036): shadow-mode outcome telemetry only.
  // Best-effort and fail-open — the ledger must never change the outcome.
  try {
    const { appendLedgerEntry, evolutionMode } = await import('./evolution/ledger.js');
    const { classifyTask } = await import('./evolution/classifyTask.js');
    if (evolutionMode() === 'shadow') {
      appendLedgerEntry(cwd, {
        runId: spine.sessionId,
        at: new Date().toISOString(),
        mode: 'shadow',
        taskClass: classifyTask({ prompt: effectiveTask }).taskClass,
        verdict: exitCode === 0 ? 'PASS' : exitCode === 3 ? 'FAIL' : 'UNKNOWN',
      });
    }
  } catch { /* ledger never fails the run (ADR-0036) */ }
  // HarnessState inc.3: final read-model event for JSON hosts (best-effort).
  await emitHarnessStateEvent({ spine, workspaceRoot: cwd, output: opts.output, emitEvent });
  if (opts.exportSessionPath) {
    try {
      const json = await spine.exportJson();
      if (json) {
        if (opts.exportSessionPath === '-') process.stdout.write(json + '\n');
        else {
          await fs.mkdir(path.dirname(opts.exportSessionPath), { recursive: true }).catch(() => undefined);
          await fs.writeFile(opts.exportSessionPath, json, 'utf8');
        }
      }
    } catch { /* export is best-effort */ }
  }
  if (nativeMemory && memoryAutoWrite && lastAssistantText) {
    try {
      await nativeMemory.remember({
        kind: councilRunMode === 'design-phase' ? 'decision' : 'outcome',
        content: lastAssistantText.slice(0, 12_000),
        importance: councilRunMode === 'design-phase' ? 0.8 : 0.75,
        confidence: exitCode === 0 ? 0.78 : 0.45,
        source: { agent: 'council-headless', sessionId: spine.sessionId },
        tags: ['council', 'headless', `run-mode:${councilRunMode}`],
        metadata: {
          objective: opts.task.slice(0, 2_000),
          exitCode,
          writeClass: exitCode === 0 ? 'auto' : 'candidate',
        },
        writeClass: exitCode === 0 ? 'auto' : 'candidate',
      });
      await nativeMemory.consolidate({
        source: { agent: 'council-headless', sessionId: spine.sessionId },
        minOccurrences: 2,
      });
    } catch {
      // Memory is not part of the council completion gate.
    }
  }
  await nativeMemory?.close().catch(() => undefined);
  return exitCode;
}

/**
 * Zelari mission loop (headless). Streams progress as `log` events + council BrainEvents.
 */
async function runHeadlessZelari(
  opts: HeadlessOptions,
  provider: string,
  model: string,
  providerStream: ProviderStreamFn,
  extras?: TurnExtras,
): Promise<number> {
  const projectRoot = resolveHeadlessCwd(opts);

  const sessionId = opts.resumeSessionId ?? crypto.randomUUID();
  const spine = await openHeadlessSpine({
    sessionId,
    mode: 'zelari',
    profile: opts.profile ?? 'mission/v1',
    workspace: projectRoot,
  });
  // Exit-1/E1.2: the session spine is the model-context source of truth.
  // Legacy `--history` is imported one-shot into a fresh log; prior turns
  // are then derived from events. The 1.x rolling history no longer feeds
  // the harness messages directly (degraded spine falls back to it).
  const seededHistory = await seedHeadlessModelHistory(spine, opts.history);
  // E1.4: advertise the spine session id so hosts (Desktop) resume the
  // same event log next turn instead of replaying 1.x history JSON.
  emitEvent(sessionStartedEvent(spine));

  spine.missionPhase('design', 'mission-start');
  const { buildMissionBrief } = await import('@zelari/core/council');
  const { hasWorkspacePlan } = await import('./workspace/planDetect.js');
  const { getMemoryBackend } = await import('./memory/fileBackend.js');
  const { runZelariMission } = await import('./zelariMission.js');
  const { dispatchCouncil } = await import('./councilDispatcher.js');
  const { FeedbackStore } = await import('./councilFeedback.js');
  const { runPostCouncilHook } = await import('./workspace/postCouncilHook.js');

  const brief = buildMissionBrief({
    userMessage: opts.task,
    hasPlan: hasWorkspacePlan(projectRoot),
  });
  // W2: the mission spine is already open here — mission memory events are
  // noted directly (context.projection / memory_event state-only payloads).
  const memory = await getMemoryBackend(projectRoot, process.env, (event) =>
    spineMemoryEventNote(spine, event),
  );
  const nativeMissionMemory = (
    memory as typeof memory & { service?: MemoryService }
  ).service;
  const { toolRegistry, workspaceCtx } = await buildCouncilToolRegistry(
    planModeFromOpts(opts),
    opts,
    nativeMissionMemory,
    Boolean(nativeMissionMemory) && process.env.ZELARI_MEMORY_AUTO_WRITE !== '0',
    extras,
  );
  const feedbackStore = new FeedbackStore();
  const chairmanBudget = envNumber(process.env.ZELARI_MODE_MAX_TOOLS_LUCIFER, {
    default: 30,
    min: 1,
  });
  const { shouldBuildViaAgent } = await import('./buildPolicy.js');
  const buildViaAgent = shouldBuildViaAgent();

  const emit = (message: string) => {
    if (opts.output === 'json') {
      emitEvent({ type: 'log', message });
    } else {
      process.stderr.write(message + '\n');
    }
  };

  // Exit-1/E1.2: spine-derived prior turns (legacy --history is the
  // one-shot import source, not the model-context brain).
  const contextTools: AgentToolSpec[] = toolRegistry.toOpenAITools().map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters as Record<string, unknown>,
  }));
  await spine.beginResourceTurn();
  const missionContext = await buildModelContext({
    fallbackHistory: seededHistory.history,
    session: spine.spine,
    phase: opts.phase ?? 'build',
    model,
    provider,
    tools: contextTools,
    sessionId: spine.sessionId,
    providerStream,
    // T4-S2: budget occupancy/policy onto the spine (context.projection note).
    budgetNoteHandle: spine,
    onCompactionMetric: (metrics) => recordCompactionMetrics(spine.sessionId, provider, model, metrics),
    persistCompaction: async (payload) => {
      await spine.appendEvent({
        kind: 'session.compacted',
        actor: { type: 'system' },
        data: { ...payload },
      });
    },
  });
  const historySeed: AgentMessage[] = missionContext.history;
  for (const warning of missionContext.budget.warnings) emit(warning);
  const missionTask = buildCouncilTaskWithHistory(opts.task, historySeed);
  if (opts.task) spine.userMessage(missionTask);

  // Surface the brief once so the desktop UI is not blank.
  emit(`[zelari] mission brief\n${JSON.stringify({ deliverable: brief.deliverableThisMission, mvp: brief.sliceMvp?.title }, null, 0)}`);
  if (buildViaAgent) {
    emit(
      '[zelari] policy: design@council · build@agent (set ZELARI_BUILD_VIA_AGENT=0 for legacy)',
    );
  }

  let exitCode = 0;
  let lastMissionAssistant = '';

  // ADR-0014: --once trigger mode — acquire lock + force single iteration.
  let lockAcquired = false;
  if (opts.once) {
    const { acquireLock } = await import('./triggerLock.js');
    const lockRes = await acquireLock(projectRoot);
    if (!lockRes.acquired) {
      process.stderr.write(
        `[zelari-code --once] skip: another mission is running (pid ${lockRes.heldBy}).\n`,
      );
      return 0;
    }
    lockAcquired = true;
    if (!process.env.ZELARI_MISSION_MAX_ITER) {
      process.env.ZELARI_MISSION_MAX_ITER = '1';
    }
  }

  try {
    const state = await runZelariMission(missionTask, brief, {
      projectRoot,
      memory,
      emit,
      buildViaAgent,
      onMissionPhase: (phase, note) => spine.missionPhase(phase, note),
      onMissionProgress: (advice, iteration) =>
        spine.missionProgress({
          recommendation: advice.recommendation,
          rationale: advice.rationale,
          blockers: advice.blockers,
          ...(advice.trend ? { trend: advice.trend } : {}),
          iteration,
        }),
      runSlice: async ({
        userMessage: slicePrompt,
        runMode,
        ragContext,
        implementerRetry,
      }) => {
        const effectiveRunMode = planModeFromOpts(opts) ? 'design-phase' : runMode;

        // design-phase always council; implementation uses agent when policy ON
        if (effectiveRunMode === 'design-phase' || !buildViaAgent) {
          const sessionId = crypto.randomUUID();
          const fullPrompt = ragContext
            ? `${slicePrompt}\n\n## Memory context\n${ragContext}`
            : slicePrompt;

          let synthesisText = '';
          let writeCount = 0;
          let chairmanErrored = false;
          let membersCompleted = 0;
          const scrub = createStreamScrubber();

          const { composeProjectContext } = await import(
            './workspace/composeContext.js'
          );
          const { loadDurableContext } = await import('./state/loadDurableContext.js');
          const memOnly = ragContext?.trim() ? ragContext : undefined;
          const durableState = await loadDurableContext(projectRoot);
          const composed = composeProjectContext({
            mode: 'zelari',
            cwd: projectRoot,
            userMessage: slicePrompt,
            memoryHits: memOnly,
            durableState: durableState || undefined,
            includeLessons: true,
            includeDurableState: false,
          });
          for await (const event of dispatchCouncil(fullPrompt, {
            apiKey: 'REDACTED',
            model,
            provider: 'openai-compatible',
            providerStream,
            sessionId,
            tools: toolRegistry,
            feedbackStore,
            runMode: effectiveRunMode,
            maxToolCallsChairman: chairmanBudget,
            ...(implementerRetry ? { skipSpecialists: true } : {}),
            workspaceContext: composed.workspaceContext,
            ...(composed.ragContext ? { ragContext: composed.ragContext } : {}),
            maxToolLoopIterations: envNumber(process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS, {
              default: 30,
              min: 1,
            }),
            ...(() => {
              const hard = envNumber(process.env.ZELARI_MAX_TOOL_LOOP_HARD, {
                default: 0,
                min: 0,
              });
              return hard > 0 ? { maxToolLoopHardCap: hard } : {};
            })(),
          })) {
            if (event.type === 'message_start') {
              scrub.reset();
            }
            if (event.type === 'message_delta' && typeof event.delta === 'string') {
              synthesisText += event.delta;
              const cleanDelta = scrub.push(event.delta);
              if (opts.output === 'json') {
                if (cleanDelta.length > 0) emitEvent({ ...event, delta: cleanDelta });
              } else if (opts.output === 'plain' && cleanDelta.length > 0) {
                process.stdout.write(cleanDelta);
              }
            } else if (opts.output === 'json') {
              emitEvent(event);
            }
            if (event.type === 'tool_execution_end') {
              const name = (event as { toolName?: string; name?: string }).toolName
                ?? (event as { name?: string }).name
                ?? '';
              if (name === 'write_file' || name === 'edit' || name === 'edit_file' || name === 'apply_diff') {
                writeCount += 1;
              }
            }
            if (event.type === 'agent_end') {
              membersCompleted += 1;
              if (event.reason === 'error') chairmanErrored = true;
            }
            if (event.type === 'error' && (event as { severity?: string }).severity === 'fatal') {
              chairmanErrored = true;
              exitCode = 2;
            }
          }

          let completionOk = false;
          let degraded = false;
          try {
            const { detectDegradedRun } = await import('@zelari/core/council');
            const d = detectDegradedRun({
              chairmanErrored,
              councilAborted: false,
              luciferWriteCount: writeCount,
              synthesisText,
              runMode: effectiveRunMode,
            });
            degraded = d.degraded;
            const hook = await runPostCouncilHook(workspaceCtx, {
              runMode: effectiveRunMode,
              userMessage: opts.task,
              synthesisText: synthesisText || undefined,
              degradedRun: d.degraded,
              degradedReasons: d.reasons,
              // 2.31 A1: without sessionId the spine-evidence gate in the hook
              // never fires, leaving headless with the legacy lint heuristic.
              sessionId: spine.sessionId,
            });
            completionOk = hook.completion?.completion?.ok ?? false;
            if (completionOk) {
              emit(`[zelari] slice completion ok`);
            }
            // 2.6.1 (plan §14): resource reserve gate in the completion lifecycle —
            // the budget can never create a PASS; it can only turn a non-PASS
            // into BLOCKED/resource-exhausted. Advisory spine record either way.
            try {
              const budget = spine.resourceBudgetSummary();
              if (budget && !completionOk) {
                const { evaluateResourceReserveGate } = await import('@zelari/core/verification');
                const gated = evaluateResourceReserveGate({
                  evaluation: {
                    verdict: 'REPAIR_REQUIRED',
                    summary: 'headless slice completion',
                    satisfied: [],
                    unsatisfied: [],
                    evidenceComplete: false,
                    eventBackedEvidenceComplete: false,
                  },
                  budget,
                });
                if (gated.verdict === 'BLOCKED') {
                  emit('[zelari] completion BLOCKED: resource budget exhausted (non-PASS + zero remaining)');
                }
                spine.note('completion.resource_gate', { decision: gated.verdict, remaining: budget.toolCalls.remaining });
              }
            } catch {
              /* advisory record only — never breaks the turn */
            }
          } catch {
            // best-effort
          }

          if (synthesisText.trim()) {
            lastMissionAssistant = cleanAgentContent(synthesisText, {
              stripQuestion: false,
              stripThink: false,
            });
          }

          return {
            completionOk,
            ran: membersCompleted > 0 || synthesisText.length > 0,
            synthesisText: synthesisText || undefined,
            writeCount,
            degraded,
          };
        }

        // build@agent implementation slice
        const { runAgentMissionSlice } = await import('./missionSlice.js');
        const { createBuiltinToolRegistry } = await import('./toolRegistry.js');
        const { composeProjectContext } = await import(
          './workspace/composeContext.js'
        );
        const { loadDurableContext } = await import('./state/loadDurableContext.js');
        const { detectDegradedRun } = await import('@zelari/core/council');

        const { registry: agentRegistry } = createBuiltinToolRegistry({
          root: projectRoot,
          planMode: false,
          permissionPolicy: {
            read: 'allow',
            write: 'allow',
            execute: 'allow',
            network: 'allow',
            ui: 'allow',
            auto: true,
          },
        });
        await registerHeadlessMcp(agentRegistry, opts);

        const durableState = await loadDurableContext(projectRoot);
        const composed = composeProjectContext({
          mode: 'zelari',
          cwd: projectRoot,
          userMessage: slicePrompt,
          memoryHits: ragContext?.trim() ? ragContext : undefined,
          durableState: durableState || undefined,
          includeLessons: true,
          includeDurableState: false,
        });

        const sliceResult = await runAgentMissionSlice({
          projectRoot,
          model,
          provider: 'openai-compatible',
          providerStream,
          toolRegistry: agentRegistry,
          slicePrompt,
          ragContext: composed.ragContext ?? ragContext,
          workspaceContext: composed.workspaceContext,
          projectInstructions: composed.projectInstructions,
          emit,
          onEvent: async (event) => {
            if (opts.output === 'json') {
              if (event.type === 'message_delta' && typeof event.delta === 'string') {
                emitEvent(event);
              } else {
                emitEvent(event);
              }
            } else if (
              opts.output === 'plain' &&
              event.type === 'message_delta' &&
              typeof event.delta === 'string'
            ) {
              process.stdout.write(event.delta);
            }
          },
          runCompletionHook: async ({ synthesisText, writeCount, errored }) => {
            const d = detectDegradedRun({
              chairmanErrored: errored,
              luciferWriteCount: writeCount,
              synthesisText,
              runMode: 'implementation',
            });
            const hook = await runPostCouncilHook(workspaceCtx, {
              runMode: 'implementation',
              userMessage: opts.task,
              synthesisText: synthesisText || undefined,
              degradedRun: d.degraded,
              degradedReasons: d.reasons,
              // 2.31 A1: same fix as the council path — evidence gate needs it.
              sessionId: spine.sessionId,
            });
            if (hook.completion?.completion?.ok) {
              emit(`[zelari] slice completion ok`);
            }
            return {
              completionOk: hook.completion?.completion?.ok ?? false,
              degraded: d.degraded,
            };
          },
        });

        if (sliceResult.synthesisText?.trim()) {
          lastMissionAssistant = sliceResult.synthesisText;
        }
        return sliceResult;
      },
    });

    if (state.status === 'error') exitCode = exitCode || 3;
    else if (state.status === 'success') {
      // ADR-0025: missions close under the strict evidence gate by default
      // (opt-out: ZELARI_MISSION_STRICT=0, or the per-run --no-mission-strict /
      // --no-strict-done overlay). A blocked gate never exits 0 —
      // the mission "success" becomes the strict exit code and the spine
      // records mission-strict-blocked instead of mission-success.
      const missionGate = await evaluateStrictBuildGate('build', {
        emit: (input) => spine.appendEvent(input),
        surface: 'mission',
        // H10-fix1: per-invocation env overlay — never process.env.
        env: strictEnvOverlay(opts),
        cwd: projectRoot,
      });
      const missionVerificationPayload = strictGateEventPayload(missionGate);
      spine.verificationRun(missionVerificationPayload);
      if (opts.output === 'json') {
        emitEvent({ type: 'verification_run', ...missionVerificationPayload });
      }
      // P0.3: mission proof — written in BOTH branches below so the artifact
      // always records the final mission verdict, blocked or not.
      await writeProofSafe(missionGate, { surface: 'mission', sessionId: spine.sessionId }, projectRoot);

      if (missionGate.blocked) {
        exitCode = strictGateExitCode(missionGate);
        spine.missionPhase('verification', 'mission-strict-blocked');
      } else {
        exitCode = 0;
        spine.missionPhase('done', 'mission-success');
      }
    } else if (state.status === 'stalled' || state.status === 'stopped') {
      exitCode = exitCode || 0;
      spine.missionPhase('verification', `mission-${state.status}`);
    }
  } catch (err) {
    process.stderr.write(
      `[zelari-code --headless] zelari error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  } finally {
    if (lockAcquired) {
      const { releaseLock } = await import('./triggerLock.js');
      await releaseLock(projectRoot);
    }
    await memory.close().catch(() => undefined);
    try {
      if (exitCode === 0) await spine.close('completed');
      else await spine.close(exitCode === 2 ? 'error' : 'stopped');
    } catch { /* spine never fails the run */ }
    // HarnessState inc.3: final read-model event for JSON hosts (best-effort).
    await emitHarnessStateEvent({ spine, workspaceRoot: projectRoot, output: opts.output, emitEvent });
    if (opts.exportSessionPath) {
      try {
        const json = await spine.exportJson();
        if (json) {
          if (opts.exportSessionPath === '-') process.stdout.write(json + '\n');
          else {
            await fs.mkdir(path.dirname(opts.exportSessionPath), { recursive: true }).catch(() => undefined);
            await fs.writeFile(opts.exportSessionPath, json, 'utf8');
          }
        }
      } catch { /* export is best-effort */ }
    }
  }


  return exitCode;
}


