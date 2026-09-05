/**
 * memberMessages — per-member system/user message construction, extracted
 * verbatim from agents/councilApi.ts.
 */
import type { AgentRole } from '../../types/index.js';
import type { AgentMessage } from '../../core/AgentHarness.js';
import type { SystemPromptConfig, SystemPromptModule } from '../../types/systemTypes.js';
import type { CouncilRunMode } from '../../council/runMode.js';
import { resolveRoleSystemPrompt } from '../roles.js';
import { buildSystemPromptSplit, computeAgentTools } from '../systemPromptBuilder.js';
import { getAllTools } from '../tools.js';
import { councilModeBanner } from '../../council/modeBanners.js';

/**
 * Tools that mutate project files. In implementation-mode council runs only the
 * chairman (Lucifero) implements; specialists + Minosse analyze and hand off.
 * We strip these from every non-implementer so multiple agents never edit the
 * same files (multi-writer chaos) and "who implemented" stays unambiguous.
 * Note: specialists inherit write tools via skill `requiredTools`, so this must
 * filter the RESULT of computeAgentTools, not just the declared role tools.
 */
export const MUTATING_PROJECT_TOOLS: readonly string[] = ['write_file', 'edit_file'];

/**
 * Remove file-mutating tools for non-implementer members in implementation mode.
 * Design-phase and the implementer (chairman) keep the full set unchanged.
 */
export function restrictImplementationWrites(
  toolNames: string[],
  opts: { runMode: CouncilRunMode; isImplementer: boolean },
): string[] {
  if (opts.runMode !== 'implementation' || opts.isImplementer) return toolNames;
  return toolNames.filter((t) => !MUTATING_PROJECT_TOOLS.includes(t));
}

/** @internal */
export function buildAgentMessages(
  agent: AgentRole,
  userMessage: string,
  ragContext: string,
  workspaceContext: string,
  priorOutputs: { name: string; role: string; content: string }[],
  aiConfig?: SystemPromptConfig,
  executableTools?: ReadonlySet<string> | null,
  runMode: CouncilRunMode = 'implementation',
  languageModule?: SystemPromptModule,
): AgentMessage[] {
  // v0.7.5: the AVAILABLE TOOLS prompt block must match the schemas the
  // harness actually advertises. The v0.7.3 fix filtered the schemas
  // (filterExecutable) but NOT this prompt text, so members still read
  // "searchRAG: search the knowledge base…" in their system prompt and
  // called it — every call a guaranteed "Tool not found" (live test
  // 2026-07-03, /council in Z:\EasyPeasy\test).
  const allToolNames = computeAgentTools(agent, aiConfig);
  const toolNames = executableTools
    ? allToolNames.filter((n) => executableTools.has(n))
    : allToolNames;

  // Merge language policy into custom modules so every primary council turn
  // gets it (retries previously received the arg but never used it).
  const mergedAiConfig: SystemPromptConfig | undefined = languageModule
    ? {
        enabledSkills: aiConfig?.enabledSkills ?? [],
        enabledTools: aiConfig?.enabledTools ?? [],
        agentSkillConfigs: aiConfig?.agentSkillConfigs ?? [],
        customSkills: aiConfig?.customSkills,
        customPromptModules: [
          ...(aiConfig?.customPromptModules ?? []),
          languageModule,
        ],
      }
    : aiConfig;

  // Mode-split: design mandatories only when runMode is design-phase.
  const modeAwareAgent = {
    ...agent,
    systemPrompt: resolveRoleSystemPrompt(agent, runMode),
  };

  // Cache-efficient split (Cache Wars): stable = identity/tools/role;
  // volatile = workspace/RAG; banners stay trailing system msgs (volatile).
  const split = buildSystemPromptSplit(modeAwareAgent, {
    tools: getAllTools(),
    toolNames,
    aiConfig: mergedAiConfig,
    workspaceContext,
    ragContext,
    mode: 'council',
    includeWorkspaceInPrompt: true,
  });
  const messages: AgentMessage[] = [
    { role: 'system', content: split.stable },
  ];
  if (split.volatile.trim()) {
    messages.push({ role: 'system', content: split.volatile });
  }
  messages.push(
    { role: 'system', content: councilModeBanner(runMode, { isImplementer: agent.id === 'lucifer' }) },
    { role: 'system', content: 'IMPORTANT: Before making any tool calls or expensive operations, check if the information already exists in the shared context from previous agents. Avoid redundant work.' },
  );
  if (priorOutputs.length > 0) {
    // Cap each prior member blob so one verbose specialist cannot saturate
    // downstream members (chairman especially). Full text is not product law.
    const MAX_PRIOR_CHARS = 2800;
    const summary = priorOutputs
      .map((o) => {
        const body =
          o.content.length > MAX_PRIOR_CHARS
            ? `${o.content.slice(0, MAX_PRIOR_CHARS)}\n… [truncated ${o.content.length}→${MAX_PRIOR_CHARS} chars; treat as hypothesis]`
            : o.content;
        return `[${o.name} - ${o.role}]: ${body}`;
      })
      .join('\n\n');
    messages.push({
      role: 'user',
      content:
        `Previous council members have said (hypotheses — prefer product files on disk if they conflict):\n${summary}\n\n` +
        `Original user request: ${userMessage}`,
    });
  } else {
    messages.push({ role: 'user', content: userMessage });
  }
  return messages;
}
