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

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
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
    systemPrompt = buildSystemPrompt(headlessRole, {
      tools: getAllTools(),
      toolNames,
      aiConfig: {
        enabledSkills: [],
        enabledTools: toolNames,
        customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE, {
          type: 'language-policy',
          title: 'Response Language',
          priority: 5,
          content: languageDirectiveContent,
        }],
        agentSkillConfigs: [],
      },
    });
  } catch {
    systemPrompt = [
      'You are zelari-code, a CLI coding agent. Be concise and direct.',
      'When the user asks you to write code, debug, or explore, be proactive: list files and read key files to understand the project.',
      'When you finish a task, briefly summarize what you did.',
      languageDirectiveContent,
    ].join('\n');
  }

  const harness = new AgentHarness({
    model,
    provider,
    sessionId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: opts.task },
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

  try {
    for await (const event of harness.run()) {
      if (opts.output === 'json') {
        emitEvent(event);
      }
      if (event.type === 'message_delta') {
        if (opts.output === 'plain') {
          process.stdout.write(event.delta);
        } else {
          textBuffer.push(event.delta);
        }
      } else if (event.type === 'agent_end') {
        finalReason = event.reason;
        if (event.reason === 'error') exitCode = 3;
      } else if (event.type === 'error') {
        if (event.severity === 'fatal') {
          exitCode = 2;
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

  if (finalReason === 'error') return 3;
  return exitCode;
}

async function buildCouncilToolRegistry(planMode: boolean) {
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
  const { toolRegistry } = await buildCouncilToolRegistry(planModeFromOpts(opts));
  const { FeedbackStore } = await import('./councilFeedback.js');
  const feedbackStore = new FeedbackStore();

  let exitCode = 0;
  try {
    for await (const event of dispatchCouncil(opts.task, {
      apiKey: 'REDACTED',
      model,
      provider: 'openai-compatible',
      providerStream,
      sessionId,
      tools: toolRegistry,
      feedbackStore,
      runMode: planModeFromOpts(opts) ? 'design-phase' : 'implementation',
    })) {
      if (opts.output === 'json') {
        emitEvent(event);
      } else if (event.type === 'message_delta') {
        process.stdout.write(event.delta);
      } else if (event.type === 'agent_end' && event.reason === 'error') {
        exitCode = 3;
      } else if (event.type === 'error' && event.severity === 'fatal') {
        exitCode = 2;
      }
    }
  } catch (err) {
    process.stderr.write(
      `[zelari-code --headless] council error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
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
  const { toolRegistry, workspaceCtx } = await buildCouncilToolRegistry(planModeFromOpts(opts));
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

  // Surface the brief once so the desktop UI is not blank.
  emit(`[zelari] mission brief\n${JSON.stringify({ deliverable: brief.deliverableThisMission, mvp: brief.sliceMvp?.title }, null, 0)}`);

  let exitCode = 0;
  try {
    const state = await runZelariMission(opts.task, brief, {
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
          if (opts.output === 'json') {
            emitEvent(event);
          } else if (event.type === 'message_delta') {
            process.stdout.write(event.delta);
          }

          if (event.type === 'message_delta' && typeof event.delta === 'string') {
            // Best-effort accumulate last member stream as synthesis proxy
            synthesisText += event.delta;
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

  return exitCode;
}
