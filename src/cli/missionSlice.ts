/**
 * missionSlice — shared helpers for Zelari mission implementation slices
 * that run on the **single-agent** harness (experiment: plan@council, build@kraken).
 *
 * Pure counting helpers are unit-tested; the harness runner is used by
 * headless + TUI wiring.
 */

import { AgentHarness, type ProviderStreamFn } from '@zelari/core/harness';
import type { AgentMessage, AgentToolSpec } from '@zelari/core/harness';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
import type { BrainEvent } from '@zelari/core/events';
import {
  buildSystemPrompt,
  getAllTools,
  KRAKEN_IDENTITY_MODULE,
  KRAKEN_LEAD_PLAYBOOK_MODULE,
  buildLanguagePolicyModuleFor,
} from '@zelari/core/skills';
import {
  buildImplementationWriteRetryPrompt,
  detectDegradedRun,
} from '@zelari/core/council';
import { cleanAgentContent } from '@zelari/core';
import { resolveAgentMissionToolBudget } from './buildPolicy.js';
import { envNumber } from './utils/envNumber.js';
import type { SliceRunResult } from './zelariMission.js';
import { calculateCost } from './modelPricing.js';

const MUTATING = new Set(['write_file', 'edit_file', 'apply_diff']);

/** Prefix for agent implementation slices (mission context). */
export const AGENT_MISSION_IMPLEMENTER_PREAMBLE =
  'You are the sole implementer for this Zelari mission slice. ' +
  'A multi-agent council may already have produced a plan under `.zelari/` — treat it as a SPEC to apply on disk. ' +
  'You MUST create or modify real project files with write_file / edit_file. ' +
  'Prose without successful writes is a failed slice.';

export interface WriteCountState {
  successfulWrites: number;
  emittedWrites: number;
}

/**
 * Track mutating tool success from harness tool events.
 * Call on tool_execution_start (to map id→name) and tool_execution_end.
 */
export function createWriteCounter(): {
  state: WriteCountState;
  onEvent: (event: {
    type: string;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    result?: string;
    name?: string;
  }) => void;
} {
  const state: WriteCountState = { successfulWrites: 0, emittedWrites: 0 };
  const pending = new Map<string, string>();

  return {
    state,
    onEvent(event) {
      if (event.type === 'tool_execution_start') {
        const name = event.toolName ?? event.name ?? '';
        const id = event.toolCallId ?? '';
        if (id && name) pending.set(id, name);
        if (MUTATING.has(name)) state.emittedWrites += 1;
        return;
      }
      if (event.type === 'tool_execution_end') {
        const id = event.toolCallId ?? '';
        const name = pending.get(id) ?? event.toolName ?? event.name ?? '';
        if (id) pending.delete(id);
        if (!MUTATING.has(name) || event.isError) return;
        const result = String(event.result ?? '');
        const zeroEdit =
          name === 'edit_file' &&
          /occurrencesReplaced["']?\s*[:=]\s*0\b|0 occurrence|no changes/i.test(
            result,
          );
        if (!zeroEdit) state.successfulWrites += 1;
      }
    },
  };
}

export function buildAgentMissionUserPrompt(
  slicePrompt: string,
  ragContext?: string,
): string {
  const body = `${AGENT_MISSION_IMPLEMENTER_PREAMBLE}\n\n${slicePrompt}`;
  if (ragContext?.trim()) {
    return `${body}\n\n## Memory context\n${ragContext.trim()}`;
  }
  return body;
}

export interface AgentMissionSliceDeps {
  projectRoot: string;
  model: string;
  provider?: string;
  providerStream: ProviderStreamFn;
  toolRegistry: ToolRegistry;
  slicePrompt: string;
  ragContext?: string;
  workspaceContext?: string;
  projectInstructions?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional fan-out of BrainEvents (TUI / headless NDJSON). */
  onEvent?: (event: BrainEvent) => void | Promise<void>;
  /** Status line helper. */
  emit?: (message: string) => void;
  /**
   * When true (default), one zero-write retry with
   * buildImplementationWriteRetryPrompt.
   */
  writeRetry?: boolean;
  /** Post-slice completion hook (usually runPostCouncilHook). */
  runCompletionHook?: (args: {
    synthesisText: string;
    writeCount: number;
    errored: boolean;
  }) => Promise<{ completionOk: boolean; degraded: boolean }>;
}

/**
 * Run one implementation slice on the single-agent harness.
 * Returns the same shape as a council slice for the mission driver.
 */
export async function runAgentMissionSlice(
  deps: AgentMissionSliceDeps,
): Promise<SliceRunResult> {
  const env = deps.env ?? process.env;
  const provider = deps.provider ?? 'openai-compatible';
  const sessionId = deps.sessionId ?? crypto.randomUUID();
  const maxToolCalls = resolveAgentMissionToolBudget(env);
  const maxToolLoop = envNumber(env.ZELARI_MAX_TOOL_LOOP_ITERATIONS, {
    default: 30,
    min: 1,
  });
  const maxToolLoopHard = envNumber(env.ZELARI_MAX_TOOL_LOOP_HARD, {
    default: 0,
    min: 0,
  });
  const writeRetry = deps.writeRetry !== false;

  const toolSpecs: AgentToolSpec[] = deps.toolRegistry.toOpenAITools().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as Record<string, unknown>,
  }));
  const toolNames = toolSpecs.map((t) => t.name);

  let languageDirective: string;
  try {
    languageDirective = buildLanguagePolicyModuleFor(deps.slicePrompt).content;
  } catch {
    languageDirective =
      "# Response Language\nReply in the user's language when possible, otherwise Italian.";
  }

  const rolePrompt = [
    '# Platform',
    `platform: ${process.platform}`,
    `shell: ${process.platform === 'win32' ? 'cmd.exe / Git Bash (auto-detected)' : '/bin/sh'}`,
    '',
    '# Working Directory',
    `You are running in: ${deps.projectRoot}`,
    'All relative file paths are resolved against this directory.',
    'The shell is NON-INTERACTIVE (stdin closed): pass non-interactive flags (--yes, --force, --template).',
    '',
    '# Work phase: BUILD (Zelari mission implementation slice)',
    'IMPLEMENT ON DISK. Prior design under .zelari/ is a SPEC, not proof of delivery.',
    'You MUST call write_file and/or edit_file before claiming done.',
  ].join('\n');

  const headlessRole = {
    id: 'mission-agent',
    name: 'Zelari Code',
    codename: 'zelari-build',
    role: 'mission implementer',
    color: '#00d9a3',
    avatar: '◆',
    tools: toolNames,
    systemPrompt: rolePrompt,
  };

  let systemPrompt: string;
  try {
    systemPrompt = buildSystemPrompt(
      headlessRole,
      {
        tools: getAllTools(),
        toolNames,
        mode: 'kraken',
        projectInstructions: deps.projectInstructions || undefined,
        workspaceContext: deps.workspaceContext || undefined,
        ragContext: undefined,
        aiConfig: {
          enabledSkills: [],
          enabledTools: toolNames,
          customPromptModules: [
            KRAKEN_IDENTITY_MODULE,
            KRAKEN_LEAD_PLAYBOOK_MODULE,
            {
              type: 'language-policy',
              title: 'Response Language',
              priority: 5,
              content: languageDirective,
            },
          ],
          agentSkillConfigs: [],
        },
      },
    );
  } catch {
    systemPrompt = [
      'You are zelari-code, implementing a mission slice. Write real files.',
      languageDirective,
      deps.workspaceContext ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  const userContent = buildAgentMissionUserPrompt(
    deps.slicePrompt,
    deps.ragContext,
  );

  async function runPass(
    messages: AgentMessage[],
    passId: string,
  ): Promise<{
    text: string;
    successfulWrites: number;
    emittedWrites: number;
    errored: boolean;
    messages: readonly AgentMessage[];
    promptTokens: number;
    completionTokens: number;
  }> {
    const counter = createWriteCounter();
    const harness = new AgentHarness({
      model: deps.model,
      provider,
      sessionId: passId,
      messages,
      tools: toolSpecs,
      toolRegistry: deps.toolRegistry,
      providerStream: deps.providerStream,
      cwd: deps.projectRoot,
      maxToolCallsPerTurn: maxToolCalls,
      maxToolLoopIterations: maxToolLoop,
      ...(maxToolLoopHard > 0 ? { maxToolLoopHardCap: maxToolLoopHard } : {}),
    });

    let text = '';
    let errored = false;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      for await (const event of harness.run()) {
        counter.onEvent(event as {
          type: string;
          toolName?: string;
          toolCallId?: string;
          isError?: boolean;
          result?: string;
        });
        if (deps.onEvent) await deps.onEvent(event);
        if (event.type === 'message_delta' && typeof event.delta === 'string') {
          text += event.delta;
        }
        if (event.type === 'agent_end' && event.reason === 'error') {
          errored = true;
        }
        if (
          event.type === 'message_end' &&
          (event as { usage?: { promptTokens?: number; completionTokens?: number } }).usage
        ) {
          const u = (event as { usage: { promptTokens?: number; completionTokens?: number } }).usage;
          promptTokens += u.promptTokens ?? 0;
          completionTokens += u.completionTokens ?? 0;
        }
        if (event.type === 'error' && (event as { severity?: string }).severity === 'fatal') {
          errored = true;
        }
      }
    } catch {
      errored = true;
    }

    // Prefer last assistant content from harness if stream text empty
    if (!text.trim()) {
      const all = harness.getMessages();
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i];
        if (m?.role === 'assistant' && (m.content ?? '').trim()) {
          text = m.content ?? '';
          break;
        }
      }
    }

    return {
      text,
      successfulWrites: counter.state.successfulWrites,
      emittedWrites: counter.state.emittedWrites,
      errored,
      messages: harness.getMessages(),
      promptTokens,
      completionTokens,
    };
  }

  const initial: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  let pass = await runPass(initial, sessionId);
  let totalWrites = pass.successfulWrites;
  let totalEmitted = pass.emittedWrites;
  let synthesisText = pass.text;
  let errored = pass.errored;
  let totalPromptTokens = pass.promptTokens;
  let totalCompletionTokens = pass.completionTokens;

  if (
    writeRetry &&
    totalWrites === 0 &&
    !errored
  ) {
    deps.emit?.(
      '[zelari] build@kraken: 0 write — forcing implementation retry',
    );
    const retryPrompt = buildImplementationWriteRetryPrompt(deps.slicePrompt);
    const retryMessages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      ...pass.messages.filter((m) => m.role !== 'system'),
      { role: 'user', content: retryPrompt },
    ];
    const retry = await runPass(retryMessages, `${sessionId}-write-retry`);
    totalWrites += retry.successfulWrites;
    totalEmitted += retry.emittedWrites;
    if (retry.text.trim()) {
      synthesisText = synthesisText
        ? `${synthesisText}\n\n${retry.text}`
        : retry.text;
    }
    errored = errored || retry.errored;
    totalPromptTokens += retry.promptTokens;
    totalCompletionTokens += retry.completionTokens;
  }

  const cleaned = cleanAgentContent(synthesisText, {
    stripQuestion: false,
    stripThink: false,
  });

  let completionOk = false;
  let degraded = false;

  if (deps.runCompletionHook) {
    try {
      const hook = await deps.runCompletionHook({
        synthesisText: cleaned,
        writeCount: totalWrites,
        errored,
      });
      completionOk = hook.completionOk;
      degraded = hook.degraded;
    } catch {
      // fall through to local degraded detect
    }
  }

  if (!deps.runCompletionHook) {
    const d = detectDegradedRun({
      chairmanErrored: errored,
      luciferWriteCount: totalWrites,
      synthesisText: cleaned,
      runMode: 'implementation',
    });
    degraded = d.degraded;
    // Without hook: success = at least one write and not errored
    completionOk = totalWrites > 0 && !errored && !degraded;
  }

  // Hard gate: verification can be vacuously green on an empty tree with no
  // plan tasks. An implementation slice with zero project writes is never done.
  if (totalWrites === 0) {
    if (completionOk) {
      deps.emit?.(
        '[zelari] build@kraken: completion.ok overridden — 0 project writes (not done)',
      );
    }
    completionOk = false;
    const d = detectDegradedRun({
      chairmanErrored: errored,
      luciferWriteCount: 0,
      synthesisText: cleaned || 'completato',
      runMode: 'implementation',
    });
    if (d.degraded) degraded = true;
    else degraded = true; // zero-write impl is always degraded for hand-off
  }

  void totalEmitted;

  const costTokens = totalPromptTokens + totalCompletionTokens;
  const costUsd = calculateCost(deps.model, totalPromptTokens, totalCompletionTokens);

  return {
    completionOk,
    ran: true,
    synthesisText: cleaned || undefined,
    writeCount: totalWrites,
    degraded,
    costTokens,
    costUsd,
  };
}
