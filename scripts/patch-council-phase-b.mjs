import { readFileSync, writeFileSync } from 'node:fs';

const path = 'packages/core/src/agents/councilApi.ts';
let s = readFileSync(path, 'utf8');

// 1) imports
const importAnchor =
  "} from '../council/verification/microGate.js';\r\n\r\n/**\r\n * Council members";
const importReplacement =
  "} from '../council/verification/microGate.js';\r\nimport {\r\n" +
  "  buildImplementationVerifyRetryPrompt,\r\n" +
  "  checkImplementationCompletion,\r\n" +
  "  resolveVerifyRetryTool,\r\n" +
  "} from '../council/verification/completion.js';\r\n\r\n/**\r\n * Council members";

if (!s.includes('checkImplementationCompletion')) {
  if (!s.includes(importAnchor)) {
    console.error('import anchor missing');
    process.exit(1);
  }
  s = s.replace(importAnchor, importReplacement);
}

// 2) runRetryTurnForMember optional retryPrompt
if (!s.includes('retryPrompt?:')) {
  const rpAnchor =
    "  runMode?: CouncilRunMode;\r\n}): AsyncGenerator<BrainEvent, string[], void> {";
  const rpReplacement =
    "  runMode?: CouncilRunMode;\r\n  /** Override the default buildRetryPrompt message. */\r\n" +
    "  retryPrompt?: string;\r\n}): AsyncGenerator<BrainEvent, string[], void> {";
  if (!s.includes(rpAnchor)) {
    console.error('retryPrompt anchor missing');
    process.exit(1);
  }
  s = s.replace(rpAnchor, rpReplacement);

  const msgAnchor =
    "    { role: 'user' as const, content: buildRetryPrompt(executableMissing) },\r\n  ];";
  const msgReplacement =
    "    {\r\n" +
    "      role: 'user' as const,\r\n" +
    "      content: args.retryPrompt ?? buildRetryPrompt(executableMissing),\r\n" +
    "    },\r\n  ];";
  s = s.replace(msgAnchor, msgReplacement);
}

// 3) applyCompletionRetry after applyRetryIfMissing
if (!s.includes('applyCompletionRetry')) {
  const fn = `
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
}): AsyncGenerator<BrainEvent, void, void> {
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
  console.warn(\`[council] \${args.agent.id} retrying missing verify tool: \${retryTool}\`);
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
    console.error(\`[council] \${args.agent.id} verify retry failed:\`, retryErr);
  }
  const after = checkImplementationCompletion(args.emittedToolNames);
  if (!after.ok) {
    // eslint-disable-next-line no-console
    console.warn(\`[council] \${args.agent.id} still missing verify after retry: \${after.reason}\`);
  }
}
`;
  const insertBefore = '// ── Post-condition tool emission check (v0.7.6) ────────────────────────────';
  if (!s.includes(insertBefore)) {
    console.error('insert anchor missing');
    process.exit(1);
  }
  s = s.replace(insertBefore, fn + insertBefore);
}

// 4) chairman loop — implementation completion retry
const chairAnchor =
  "    } else if (isDesignPhase) {\r\n" +
  "      enforceDesignPhaseToolEmissions(chairman.id, emittedToolNames);\r\n" +
  "    }\r\n" +
  "    const memberDuration = Date.now() - memberStart;";

const chairReplacement =
  "    } else if (isDesignPhase) {\r\n" +
  "      enforceDesignPhaseToolEmissions(chairman.id, emittedToolNames);\r\n" +
  "    } else if (!errored) {\r\n" +
  "      yield* applyCompletionRetry({\r\n" +
  "        agent: chairman,\r\n" +
  "        emittedToolNames,\r\n" +
  "        executableNames,\r\n" +
  "        sessionId,\r\n" +
  "        userMessage,\r\n" +
  "        agentOutputs,\r\n" +
  "        config,\r\n" +
  "        effectiveProvider,\r\n" +
  "        effectiveModel,\r\n" +
  "        onToolCall: () => { toolCalls += 1; },\r\n" +
  "      });\r\n" +
  "    }\r\n" +
  "    const memberDuration = Date.now() - memberStart;";

if (!s.includes('applyCompletionRetry({')) {
  if (!s.includes(chairAnchor)) {
    console.error('chairman anchor missing');
    process.exit(1);
  }
  s = s.replace(chairAnchor, chairReplacement);
}

writeFileSync(path, s);
console.log('patched councilApi phase B');
