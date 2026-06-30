// Shared context types for workspace and RAG functionality

export interface RagConfig {
  defaultTopK: number;
  minScoreThreshold: number;
  maxContextTokens: number;
}

export interface WorkspaceContext {
  projects: ProjectSummary[];
  ideas: IdeaSummary[];
  sessions: SessionSummary[];
  mindMaps: MindMapSummary[];
  recentActivities: ActivitySummary[];
}

export interface ProjectSummary {
  id: string;
  title: string;
  taskCount: number;
  status: string;
  phases: string[];
  milestones: string[];
  documents: number;
}

export interface IdeaSummary {
  id: string;
  title: string;
  category: string;
  tags: string[];
}

export interface SessionSummary {
  id: string;
  title: string;
  agentCount: number;
  messageCount: number;
}

export interface MindMapSummary {
  id: string;
  title: string;
  nodeCount: number;
}

export interface ActivitySummary {
  id: string;
  type: string;
  action: string;
  title: string;
  timestamp: number;
}

export interface EnrichedToolContext {
  workspaceId: string;
  currentSessionId?: string;
  currentProjectId?: string;
  sourcePage?: 'planner' | 'ideas' | 'mindmap' | 'council' | 'search';
  ragContext?: string;
  workspaceContext?: WorkspaceContext;
}
