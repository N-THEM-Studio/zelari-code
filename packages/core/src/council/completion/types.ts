export interface CompletionOpenFail {
  id: string;
  severity: string;
  message: string;
  tier?: string;
}

export interface CompletionTaskScope {
  targets: string[];
  keywords: string[];
  explicitOut: string[];
  nfrRelevant: boolean;
  sources: Array<'userMessage' | 'nfr-spec'>;
}

export interface CouncilCompletion {
  ok: boolean;
  readyToCommit: boolean;
  degraded: boolean;
  degradedReasons?: string[];
  /** Blocking check id prefixes (error severity). */
  blocking: string[];
  openFails: CompletionOpenFail[];
  verification?: { ok: boolean; ran: boolean };
  build?: { ok: boolean; ran: boolean; script?: string; exitCode?: number };
  tiers?: Record<string, string>;
  promptSummary?: string;
  /** v0.9.1 — what this run was asked to deliver (not full plan backlog). */
  scope?: CompletionTaskScope;
  generatedAt: string;
}
