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
export type { EnhancedToolDefinition } from '../types/systemTypes.js';
export {
  KRAKEN_IDENTITY_MODULE,
  KRAKEN_LEAD_PLAYBOOK_MODULE,
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
} from '../agents/systemPromptBuilder.js';
export type { BuildSystemPromptOptions } from '../agents/systemPromptBuilder.js';
export {
  detectResponseLanguage,
  resolveResponseLanguage,
  buildLanguageDirective,
  buildLanguagePolicyModule,
  buildLanguagePolicyModuleFor,
  LANGUAGE_POLICY_MODULE_TYPE,
} from '../agents/languagePolicy.js';
export type { SupportedLanguage } from '../agents/languagePolicy.js';
