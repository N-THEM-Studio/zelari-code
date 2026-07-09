/**
 * runHeadless — execute a single task without mounting Ink.
 *
 * Streams BrainEvents either as NDJSON (one JSON object per line on
 * stdout) or as plain text (just the assistant message body).
 *
 * Two modes:
 *   - single (default): one AgentHarness run with the system prompt
 *     zelari-code uses for direct prompts.
 *   - council (`--council`): the same 6-member council pipeline the
 *     TUI uses for `/council`.
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

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
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

  if (opts.useCouncil) {
    return runHeadlessCouncil(opts, provider, model, providerStream);
  }
  return runHeadlessSingle(opts, provider, model, providerStream);
}

async function runHeadlessSingle(
  opts: HeadlessOptions,
  provider: string,
  model: string,
  providerStream: ProviderStreamFn,
): Promise<number> {
  const sessionId = crypto.randomUUID();
  const { registry: toolRegistry } = createBuiltinToolRegistry();
  const tools: AgentToolSpec[] = toolRegistry.toOpenAITools().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as Record<string, unknown>,
  }));
  const toolNames = tools.map((t) => t.name);

  // v1.7.0: route through buildSystemPrompt with SINGLE_AGENT_IDENTITY_MODULE
  // + the language-policy directive so the headless single-mode replies in
  // the user's language. Before this, the prompt was an inline 3-line array
  // missing 7 of 11 behavioral directives (anti-confabulation, act-don't-
  // describe, output self-check, clarification protocol, safety, formatting,
  // tool-usage) AND the response language policy — two regressions in one.
  // The fallback below preserves the pre-1.7 inline behavior for any case
  // where buildSystemPrompt throws (e.g. test context without a populated
  // catalog).
  //
  // v1.7.0 fix (agy audit): build the language module ONCE outside the
  // try/catch so a thrown detection error in `buildLanguagePolicyModuleFor`
  // does not re-throw inside the catch (which would crash the CLI instead
  // of recovering). The module's directive content is wrapped in try/catch
  // too, so even a Unicode edge case degrades to a minimal "reply in
  // Italian" stub.
  let systemPrompt: string;
  let languageDirectiveContent: string;
  try {
    languageDirectiveContent = buildLanguagePolicyModuleFor(opts.task).content;
  } catch {
    // Detection threw (e.g. malformed input). Use a safe stub so the rest
    // of the prompt assembly still proceeds.
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
      // v1.7.0 fix (agy audit): include platform/shell context in the role
      // prompt so the agent knows its cwd and shell — previously this was
      // empty (systemPrompt: '') and the agent lacked the platform block
      // the TUI single-agent path gets.
      systemPrompt: [
        '# Platform',
        `platform: ${process.platform}`,
        `shell: ${process.platform === 'win32' ? 'cmd.exe / Git Bash (auto-detected)' : '/bin/sh'}`,
        '',
        '# Working Directory',
        `You are running in: ${process.cwd()}`,
        'All relative file paths are resolved against this directory.',
        'The shell is NON-INTERACTIVE (stdin closed): pass non-interactive flags (--yes, --force, --template).',
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
    ],
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
  // Ensure stdout is flushed before exit (NDJSON consumers expect
  // all lines written before the process closes).
  process.stdout.write('');

  if (finalReason === 'error') return 3;
  return exitCode;
}

async function runHeadlessCouncil(
  opts: HeadlessOptions,
  provider: string,
  model: string,
  providerStream: ProviderStreamFn,
): Promise<number> {
  // Council path: dispatch through the same `dispatchCouncil`
  // function the TUI uses. This guarantees the same event shape
  // (including the v0.5.0 memberId/memberName stamping) is emitted
  // in both TUI and headless modes.
  const { dispatchCouncil } = await import('./councilDispatcher.js');
  const sessionId = crypto.randomUUID();
  const { registry: toolRegistry } = createBuiltinToolRegistry();
  const workspaceCtx = {
    projectRoot: process.cwd(),
    getActiveBranch: () => null,
  };
  const { createWorkspaceContext, createWorkspaceStubs } = await import('./workspace/stubs.js');
  const { createWorkspaceToolRegistry } = await import('./workspace/toolRegistry.js');
  const { setWorkspaceStubs } = await import('@zelari/core/skills');
  const { FeedbackStore } = await import('./councilFeedback.js');

  const realCtx = createWorkspaceContext();
  const realReg = createWorkspaceToolRegistry(realCtx);
  for (const name of realReg.list()) {
    const td = realReg.get(name);
    if (td) toolRegistry.register(td);
  }
  setWorkspaceStubs(createWorkspaceStubs(realCtx));
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
