import type { AuditEntry } from './toolTypes.js';

/** In-memory audit log (last N entries). Persisting to disk is a follow-up. */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /** Return the last N entries (most recent last). */
  recent(n = 50): AuditEntry[] {
    return this.entries.slice(-n);
  }

  /** Filter by sessionId. */
  bySession(sessionId: string): AuditEntry[] {
    return this.entries.filter((e) => e.sessionId === sessionId);
  }

  clear(): void {
    this.entries = [];
  }
}
