/**
 * @zelari/core/types — public types.
 *
 * Re-exports all public types. The barrel was introduced in v0.5.0; the
 * historical types live in `legacy.ts` (the pre-monorepo `src/types/index.ts`
 * monolithic file). New types should go in focused files (`context.ts`,
 * `systemTypes.ts`, `knowledge.ts`) and be added to the export list below.
 */
export * from './context.js';
export * from './systemTypes.js';
export * from './knowledge.js';
// Legacy types (pre-monorepo monolithic types file). Kept here so that
// downstream code that imported `from '../types'` still resolves.
// Note: we re-export selectively because some types (FileTreeNode,
// SkillCategory) collide with types already in the focused files above.
export type {
  // Workspace + project
  Workspace,
  ProjectDocument,
  Project,
  Phase,
  Task,
  SubTask,
  Milestone,
  Idea,
  // Council
  CouncilSession,
  PlanPhase,
  PlanState,
  CouncilMessage,
  ToolCall,
  AgentRole,
  CustomSkill,
  // RAG
  RagDocument,
  RagChunk,
  SearchResult,
  // Settings
  AppSettings,
  ProviderConfig,
  AgentModelSelection,
  // Misc
  MindMapNode,
  MindMapEdge,
  MindMapData,
  IdeaCluster,
  McpServerConfig,
  CustomTool,
  WorkspaceAction,
  PermissionMode,
} from './legacy.js';
