/**
 * workspace/types.ts — TypeScript types for the CLI workspace.
 *
 * The workspace is a `.zelari/` directory at the project root that
 * persists council output (execution plan, ADRs, reviews, risks, docs)
 * in a coding-flavor way. Each artifact is a Markdown file with YAML
 * frontmatter for typed metadata.
 */

/** Frontmatter metadata for execution plan items (phases + tasks + milestones). */
export interface PlanFrontmatter {
  /** Artifact kind discriminator. */
  kind: 'phase' | 'task' | 'milestone';
  /** Stable id (uuid or slug). */
  id: string;
  /** Human-readable title (phases, tasks, milestones). */
  name?: string;
  /** Short description / context. */
  description?: string;
  /** Phase id (tasks only). */
  phaseId?: string;
  /** Order within its container. */
  order?: number;
  /** Hex color (phases only). */
  color?: string;
  /** Status (tasks only). */
  status?: 'pending' | 'in_progress' | 'done' | 'blocked';
  /** Priority (tasks only). */
  priority?: 'low' | 'medium' | 'high' | 'critical';
  /** Target version (milestones only). */
  targetVersion?: string;
  /** Due date (milestones only, ISO 8601). */
  dueDate?: string;
  /** Tags for filtering. */
  tags?: string[];
}

/** Body of a phase artifact. */
export interface PhaseBody {
  goal: string;
  exitCriterion: string;
  tasks: string[]; // task ids
}

/** Body of a task artifact. */
export interface TaskBody {
  title: string;
  description: string;
  fileRefs: string[];
  acceptance: string[];
  qaScenario: string;
}

/** Body of a milestone artifact. */
export interface MilestoneBody {
  title: string;
  description: string;
  acceptance: string[];
}

/** A phase/task/milestone file = frontmatter + body. */
export interface PlanItem<TBody> {
  meta: PlanFrontmatter;
  body: TBody;
}

/** ADR (Architecture Decision Record) — used by `addIdea` stub. */
export interface AdrFrontmatter {
  kind: 'adr';
  /** Status: `proposed` (council just agreed), `accepted` (chairman confirmed), `superseded` (newer ADR). */
  status: 'proposed' | 'accepted' | 'superseded';
  /** Stable id (`001-jwt-rotation`). */
  id: string;
  /** ISO date. */
  date: string;
  /** Tags for grouping. */
  tags?: string[];
  /** Related artifact ids (decision, plan item, doc). */
  related?: string[];
}

export interface AdrBody {
  /** Short context (why we needed to decide). */
  context: string;
  /** The decision itself. */
  decision: string;
  /** Trade-offs / consequences (positive + negative). */
  consequences: string[];
}

/** Risk register entry. */
export interface RiskFrontmatter {
  kind: 'risk';
  id: string;
  /** Severity: info (open question) | low | medium | high | critical. */
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  date: string;
  tags?: string[];
}

export interface RiskBody {
  title: string;
  description: string;
  /** Mitigation strategy (empty if info-only). */
  mitigation: string;
}

/** Code review artifact (produced by Oracle). */
export interface ReviewFrontmatter {
  kind: 'review';
  id: string;
  date: string;
  /** Verdict: approved, changes_requested, rejected. */
  verdict: 'approved' | 'changes_requested' | 'rejected';
  /** Target (file, feature, commit). */
  target: string;
  /** Related artifacts (decisions, docs, plan items). */
  related?: string[];
}

export interface ReviewBody {
  /** Summary (1-2 sentences). */
  summary: string;
  /** Checklist items: description + status. */
  checklist: Array<{ item: string; status: 'pass' | 'fail' | 'note'; note?: string }>;
  /** Required changes (if verdict = changes_requested). */
  requiredChanges: string[];
}

/** Doc artifact (drafts from `createDocument`). */
export interface DocFrontmatter {
  kind: 'doc';
  id: string;
  date: string;
  tags?: string[];
  related?: string[];
}

export interface DocBody {
  title: string;
  /** Markdown body. */
  content: string;
}

/** Workspace ctx passed to every stub tool. */
export interface WorkspaceContext {
  /** Absolute path to `.zelari/`. */
  rootDir: string;
  /** Project root (for relative path resolution). */
  projectRoot: string;
  /** Storage primitives. */
  storage: import('./storage.js').Storage;
}