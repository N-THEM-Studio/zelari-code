/**
 * tools/eval/resultStore.ts — file-based eval result store (2.6, doc §17).
 * No database until volumes demand one:
 *
 *   eval/results/<manifestHash>/summary.json
 *   eval/results/<manifestHash>/anchors.jsonl
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AnchorRunRecord } from './types.ts';
import type { HarnessEvalResult } from './regressionGate.ts';

export interface EvalSummaryRecord {
  manifestHash: string;
  recordedAt: string;
  gateDecision?: 'COMMIT' | 'REJECT';
  gateReasons?: string[];
  result: HarnessEvalResult;
}

export class EvalResultStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  static default(): EvalResultStore {
    return new EvalResultStore(path.resolve(import.meta.dirname, '../../eval/results'));
  }

  dirFor(manifestHash: string): string {
    return path.join(this.rootDir, manifestHash);
  }

  /** Persist one run (append-only anchors.jsonl + idempotent summary). */
  saveRun(record: AnchorRunRecord, summary?: EvalSummaryRecord): void {
    const dir = this.dirFor(record.harnessManifestHash || 'unknown');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'anchors.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    if (summary) {
      writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    }
  }

  /** Load every anchor record recorded for a manifest (replay-friendly). */
  loadRuns(manifestHash: string): AnchorRunRecord[] {
    const file = path.join(this.dirFor(manifestHash), 'anchors.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AnchorRunRecord);
  }

  loadSummary(manifestHash: string): EvalSummaryRecord | undefined {
    const file = path.join(this.dirFor(manifestHash), 'summary.json');
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as EvalSummaryRecord;
  }
}
