export type LessonTier = 'advisory' | 'enforced';

export interface LessonRecord {
  id: string;
  /** Normalized tokens for recurrence matching. */
  signature: string;
  checkId: string;
  /** Methodology guidance — not task-specific answers. */
  methodology: string;
  tier: LessonTier;
  keywords: string[];
  recurrence: number;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureFailureResult {
  captured: boolean;
  rejected?: boolean;
  reason?: string;
  lesson?: LessonRecord;
}

export interface RecallLessonsOptions {
  maxLessons?: number;
  maxBytes?: number;
  /** User task text for keyword overlap scoring. */
  taskText?: string;
}
