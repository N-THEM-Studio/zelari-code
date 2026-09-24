/**
 * Skills — built-in coding skills (refactoring, testing, debugging, etc.)
 * plus the `SkillsRegistry` and `promoteMember` API for exporting roles.
 */
export * from '../agents/skills.js';
export * from '../agents/tools.js';
export * from '../agents/toolSchemas.js';
export * from '../agents/advancedTools.js';
export * from '../agents/vaultTools.js';
export { cliToolToEnhanced } from '../agents/harnessToolBridge.js';
export type { EnhancedToolDefinition, SystemPromptModule } from '../types/systemTypes.js';
export {
  KRAKEN_IDENTITY_MODULE,
  KRAKEN_LEAD_PLAYBOOK_MODULE,
  KRAKEN_SELECTION_PLAYBOOK_MODULE,
  SINGLE_AGENT_IDENTITY_MODULE,
  getBasePromptModules,
  CODING_PRACTICES_MODULE,
  NATIVE_TOOL_PROTOCOL_MODULE,
  CLARIFICATION_PROTOCOL_MODULE,
} from '../agents/promptModules.js';
export type { PromptPackMode, LegacyPromptPackMode } from '../agents/promptModules.js';
export {
  buildSystemPrompt,
  buildSystemPromptSplit,
  systemMessagesFromSplit,
  // M2.1 (cache-hit-rate plan): cache-first layout — volatile → ephemeral
  // trailing context after the history. `resolvePromptLayout` reads
  // ZELARI_PROMPT_LAYOUT once per process (frozen per session).
  resolvePromptLayout,
  resetPromptLayoutCache,
  assembleRequestMessages,
  trailingContextFromSplit,
  trailingContextMessagesFromSplit,
  isTrailingContextContent,
  wrapTrailingContext,
  PROMPT_LAYOUT_ENV,
  TRAILING_CONTEXT_OPEN_TAG,
  TRAILING_CONTEXT_CLOSE_TAG,
} from '../agents/systemPromptBuilder.js';
export type {
  BuildSystemPromptOptions,
  PromptLayout,
  PromptLayoutMessage,
} from '../agents/systemPromptBuilder.js';
export {
  detectResponseLanguage,
  resolveResponseLanguage,
  buildLanguageDirective,
  buildLanguagePolicyModule,
  buildLanguagePolicyModuleFor,
  buildLanguagePolicySplit,
  STABLE_LANGUAGE_DIRECTIVE,
  LANGUAGE_POLICY_MODULE_TYPE,
} from '../agents/languagePolicy.js';
export type { SupportedLanguage, LanguagePolicySplit } from '../agents/languagePolicy.js';
