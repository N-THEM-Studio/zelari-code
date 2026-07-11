/**
 * runHeadless — execute a single task without mounting Ink.
 *
 * Streams BrainEvents either as NDJSON (one JSON object per line on
 * stdout) or as plain text (just the assistant message body).
 *
 * Modes:
 *   - agent (default): one AgentHarness run
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
import { cleanAgentContent } from '@zelari/core';
import {
  buildCouncilTaskWithHistory,
  maybeAnchorShortAnswer,
} from './hooks/conversationContext.js';
import { createBuiltinToolRegistry } from './toolRegistry.js';
import {
  emitEvent,
  openaiCompatibleProvider,
  resolveHeadlessKey,
  resolveHeadlessProvider,
  type HeadlessOptions,
} from './headless.js';
import {
  buildSystemPrompt,
  getAllTools,
  SINGLE_AGENT_IDENTITY_MODULE,
  buildLanguagePolicyModuleFor,
} from '@zelari/core/skills';
import { envNumber } from './utils/envNumber.js';
import { setPhase } from './phaseState.js';
import { describePhase } from './phase.js';
import { createStreamScrubber } from './utils/streamScrub.js';

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
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

  // Apply work phase before any tool registry is built.
  setPhase(opts.phase ?? 'build');

  const { provider, model } = resolveHeadlessProvider(opts);

  const key = await resolveHeadlessKey(provider);
  if ('error' in key) {
    process.stderr.write(`[zelari-code --headless] ${key.error}\n`);
    return 1;
  }

  const providerStream = openaiCompatibleProvider({
    providerId: provider as 'minimax' | 'glm' | 'grok' | 'openai-compatible' | 'custom',
    apiKey: key.apiKey,
    baseUrl: key.baseUrl,
    model,
  });

  const mode = opts.mode ?? (opts.useCouncil ? 'council' : 'agent');

  if (opts.output === 'json') {
    emitEvent({
      type: 'log',
      message: `[headless] mode=${mode} phase=${opts.phase ?? 'build'} provider=${provider} model=${model}`,
    });
  } else {
    process.stderr.write(
      `[zelari-code --headless] mode=${mode} phase=${describePhase(opts.phase ?? 'build')}\n`,
    );
  }

  if (mode === 'zelari') {
    return runHeadlessZelari(opts, provider, model, providerStream);
  }
  if (mode === 'council' || opts.useCouncil) {
    return runHeadlessCouncil(opts, provider, model, providerStream);
  }
  return runHeadlessSingle(opts, provider, model, providerStream);
}

function planModeFromOpts(opts: HeadlessOptions): boolean {
  return (opts.phase ?? 'build') === 'plan';
}

let mcpExitHookInstalled = false;

async function registerHeadlessMcp(
  toolRegistry: ToolRegistry,
  opts: HeadlessOptions,
): Promise<void> {
  try {
    const { registerMcpTools, closeMcpClients } = await import('./mcp/mcpManager.js');
    const mcp = await registerMcpTools(toolRegistry, process.cwd());
    // Ensure MCP child processes are torn down when the headless process exits.
    if (!mcpExitHookInstalled) {
      mcpExitHookInstalled = true;
      process.once('exit', () => {
        try {
          closeMcpClients();
        } catch {
          /* ignore */
        }
      });
    }
    if (mcp.registered.length > 0 && opts.output === 'json') {
      emitEvent({
        type: 'log',
        message: `[headless] MCP tools: ${mcp.registered.length} registered`,
      });
    }
    for (const w of mcp.warnings) {
      if (opts.output === 'json') {
        emitEvent({ type: 'log', message: `[mcp] ${w}` });
      } else {
        process.stderr.write(`[zelari-code --headless] [mcp] ${w}\n`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.output === 'json') {
      emitEvent({ type: 'log', message: `[mcp] registration skipped: ${msg}` });
    } else {
      process.stderr.write(`[zelari-code --headless] [mcp] registration skipped: ${msg}\n`);
    }
  }
}

async function runHeadlessSingle(
  opts: HeadlessOptions,
  provider: string,
  model: string,
  providerStream: ProviderStreamFn,
): Promise<number> {
  const sessionId = crypto.randomUUID();
  const { registry: toolRegistry } = createBuiltinToolRegistry({
    planMode: planModeFromOpts(opts),
  });
  // Parity with TUI: project MCP tools must be available from Desktop/headless.
  await registerHeadlessMcp(toolRegistry, opts);
  const tools: AgentToolSpec[] = toolRegistry.toOpenAITools().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as Record<string, unknown>,
  }));
  const toolNames = tools.map((t) => t.name);

  let systemPrompt: string;
  let languageDirectiveContent: string;
  try {
    languageDirectiveContent = buildLanguagePolicyModuleFor(opts.task).content;
  } catch {
    languageDirectiveContent = '# Response Language\nReply in the user\'s language when possible, otherwise Italian.';
  }
  try {
    const headlessRole = {
      id: 'single',
      name: 'Zelari Code',
      codename: 'zelari',
      role: 'headless coding agent',
      color: '#00d9a3',
      avatar: '◆',
      tools: toolNames,
      systemPrompt: [
        '# Platform',
        `platform: ${process.platform}`,
        `shell: ${process.platform === 'win32' ? 'cmd.exe / Git Bash (auto-detected)' : '/bin/sh'}`,
        '',
        '# Working Directory',
        `You are running in: ${process.cwd()}`,
        'All relative file paths are resolved against this directory.',
        'The shell is NON-INTERACTIVE (stdin closed): pass non-interactive flags (--yes, --force, --template).',
        '',
        `# Work phase: ${opts.phase ?? 'build'}`,
        (opts.phase ?? 'build') === 'plan'
          ? 'PLAN phase: explore and design only. Do not write project source files (write_file/edit_file/bash blocked). Plan artifacts under .zelari are allowed.'
          : 'BUILD phase: full tools; implement changes.',
      ].join('\n'),
    };
    const { loadProjectInstructions } = await import(
      './workspace/projectInstructions.js'
    );
    const projectInstructions = loadProjectInstructions(process.cwd()).content;
    let sshBlock = '';
    try {
      const { formatSshTargetsForPrompt } = await import('./ssh/targets.js');
      sshBlock = formatSshTargetsForPrompt();
    } catch {
      /* optional */
    }
    const rolePrompt = [headlessRole.systemPrompt, sshBlock]
      .filter(Boolean)
      .join('\n\n');
    systemPrompt = buildSystemPrompt(
      { ...headlessRole, systemPrompt: rolePrompt },
      {
        tools: getAllTools(),
        toolNames,
        mode: 'agent',
        projectInstructions: projectInstructions || undefined,
        aiConfig: {
          enabledSkills: [],
          enabledTools: toolNames,
          customPromptModules: [
            SINGLE_AGENT_IDENTITY_MODULE,
            {
              type: 'language-policy',
              title: 'Response Language',
              priority: 5,
              content: languageDirectiveContent,
            },
          ],
          agentSkillConfigs: [],
        },
      },
    );
  } catch {
    systemPrompt = [
      'You are zelari-code, a CLI coding agent. Be concise and direct.',
      'When the user asks you to write code, debug, or explore, be proactive: list files and read key files to understand the project.',
      'When you finish a task, briefly summarize what you did.',
      languageDirectiveContent,
    ].join('\n');
  }

  // v1.10.0: multi-turn context for the desktop. Each desktop message spawns
  // a fresh headless process, so without seeding prior turns the agent has
  // amnesia and treats "procedi" / "sì" as brand-new requests. The desktop
  // passes the rolling history via --history <json>; we scrub it (strip
  // <think> tags but KEEP ---QUESTION--- blocks so short answers can bind),
  // then seed the harness as [system, ...history, {user: task}].
  const historySeed: AgentMessage[] = (opts.history ?? []).map((m) =>
    m.role === 'assistant' && m.content
      ? { ...m, content: cleanAgentContent(m.content, { stripQuestion: false }) }
      : m,
  );

  // Short-answer anchoring: if the last history turn was a clarifying
  // question and the user's reply is short ("procedi", "2", "sì"), rewrite
  // it to re-state the question so the model can't treat it as contextless.
  // Mirrors the TUI's maybeAnchorShortAnswer (conversationContext.ts).
  const effectiveTask = maybeAnchorShortAnswer(opts.task)
    ?? opts.task;
  const historySeedLen = historySeed.length;

  const harness = new AgentHarness({
    model,
    provider,
    sessionId,
    messages: [
      { role: 'system', content: systemPrompt },
      ...historySeed,
      { role: 'user', content: effectiveTask },
    ] as AgentMessage[],
    tools,
    toolRegistry,
    providerStream,
    maxToolLoopIterations: (() => {
      const n = envNumber(process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS, { default: 30, min: 1 });
      return n;
    })(),
  });

  let finalReason: 'completed' | 'cancelled' | 'error' = 'completed';
  let exitCode = 0;
  const textBuffer: string[] = [];
  // Scrub <think>/---QUESTION--- leaks from the streamed text. The TUI does
  // this in useChatTurn; the headless path used to emit raw deltas, leaking
  // model reasoning into the desktop UI. One scrubber per turn accumulates
  // raw text and yields only clean increments.
  const scrub = createStreamScrubber();

  try {
    for await (const event of harness.run()) {
      // Reset the scrubber on every new assistant message so an unclosed
      // <think> in one message can't swallow the next message's text.
      // (In a tool-loop turn the harness emits multiple message_start/end cycles.)
      if (event.type === 'message_start') {
        scrub.reset();
      }
      if (event.type === 'message_delta' && typeof event.delta === 'string') {
        const cleanDelta = scrub.push(event.delta);
        if (opts.output === 'json') {
          // Re-emit a scrubbed message_delta so JSON consumers never see
          // <think> tags. (Other event types pass through untouched.)
          if (cleanDelta.length > 0) {
            emitEvent({ ...event, delta: cleanDelta });
          }
        } else if (opts.output === 'plain') {
          if (cleanDelta.length > 0) process.stdout.write(cleanDelta);
        } else {
          if (cleanDelta.length > 0) textBuffer.push(cleanDelta);
        }
      } else {
        if (opts.output === 'json') {
          emitEvent(event);
        }
        if (event.type === 'agent_end') {
          // Flush any trailing cleaned text before signaling end.
          const tail = scrub.flush();
          if (tail.length > 0) {
            if (opts.output === 'plain') process.stdout.write(tail);
            else textBuffer.push(tail);
          }
          finalReason = event.reason;
          if (event.reason === 'error') exitCode = 3;
        } else if (event.type === 'error') {
          if (event.severity === 'fatal') {
            exitCode = 2;
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(
      `[zelari-code --headless] runtime error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  if (opts.output === 'plain' && textBuffer.length > 0) {
    process.stdout.write(textBuffer.join(''));
  }
  process.stdout.write('');

  // v1.10.0: emit a history_snapshot so the desktop can replay this turn's
  // assistant+tool tail on the next message. We snapshot the messages BEYOND
  // the seed (everything the harness added this turn), scrubbing <think> from
  // assistant content but KEEPING ---QUESTION--- blocks (so the next turn's
  // short-answer anchor can still bind). Mirrors useChatTurn's finally block.
  if (finalReason !== 'error' && opts.output === 'json') {
    try {
      const all = harness.getMessages();
      const seedLen = 1 /*system*/ + historySeedLen + 1 /*user*/;
      if (all.length > seedLen) {
        const tail = all.slice(seedLen).map((m) =>
          m.role === 'assistant' && m.content
            ? { ...m, content: cleanAgentContent(m.content, { stripQuestion: false }) }
            : m,
        );
        if (tail.length > 0) {
          emitEvent({ type: 'history_snapshot', messages: tail });
        }
      }
    } catch {
      // Non-fatal: a snapshot failure must never break the run.
    }
  }

  if (finalReason === 'error') return 3;
  return exitCode;
}

async function buildCouncilToolRegistry(
  planMode: boolean,
  opts?: HeadlessOptions,
) {
  const { registry: toolRegistry } = createBuiltinToolRegistry({ planMode });
  const { createWorkspaceContext, createWorkspaceStubs } = await import('./workspace/stubs.js');
  const { createWorkspaceToolRegistry } = await import('./workspace/toolRegistry.js');
  const { setWorkspaceStubs } = await import('@zelari/core/skills');

  const realCtx = createWorkspaceContext();
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
): Promise<number> {
  const { dispatchCouncil } = await import('./councilDispatcher.js');
  const sessionId = crypto.randomUUID();
  const { toolRegistry } = await buildCouncilToolRegistry(
    planModeFromOpts(opts),
    opts,
  );
  const { FeedbackStore } = await import('./councilFeedback.js');
  const feedbackStore = new FeedbackStore();

  // Multi-turn: Desktop passes --history, but council used to ignore it →
  // "procedi" looked like a brand-new empty request. Inject prior transcript
  // into the user task and emit history_snapshot for the next turn.
  const historySeed: AgentMessage[] = (opts.history ?? []).map((m) =>
    m.role === 'assistant' && m.content
      ? { ...m, content: cleanAgentContent(m.content, { stripQuestion: false }) }
      : m,
  );
  const effectiveTask = buildCouncilTaskWithHistory(opts.task, historySeed);

  let exitCode = 0;
  const scrub = createStreamScrubber();
  /** Last finished assistant blob this run (chairman / specialist). */
  let lastAssistantText = '';
  let currentAssistantText = '';
  try {
    for await (const event of dispatchCouncil(effectiveTask, {
      apiKey: 'REDACTED',
      model,
      provider: 'openai-compatible',
      providerStream,
      sessionId,
      tools: toolRegistry,
      feedbackStore,
      runMode: planModeFromOpts(opts) ? 'design-phase' : 'implementation',
    })) {
      if (event.type === 'message_start') {
        scrub.reset();
        currentAssistantText = '';
      }
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
    return 2;
  }

  // Desktop multi-turn: append this turn so the next "procedi" has context.
  if (opts.output === 'json') {
    try {
      const snapshot: AgentMessage[] = [
        { role: 'user', content: opts.task },
        ...(lastAssistantText
          ? ([{ role: 'assistant', content: lastAssistantText }] as AgentMessage[])
          : []),
      ];
      emitEvent({ type: 'history_snapshot', messages: snapshot });
    } catch {
      /* non-fatal */
    }
  }
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
): Promise<number> {
  const projectRoot = process.cwd();
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
  const memory = await getMemoryBackend(projectRoot);
  const { toolRegistry, workspaceCtx } = await buildCouncilToolRegistry(
    planModeFromOpts(opts),
    opts,
  );
  const feedbackStore = new FeedbackStore();
  const chairmanBudget = envNumber(process.env.ZELARI_MODE_MAX_TOOLS_LUCIFER, {
    default: 30,
    min: 1,
  });

  const emit = (message: string) => {
    if (opts.output === 'json') {
      emitEvent({ type: 'log', message });
    } else {
      process.stderr.write(message + '\n');
    }
  };

  const historySeed: AgentMessage[] = (opts.history ?? []).map((m) =>
    m.role === 'assistant' && m.content
      ? { ...m, content: cleanAgentContent(m.content, { stripQuestion: false }) }
      : m,
  );
  const missionTask = buildCouncilTaskWithHistory(opts.task, historySeed);

  // Surface the brief once so the desktop UI is not blank.
  emit(`[zelari] mission brief\n${JSON.stringify({ deliverable: brief.deliverableThisMission, mvp: brief.sliceMvp?.title }, null, 0)}`);

  let exitCode = 0;
  let lastMissionAssistant = '';
  try {
    const state = await runZelariMission(missionTask, brief, {
      projectRoot,
      memory,
      emit,
      runSlice: async ({ userMessage: slicePrompt, runMode, ragContext }) => {
        const sessionId = crypto.randomUUID();
        const fullPrompt = ragContext
          ? `${slicePrompt}\n\n## Memory context\n${ragContext}`
          : slicePrompt;

        let synthesisText = '';
        let writeCount = 0;
        let chairmanErrored = false;
        let membersCompleted = 0;
        const scrub = createStreamScrubber();

        for await (const event of dispatchCouncil(fullPrompt, {
          apiKey: 'REDACTED',
          model,
          provider: 'openai-compatible',
          providerStream,
          sessionId,
          tools: toolRegistry,
          feedbackStore,
          runMode: planModeFromOpts(opts) ? 'design-phase' : runMode,
          maxToolCallsChairman: chairmanBudget,
        })) {
          if (event.type === 'message_start') {
            scrub.reset();
          }
          if (event.type === 'message_delta' && typeof event.delta === 'string') {
            // Best-effort accumulate RAW last member stream as synthesis proxy
            // (the synthesis accumulator tracks raw provider text; the display
            // path below emits the scrubbed version separately).
            synthesisText += event.delta;
            const cleanDelta = scrub.push(event.delta);
            if (opts.output === 'json') {
              if (cleanDelta.length > 0) emitEvent({ ...event, delta: cleanDelta });
            } else if (opts.output === 'plain' && cleanDelta.length > 0) {
              process.stdout.write(cleanDelta);
            }
          } else {
            if (opts.output === 'json') {
              emitEvent(event);
            }
          }
          if (event.type === 'tool_execution_end') {
            const name = (event as { toolName?: string; name?: string }).toolName
              ?? (event as { name?: string }).name
              ?? '';
            if (name === 'write_file' || name === 'edit_file' || name === 'apply_diff') {
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
            runMode,
          });
          degraded = d.degraded;
          const hook = await runPostCouncilHook(workspaceCtx, {
            runMode,
            userMessage: opts.task,
            synthesisText: synthesisText || undefined,
            degradedRun: d.degraded,
            degradedReasons: d.reasons,
          });
          completionOk = hook.completion?.completion?.ok ?? false;
          if (completionOk) {
            emit(`[zelari] slice completion ok`);
          }
        } catch {
          // best-effort
        }

        if (synthesisText.trim()) {
          lastMissionAssistant = cleanAgentContent(synthesisText, {
            stripQuestion: false,
          });
        }

        return {
          completionOk,
          ran: membersCompleted > 0 || synthesisText.length > 0,
          synthesisText: synthesisText || undefined,
          writeCount,
          degraded,
        };
      },
    });

    if (state.status === 'error') exitCode = exitCode || 3;
    else if (state.status === 'success') exitCode = 0;
    else if (state.status === 'stalled' || state.status === 'stopped') exitCode = exitCode || 0;
  } catch (err) {
    process.stderr.write(
      `[zelari-code --headless] zelari error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  } finally {
    await memory.close().catch(() => undefined);
  }

  if (opts.output === 'json') {
    try {
      emitEvent({
        type: 'history_snapshot',
        messages: [
          { role: 'user', content: opts.task },
          ...(lastMissionAssistant
            ? ([{ role: 'assistant', content: lastMissionAssistant }] as AgentMessage[])
            : []),
        ],
      });
    } catch {
      /* non-fatal */
    }
  }

  return exitCode;
}
