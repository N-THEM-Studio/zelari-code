/**
 * evolution.test — deterministic classifier + append-only ledger (Fase 5 v0,
 * ADR-0036). Contract under test:
 *   - classifyTask is pure and ordered (same input ⇒ same class);
 *   - the ledger is a strict no-op while ZELARI_EVOLUTION != shadow;
 *   - replay is tolerant (corrupt lines skipped, never fatal).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendLedgerEntry,
  evolutionMode,
  LEDGER_REL,
  ledgerStats,
  ledgerPath,
  readLedger,
} from './ledger.js';
import { classifyTask } from './classifyTask.js';

const savedEvo = process.env.ZELARI_EVOLUTION;

afterEach(() => {
  if (savedEvo === undefined) delete process.env.ZELARI_EVOLUTION;
  else process.env.ZELARI_EVOLUTION = savedEvo;
});

describe('classifyTask', () => {
  it('applies ordered bilingual rules deterministically', () => {
    expect(classifyTask({ prompt: 'fix the regression in the parser' }).taskClass).toBe('bugfix');
    expect(classifyTask({ prompt: 'aggiungi test per il modulo' }).taskClass).toBe('tests');
    expect(classifyTask({ prompt: 'update README docs' }).taskClass).toBe('docs');
    expect(classifyTask({ prompt: 'rename and extract helpers' }).taskClass).toBe('refactor');
    expect(classifyTask({ prompt: 'add a new export function' }).taskClass).toBe('feature');
    expect(classifyTask({ prompt: '' }).taskClass).toBe('chore');
  });

  it('shape heuristics kick in when the prompt has no signal', () => {
    expect(classifyTask({ prompt: 'x', fileCount: 12 }).taskClass).toBe('refactor');
    expect(classifyTask({ prompt: 'x', diffLines: 900 }).taskClass).toBe('refactor');
    expect(classifyTask({ prompt: 'x', hasTests: true }).taskClass).toBe('tests');
    expect(classifyTask({ prompt: 'x' }).taskClass).toBe('feature');
  });

  it('reports the signals that fired', () => {
    const r = classifyTask({ prompt: 'fix crash', fileCount: 10, hasTests: true });
    expect(r.signals).toContain('prompt:bugfix');
    expect(r.signals).toContain('hasTests');
    expect(r.signals).toContain('wide-diff');
  });
});

describe('ledger', () => {
  it('is a no-op while evolution is off (default)', () => {
    delete process.env.ZELARI_EVOLUTION;
    expect(evolutionMode()).toBe('0');
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-evo-'));
    try {
      const res = appendLedgerEntry(dir, {
        runId: 'r1',
        at: new Date().toISOString(),
        mode: '0',
        taskClass: 'feature',
        verdict: 'PASS',
      });
      expect(res.written).toBe(false);
      expect(res.reason).toContain('ZELARI_EVOLUTION');
      expect(readLedger(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shadow mode appends, then replays tolerantly past a corrupt line', () => {
    process.env.ZELARI_EVOLUTION = 'shadow';
    expect(evolutionMode()).toBe('shadow');
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-evo-'));
    try {
      const r1 = appendLedgerEntry(dir, {
        runId: 'r1',
        at: '2026-01-01T00:00:00.000Z',
        mode: 'shadow',
        taskClass: 'bugfix',
        verdict: 'PASS',
        evidenceTier: 'command-output',
      });
      expect(r1.written).toBe(true);
      expect(appendLedgerEntry(dir, {
        runId: 'r2',
        at: '2026-01-02T00:00:00.000Z',
        mode: 'shadow',
        taskClass: 'docs',
        verdict: 'FAIL',
      }).written).toBe(true);

      // corrupt third line — tolerant replay must skip it
      const file = ledgerPath(dir);
      writeFileSync(file, `${readFileSync(file, 'utf8')}CORRUPT{{{\n`, 'utf8');

      const entries = readLedger(dir);
      expect(entries).toHaveLength(2);
      const stats = ledgerStats(entries);
      expect(stats.runs).toBe(2);
      expect(stats.byVerdict.PASS).toBe(1);
      expect(stats.byVerdict.FAIL).toBe(1);
      expect(stats.byClass.bugfix).toBe(1);
      expect(stats.byClass.docs).toBe(1);
      expect(stats.firstAt).toBe('2026-01-01T00:00:00.000Z');
      expect(stats.lastAt).toBe('2026-01-02T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ledger lives under .zelari/evolution/ (project-scoped)', () => {
    expect(LEDGER_REL).toContain(path.join('.zelari', 'evolution'));
  });
});
