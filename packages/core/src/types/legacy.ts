export interface Workspace {
  id: string;
  name: string;
  description: string;
  templateId?: string;
  /** Optional path to a local git repository folder (for git IPC features). */
  path?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDocument {
  id: string;
  title: string;
  content: string;
  type: 'requirements' | 'architecture' | 'spec' | 'notes' | 'reference' | 'other';
  createdAt: number;
}

export interface Project {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: 'planning' | 'in-progress' | 'completed' | 'on-hold';
  phases: Phase[];
  tasks: Task[];
  milestones: Milestone[];
  documents: ProjectDocument[];
  aiNotes: string;
  markdownContent: string;
  createdAt: number;
  updatedAt: number;
}

export interface Phase {
  id: string;
  name: string;
  description: string;
  order: number;
  color: string;
  progress: number;
}

export interface Task {
  id: string;
  phaseId?: string;
  parentId?: string;
  title: string;
  description: string;
  status: 'todo' | 'in-progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  dueDate?: string;
  dependsOn: string[];
  subtasks: SubTask[];
  createdAt: number;
}

export interface SubTask {
  id: string;
  title: string;
  done: boolean;
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  phaseId?: string;
  dueDate?: string;
  completed: boolean;
}

export interface Idea {
  id: string;
  workspaceId: string;
  title: string;
  content: string;
  tags: string[];
  category: string;
  clusterId?: string;
  score?: number;
  parentIdeaId?: string;
  createdAt: number;
}

export interface IdeaCluster {
  id: string;
  name: string;
  color: string;
  ideaIds: string[];
}

export interface MindMapNode {
  id: string;
  label: string;
  content: string;
  type: 'root' | 'branch' | 'leaf' | 'rag';
  color: string;
  sourceId?: string;
  sourceType?: 'idea' | 'task' | 'document';
  x?: number;
  y?: number;
}

export interface MindMapEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  strength?: number;
}

export interface MindMapData {
  id: string;
  workspaceId: string;
  title: string;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
  createdAt: number;
  updatedAt: number;
}

export interface CouncilSession {
  id: string;
  workspaceId: string;
  title: string;
  topic: string;
  messages: CouncilMessage[];
  debateMode: boolean;
  /** Optional plan state — when set, PlanProgressPanel and PlanCard are shown. */
  plan?: PlanState;
  createdAt: number;
  updatedAt: number;
}

export interface PlanPhase {
  id: string;
  title: string;
  status: 'pending' | 'in-progress' | 'completed';
}

export interface PlanState {
  id: string;
  title: string;
  phases: PlanPhase[];
  createdAt: number;
}

export interface CouncilMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  agentColor?: string;
  thinking?: string;
  activeToolCalls?: string[];
  toolCalls?: ToolCall[];
  isReview?: boolean;
  isSynthesis?: boolean;
  /** Marks a structured plan message rendered as a PlanCard. */
  isPlan?: boolean;
  /** Optional embedded plan state — when set, PlanProgressPanel shows. */
  plan?: PlanPhase[];
  /** True when the user has approved the plan and execution started. */
  approvedByUser?: boolean;
  /** This message is a clarifying question from an agent awaiting the user. */
  isClarification?: boolean;
  /** Predefined options offered to the user in a clarifying question. */
  clarificationChoices?: string[];
  /** Optional context/reason explaining why the agent is asking. */
  clarificationContext?: string;
  /** True once the user has answered this clarifying question. */
  clarificationAnswered?: boolean;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface AgentRole {
  id: string;
  name: string;
  codename: string;
  role: string;
  color: string;
  avatar: string;
  /** Always-on role prompt (persona + methodology). */
  systemPrompt: string;
  /**
   * Appended only when council `runMode === 'design-phase'`.
   * Keeps createPlan / createDocument mandatories out of implementation turns.
   */
  designPhaseAddendum?: string;
  /**
   * Appended only when council `runMode === 'implementation'`.
   */
  implementationAddendum?: string;
  tools: string[];
  /**
   * Skill IDs from the skill catalog (see agents/skills.ts) that this agent
   * has enabled. Each skill injects a prompt fragment and declares required
   * tools, which the systemPromptBuilder merges into the final prompt.
   */
  skills?: string[];
}

export interface RagDocument {
  id: string;
  workspaceId: string;
  content: string;
  metadata: Record<string, string>;
  keywords: string[];
  sourceType: 'idea' | 'task' | 'project' | 'note' | 'file' | 'milestone' | 'document' | 'session' | 'mindmap' | 'vault';
  sourceId: string;
  createdAt: number;
}

export interface RagChunk {
  id: string;
  documentId: string;
  content: string;
  keywords: string[];
  position: number;
}

export interface SearchResult {
  id: string;
  type: 'task' | 'idea' | 'node' | 'file' | 'message';
  title: string;
  content: string;
  score: number;
  highlight: string;
  metadata: Record<string, string>;
}

export interface AppSettings {
  apiKey: string;
  glmApiKey: string;
  /** Active provider id (built-in or custom — see `providers`). */
  provider: string;
  model: string;
  councilSize: number;
  debateMode: boolean;
  activeWorkspaceId: string;
  /** Persisted last-selected project for the active workspace. */
  activeProjectId?: string | null;
  theme: 'dark' | 'light';
  grokClientId?: string; // configurable for xAI OAuth
  /** Configurable GitHub OAuth App client id (see Settings). */
  githubClientId?: string;
  /** Council agent permission mode (controls what tools agents may run). */
  permissionMode?: PermissionMode;
  /**
   * Configurable provider registry. Built-in providers (minimax, glm, grok)
   * are always available via their built-in ids; entries here add custom
   * OpenAI- or Anthropic-compatible endpoints the user can address.
   */
  providers?: ProviderConfig[];
  /**
   * Per-agent model override. Key is agent id (e.g. 'charont', 'lucifer').
   * Value is a { providerId, model } pair, where providerId can be a built-in
   * or a custom provider id. Falls back to the global `provider` + `model`.
   */
  agentModels?: Record<string, AgentModelSelection>;
  /** User-defined skills. Injected into the agent prompt as system fragments. */
  customSkills?: CustomSkill[];
  /** User-defined tools (workspace actions or HTTP calls). */
  customTools?: CustomTool[];
  /** User-defined MCP server configs (HTTP transport). */
  mcpServers?: McpServerConfig[];
  /** Globally-disabled tool names (blacklist across all agents and runs). */
  disabledTools?: string[];
}

/** Configurable LLM provider (built-in or custom). */
export interface ProviderConfig {
  /** Unique stable id (e.g. 'minimax', 'glm', 'grok', or a custom uuid). */
  id: string;
  /** Display name (e.g. "Z.ai", "DeepSeek"). */
  label: string;
  /** Full chat completions URL. */
  baseUrl: string;
  /** How to authenticate against the endpoint. */
  authStyle: 'openai' | 'anthropic';
  /** User-defined list of model ids the user can pick from. */
  models: string[];
  /** Whether this is a built-in provider (cannot be deleted; default model locked). */
  builtin?: boolean;
  /** Suggested default model id (the first model in `models` is used if absent). */
  defaultModel?: string;
  /** Optional extra config (e.g. extra headers). Unused for now. */
  // extras?: Record<string, string>;
}

/** A model selection that can be assigned to a single council agent. */
export interface AgentModelSelection {
  /** Provider id (built-in or custom). */
  providerId: string;
  /** Model id within that provider. */
  model: string;
}

/** How much autonomy the council agents have over workspace mutations. */
export type PermissionMode = 'read' | 'ask' | 'full';

// ─────────────── Custom skills + tools + MCP ───────────────

export type SkillCategory =
  | 'writing' | 'analysis' | 'project' | 'ideas' | 'mindmap' | 'vault' | 'custom';

/** A user-defined skill. Injects a system-prompt fragment into the agent's
 *  prompt and may require a set of tools (builtin or custom). */
export interface CustomSkill {
  id: string;
  name: string;
  description: string;
  /** Markdown text appended to the agent's prompt when this skill is active. */
  systemPromptFragment: string;
  /** Tool names this skill requires. May reference builtin or custom tools. */
  requiredTools: string[];
  category: SkillCategory;
  enabled: boolean;
  color: string;
  /** Optional list of agent ids that this skill auto-attaches to. */
  autoAttachTo?: string[];
}

/** A user-defined tool. The execution model is intentionally narrow for safety:
 *  either a structured workspace action (e.g. addTask) or an HTTP call with a
 *  declared schema. Arbitrary JS execution is not allowed. */
export interface CustomTool {
  id: string;
  /** Globally unique tool name (used as function-call target). */
  name: string;
  description: string;
  /** JSON Schema for parameters. */
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required: string[];
  };
  kind: 'workspace-action' | 'http';
  /** For kind: 'workspace-action', the structured action to run. */
  action?: WorkspaceAction;
  /** For kind: 'http', the HTTP endpoint to call. */
  http?: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string> };
  enabled: boolean;
}

/** Structured workspace mutations available to custom tools. */
export type WorkspaceAction =
  | { name: 'addTask'; args: { title: string; description?: string; priority?: string; phaseId?: string } }
  | { name: 'addIdea'; args: { title: string; content?: string; tags?: string[]; category?: string } }
  | { name: 'addDocument'; args: { title: string; content: string; path?: string; tags?: string[] } }
  | { name: 'addActivity'; args: { type: string; action: string; title: string } }
  | { name: 'searchRAG'; args: { query: string; topK?: number } };

/**
 * A user-defined MCP server (HTTP/SSE transport).
 *
 * SECURITY: `auth` carries only **non-secret** metadata (type, header NAME).
 * Bearer tokens and custom header VALUES are stored in the OS keychain
 * (key `mcp:<id>`) and fetched at invocation time by the main process. They
 * must NEVER be persisted in the `settings` SQLite blob.
 */
export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  auth: {
    type: 'none' | 'bearer' | 'header';
    /** Optional inline secret (only present in-session, before keychain write). */
    token?: string;
    /** Non-secret header name for 'header' auth. */
    headerName?: string;
    /** Optional inline secret (only present in-session, before keychain write). */
    headerValue?: string;
  };
  enabled: boolean;
  /** Cached discovery (refreshed on connect). */
  discovered: { tools: McpTool[]; lastRefreshed: number } | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

/** A tool exposed by a connected MCP server. */
export interface McpTool {
  /** Globally unique name: `mcp_<serverId>_<originalName>`. */
  name: string;
  description: string;
  /** JSON Schema for arguments. */
  inputSchema: object;
  serverId: string;
  /** Original tool name as exposed by the MCP server (without prefix). */
  originalName: string;
}

/** Result of invoking an MCP tool. */
export interface McpToolResult {
  ok: boolean;
  content?: Array<{ type: 'text' | 'json'; text?: string; data?: unknown }>;
  error?: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  phases: Omit<Phase, 'id'>[];
  tasks: Omit<Task, 'id' | 'createdAt' | 'subtasks' | 'dependsOn'>[];
  ideas: Omit<Idea, 'id' | 'workspaceId' | 'createdAt'>[];
  mindMapNodes: Omit<MindMapNode, 'id'>[];
  mindMapEdges: Omit<MindMapEdge, 'id'>[];
}

export interface ActivityItem {
  id: string;
  type: 'task' | 'idea' | 'mindmap' | 'council' | 'project';
  action: string;
  title: string;
  timestamp: number;
}

export interface DashboardMetrics {
  totalTasks: number;
  completedTasks: number;
  totalIdeas: number;
  totalNodes: number;
  totalSessions: number;
  recentActivity: ActivityItem[];
  phaseProgress: { name: string; progress: number; color: string }[];
}


export interface FileTreeNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileTreeNode[];
  content?: string;
}

export interface ProjectCard {
  id: string;
  title: string;
  description: string;
  prd?: string; // Comprehensive PRD document from AI extraction
  tasks: Task[];
  milestones: Milestone[];
  ideas: Idea[];
  fileTree: FileTreeNode[];
  createdAt: number;
  sourceSessionId: string;
}

export type {
  KnowledgeDocument,
  DocumentFolder,
  DocumentFormat,
  Frontmatter,
  WikiLink,
  KnowledgeTag,
  BacklinkEntry,
} from './knowledge.js';
