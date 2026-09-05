/**
 * chairmanFixLoop — ---TOOLS--- replay and the bounded micro-gate fix loop,
 * extracted verbatim from agents/councilApi.ts.
 */
import { normalizeTextToolArgs, parseTextToolCalls } from '../../core/AgentHarness.js';
import type { AgentRole } from '../../types/index.js';
import type { BrainEvent } from '../../shared/events.js';
import { createBrainEvent } from '../../shared/events.js';
import type { SystemPromptModule } from '../../types/systemTypes.js';
import { ToolRegistry } from '../../core/tools/registry.js';
import { runChairmanMicroGate, type MicroGateWarning } from '../../council/verification/microGate.js';
import { buildMotionFixPrompt } from './chairmanDelivery.js';
import { runRetryTurnForMember } from './retryTurn.js';
import type { PureCouncilConfig } from './types.js';

/**
 * Re-execute edit_file/write_file calls from a `---TOOLS---` block after the
 * chairman turn. Safety net when the harness path parsed the block but edits
 * failed (oldString drift) or the block was not fully executed.
 */
export async function* replayChairmanTextTools(args: {
  synthesisText: string;
  projectRoot: string;
  toolRegistry: ToolRegistry;
  sessionId: string;
  memberId?: string;
}): AsyncGenerator<BrainEvent, number, void> {
  const tools = parseTextToolCalls(args.synthesisText);
  if (tools.length === 0) return 0;
  let applied = 0;
  for (const tt of tools) {
    if (tt.name !== 'edit_file' && tt.name !== 'write_file') continue;
    const normalized = normalizeTextToolArgs(tt.name, tt.args);
    const toolCallId = `replay-${crypto.randomUUID().slice(0, 8)}`;
    yield createBrainEvent('tool_execution_start', args.sessionId, {
      toolCallId,
      toolName: tt.name,
      args: normalized,
      ...(args.memberId ? { memberId: args.memberId } : {}),
    });
    const startMs = Date.now();
    let resultStr = '';
    let isError = false;
    try {
      const result = await args.toolRegistry.invoke<unknown>(tt.name, normalized, {
        cwd: args.projectRoot,
        sessionId: args.sessionId,
      });
      if (result.ok) {
        const val = result.value as { occurrencesReplaced?: number };
        if (tt.name === 'edit_file' && val.occurrencesReplaced === 0) {
          resultStr = `edit_file: no match for oldString (replay)`;
          isError = true;
        } else {
          resultStr =
            typeof result.value === 'string'
              ? result.value
              : JSON.stringify(result.value, null, 2);
          applied += 1;
        }
      } else {
        resultStr = result.error;
        isError = true;
      }
    } catch (err) {
      resultStr = err instanceof Error ? err.message : String(err);
      isError = true;
    }
    yield createBrainEvent('tool_execution_end', args.sessionId, {
      toolCallId,
      result: resultStr,
      isError,
      durationMs: Date.now() - startMs,
    });
  }
  return applied;
}

/**
 * Increment 4 — bounded deterministic fix loop for the chairman. When the
 * micro-gate flagged motion violations in Lucifero's writes, force a scoped
 * fix turn (read_file + edit_file only), re-scan the changed files, and repeat
 * until clean or the attempt cap. Emits only the fix turn's own events; the
 * post-council verification reports the final PASS/FAIL to the user.
 */
export async function* runChairmanFixLoop(args: {
  chairman: AgentRole;
  violations: Map<string, MicroGateWarning>;
  changedFiles: Set<string>;
  projectRoot: string;
  executableNames: ReadonlySet<string> | null;
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  onToolCall?: () => void;
  maxAttempts?: number;
  /** v1.7.0 (Pass-2 agy finding): see applyCompletionRetry. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, void, void> {
  const maxAttempts = args.maxAttempts ?? 3;
  const zelariRoot = `${args.projectRoot}/.zelari`;
  let current = Array.from(args.violations.values());
  let attempt = 0;
  while (current.length > 0 && attempt < maxAttempts) {
    attempt++;
    try {
      const fixGenerator = runRetryTurnForMember({
        agent: args.chairman,
        missingToolNames: ['read_file', 'edit_file'],
        minPerTool: { read_file: 2, edit_file: 8 },
        executableTools: args.executableNames,
        userMessage: args.userMessage,
        ragContext: args.config.ragContext,
        workspaceContext: args.config.workspaceContext,
        priorOutputs: args.agentOutputs,
        aiConfig: args.config.aiConfig,
        sessionId: args.sessionId,
        effectiveModel: args.effectiveModel,
        effectiveProvider: args.effectiveProvider,
        eventBus: args.config.eventBus,
        toolRegistry: args.config.tools,
        providerStream: args.config.providerStream,
        runMode: 'implementation',
        retryPrompt: buildMotionFixPrompt(current),
        languageModule: args.languageModule,
      });
      for await (const event of fixGenerator) {
        if (event.type === 'tool_execution_start') args.onToolCall?.();
        yield event;
      }
    } catch (fixErr) {
      // eslint-disable-next-line no-console
      console.error(`[council] chairman fix pass ${attempt} failed:`, fixErr);
      break;
    }
    // Re-scan the changed target files for the next iteration / termination.
    const rescanned = new Map<string, MicroGateWarning>();
    for (const relPath of args.changedFiles) {
      for (const w of runChairmanMicroGate({ projectRoot: args.projectRoot, relPath, zelariRoot })) {
        rescanned.set(`${w.id}|${w.file}|${w.line ?? ''}`, w);
      }
    }
    current = Array.from(rescanned.values());
  }
}

