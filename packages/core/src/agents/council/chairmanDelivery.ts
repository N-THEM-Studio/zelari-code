/**
 * chairmanDelivery — implementation-mode completion/write retries and the
 * verify-driven delivery loop, extracted verbatim from agents/councilApi.ts.
 */
import type { AgentRole } from '../../types/index.js';
import type { BrainEvent } from '../../shared/events.js';
import type { SystemPromptModule } from '../../types/systemTypes.js';
import { runChairmanMicroGate, type MicroGateWarning } from '../../council/verification/microGate.js';
import {
buildImplementationVerifyRetryPrompt,
checkImplementationCompletion,
resolveVerifyRetryTool,
} from '../../council/verification/completion.js';
import {
buildDeliveryFixPrompt,
buildImplementationWriteRetryPrompt,
filterDeliveryBlockingFails,
} from '../../council/verification/implementationDelivery.js';
import { runImplementationVerification } from '../../council/verification/runChecks.js';
import { applyInlineJsAutofix } from '../../council/verification/inlineJsAutofix.js';
import { runRetryTurnForMember, shouldRetryMember } from './retryTurn.js';
import type { PureCouncilConfig } from './types.js';
import { isCouncilCancelled } from './cancel.js';

/**
 * Implementation-mode anti-resa retry: force grep/bash after writes.
 */
export async function* applyCompletionRetry(args: {
  agent: AgentRole;
  emittedToolNames: string[];
  executableNames: ReadonlySet<string> | null;
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  onToolCall: () => void;
  /** v1.7.0 (Pass-2 agy finding): pre-built language module so the retry
   * turn's response language matches the rest of the council. Optional. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, void, void> {
  if (isCouncilCancelled(args.config.signal)) return;
  const check = checkImplementationCompletion(args.emittedToolNames);
  if (check.ok) return;
  const retryTool = resolveVerifyRetryTool(args.executableNames);
  if (!retryTool) {
    // eslint-disable-next-line no-console
    console.warn('[council] implementation verify retry skipped — no grep_content/bash in registry');
    return;
  }
  if (!shouldRetryMember([retryTool], 0)) return;
  // eslint-disable-next-line no-console
  console.warn(`[council] ${args.agent.id} retrying missing verify tool: ${retryTool}`);
  try {
    const retryGenerator = runRetryTurnForMember({
      agent: args.agent,
      missingToolNames: [retryTool],
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
      runMode: args.config.runMode,
      retryPrompt: buildImplementationVerifyRetryPrompt(retryTool),
      languageModule: args.languageModule,
      signal: args.config.signal,
    });
    for await (const event of retryGenerator) {
      if (event.type === 'tool_execution_start') {
        args.onToolCall();
        args.emittedToolNames.push(event.toolName);
      }
      yield event;
    }
  } catch (retryErr) {
    // eslint-disable-next-line no-console
    console.error(`[council] ${args.agent.id} verify retry failed:`, retryErr);
  }
  const after = checkImplementationCompletion(args.emittedToolNames);
  if (!after.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[council] ${args.agent.id} still missing verify after retry: ${after.reason}`);
  }
}

/**
 * Build the scoped fix instruction for the chairman from deterministic motion
 * violations. Groups by file, lists file:line + rule, and constrains the model
 * to fix ONLY these (no new features, no rewrites). Exported for testing.
 */
export function buildMotionFixPrompt(violations: MicroGateWarning[]): string {
  const byFile = new Map<string, string[]>();
  for (const v of violations) {
    const file = v.file || 'index.html';
    const loc = v.line ? `${file}:L${v.line}` : file;
    const list = byFile.get(file) ?? [];
    list.push(`  - ${loc}: ${v.message}`);
    byFile.set(file, list);
  }
  const blocks = Array.from(byFile.values()).map((lines) => lines.join('\n')).join('\n');
  return (
    `Deterministic verification found ${violations.length} motion violation(s) in the file(s) you just edited. ` +
    `Fix ONLY these — do not add features, do not rewrite sections, do not touch anything else:\n${blocks}\n\n` +
    `Rules: animate ONLY transform and opacity. Replace any box-shadow / background / background-position / ` +
    `filter / color / border-color / width / height / grid-template-rows used in @keyframes or transitions with ` +
    `transform/opacity equivalents (e.g. render a glow via a pseudo-element that scales and fades). For every ` +
    `classList.add('x') in the script, add a matching '.x' CSS rule. Use read_file to see the exact lines, then ` +
    `edit_file. When the listed items are fixed, stop — no summary.`
  );
}

/**
 * Forced retry when Lucifero finished without a successful write_file/edit_file.
 */
export async function* applyImplementationWriteRetry(args: {
  chairman: AgentRole;
  check: { ok: boolean; missing: string[] };
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  executableNames: ReadonlySet<string> | null;
  onToolCall?: () => void;
  onSuccessfulWrite?: () => void;
  onCouncilStatus?: (message: string) => void;
  /** v1.7.0 (Pass-2 agy finding): see applyCompletionRetry. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, void, void> {
  if (isCouncilCancelled(args.config.signal)) return;
  if (args.check.ok) return;
  if (!shouldRetryMember(['write_file'], 0)) return;
  const statusMsg = `[council] ${args.chairman.id} implementation write retry: ${args.check.missing.join(', ')}`;
  args.onCouncilStatus?.(statusMsg);
  // eslint-disable-next-line no-console
  console.warn(statusMsg);
  try {
    const retryGenerator = runRetryTurnForMember({
      agent: args.chairman,
      missingToolNames: ['read_file', 'write_file', 'edit_file'],
      minPerTool: { read_file: 3, edit_file: 8, write_file: 1 },
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
      retryPrompt: buildImplementationWriteRetryPrompt(args.userMessage),
      languageModule: args.languageModule,
      signal: args.config.signal,
    });
    for await (const event of retryGenerator) {
      if (event.type === 'tool_execution_start') args.onToolCall?.();
      if (
        event.type === 'tool_execution_end' &&
        !event.isError &&
        typeof event.result === 'string'
      ) {
        try {
          const parsed = JSON.parse(event.result) as {
            bytesWritten?: number;
            occurrencesReplaced?: number;
          };
          if (
            (parsed.bytesWritten ?? 0) > 0 ||
            (parsed.occurrencesReplaced ?? 0) > 0
          ) {
            args.onSuccessfulWrite?.();
          }
        } catch {
          if (event.result.includes('bytesWritten') || event.result.includes('occurrencesReplaced')) {
            args.onSuccessfulWrite?.();
          }
        }
      }
      yield event;
    }
  } catch (retryErr) {
    // eslint-disable-next-line no-console
    console.error(`[council] ${args.chairman.id} implementation write retry failed:`, retryErr);
  }
}

/** Max verify-driven delivery passes after the chairman turn (inline-js, motion, etc.). */
export const MAX_DELIVERY_ATTEMPTS = 2;

/**
 * Increment 5 — verify-driven delivery loop. Re-runs deterministic verification
 * and forces scoped chairman fix turns until blocking technical issues clear
 * or the attempt cap is hit.
 */
export async function* runChairmanDeliveryLoop(args: {
  chairman: AgentRole;
  projectRoot: string;
  changedFiles: Set<string>;
  executableNames: ReadonlySet<string> | null;
  sessionId: string;
  userMessage: string;
  agentOutputs: { name: string; role: string; content: string }[];
  config: PureCouncilConfig;
  effectiveProvider: string;
  effectiveModel: string;
  onToolCall?: () => void;
  maxAttempts?: number;
  onCouncilStatus?: (message: string) => void;
  /** v1.7.0 (Pass-2 agy finding): see applyCompletionRetry. */
  languageModule?: SystemPromptModule;
}): AsyncGenerator<BrainEvent, boolean, void> {
  const maxAttempts = args.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const zelariRoot = `${args.projectRoot}/.zelari`;
  let attempt = 0;
  while (attempt < maxAttempts) {
    if (isCouncilCancelled(args.config.signal)) return false;
    const report = runImplementationVerification({
      projectRoot: args.projectRoot,
      zelariRoot,
    });
    const blocking = filterDeliveryBlockingFails(report.results);
    if (blocking.length === 0) return true;
    if (blocking.some((b) => b.id === 'inline-js.budget')) {
      const jsFix = applyInlineJsAutofix(args.projectRoot, report);
      if (jsFix.applied) {
        args.onCouncilStatus?.(
          `[council] ${args.chairman.id} inline-js autofix: ${jsFix.fixes.join('; ')}`,
        );
        const afterJs = runImplementationVerification({
          projectRoot: args.projectRoot,
          zelariRoot,
        });
        if (filterDeliveryBlockingFails(afterJs.results).length === 0) return true;
      }
    }
    attempt++;
    const statusMsg = `[council] ${args.chairman.id} delivery pass ${attempt}/${maxAttempts}: ${blocking.map((b) => b.id).join(', ')}`;
    args.onCouncilStatus?.(statusMsg);
    // eslint-disable-next-line no-console
    console.warn(statusMsg);
    try {
      const fixGenerator = runRetryTurnForMember({
        agent: args.chairman,
        missingToolNames: ['read_file', 'edit_file'],
        minPerTool: { read_file: 3, edit_file: 10 },
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
        retryPrompt: buildDeliveryFixPrompt(blocking, args.userMessage),
        languageModule: args.languageModule,
        signal: args.config.signal,
      });
      for await (const event of fixGenerator) {
        if (event.type === 'tool_execution_start') args.onToolCall?.();
        yield event;
      }
    } catch (deliveryErr) {
      // eslint-disable-next-line no-console
      console.error(`[council] ${args.chairman.id} delivery pass ${attempt} failed:`, deliveryErr);
      break;
    }
    for (const rel of args.changedFiles) {
      for (const w of runChairmanMicroGate({ projectRoot: args.projectRoot, relPath: rel, zelariRoot })) {
        // refresh changed set — delivery may touch same targets
        args.changedFiles.add(w.file ?? rel);
      }
    }
  }
  const finalReport = runImplementationVerification({
    projectRoot: args.projectRoot,
    zelariRoot,
  });
  return filterDeliveryBlockingFails(finalReport.results).length === 0;
}
