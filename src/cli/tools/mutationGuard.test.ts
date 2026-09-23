/**
 * mutationGuard.test — G1 of the 2026-09-23 post-mortem remediation.
 *
 * Pure unit coverage of the consecutive-mutation-failure circuit breaker:
 * the exact threshold (4), BOTH counted failure shapes (structured reject via
 * `isError`, non-zero `exitCode`), the read-tool blind spot (neither
 * increment nor reset), the reset-on-landed-write rule, the tool
 * classification, and the parent-facing stop line.
 */
import { describe, expect, it } from 'vitest';
import {
  MUTATION_FAILURE_SAMPLE_MAX,
  MUTATION_FAILURE_THRESHOLD,
  createMutationGuard,
  exitCodeFromToolResult,
  formatMutationStop,
  isMutationFailure,
  isMutationTool,
  type MutationGuard,
  type MutationOutcome,
} from './mutationGuard.js';

/** Post-mortem shape #1: `write_file → EACCES: permission denied` (Windows). */
const EACCES: MutationOutcome = {
  tool: 'write_file',
  isError: true,
  detail: 'EACCES: permission denied, open Z:\\work\\src\\a.ts',
};

/** Post-mortem shape #2: `edit → stale_snapshot` against a stale anchor. */
const STALE: MutationOutcome = {
  tool: 'edit',
  isError: true,
  detail: 'edit: stale_snapshot: src/b.ts (expected aaaa1111, actual bbbb2222)',
};

/** A landed mutation. */
const WRITE_OK: MutationOutcome = { tool: 'write_file', isError: false, exitCode: null };

/** A read-only call — invisible to the counter by design. */
const READ: MutationOutcome = { tool: 'read_file', isError: true, detail: 'read failed too' };

function observeAll(guard: MutationGuard, outcomes: MutationOutcome[]) {
  return outcomes.map((o) => guard.observe(o));
}

describe('G1 (2026-09-23) — mutationGuard', () => {
  it('exposes the exact threshold constant (4)', () => {
    expect(MUTATION_FAILURE_THRESHOLD).toBe(4);
  });

  it('classifies the write family (native + mcp) and nothing else', () => {
    for (const tool of ['write_file', 'edit', 'edit_file', 'apply_diff']) {
      expect(isMutationTool(tool), tool).toBe(true);
    }
    for (const tool of [
      'mcp_filesystem_write_file',
      'mcp_filesystem_edit_file',
      'mcp_filesystem_move_file',
      'mcp_filesystem_create_directory',
    ]) {
      expect(isMutationTool(tool), tool).toBe(true);
    }
    for (const tool of ['read_file', 'grep_content', 'list_files', 'bash', 'exec_process', 'unknown', '']) {
      expect(isMutationTool(tool), tool).toBe(false);
    }
  });

  it('trips at the Nth consecutive failed mutation, not before (exact threshold)', () => {
    const guard = createMutationGuard();
    const verdicts = observeAll(guard, [EACCES, EACCES, STALE, STALE]);
    expect(verdicts[0]).toMatchObject({ mutationStorm: false, consecutiveFailures: 1, counted: true });
    expect(verdicts[1]).toMatchObject({ mutationStorm: false, consecutiveFailures: 2 });
    expect(verdicts[2]).toMatchObject({ mutationStorm: false, consecutiveFailures: 3 });
    expect(verdicts[MUTATION_FAILURE_THRESHOLD - 1]).toMatchObject({
      mutationStorm: true,
      consecutiveFailures: MUTATION_FAILURE_THRESHOLD,
    });
  });

  it('counts BOTH failure shapes: structured reject (isError) and exitCode≠0', () => {
    expect(isMutationFailure(EACCES)).toBe(true);
    expect(isMutationFailure(STALE)).toBe(true);
    expect(isMutationFailure({ tool: 'write_file', isError: false, exitCode: 3 })).toBe(true);
    expect(isMutationFailure(WRITE_OK)).toBe(false);
    expect(isMutationFailure({ tool: 'write_file', isError: false, exitCode: 0 })).toBe(false);

    const guard = createMutationGuard();
    const verdicts = observeAll(guard, [
      { tool: 'write_file', isError: false, exitCode: 1 },
      { tool: 'edit', isError: false, exitCode: 2 },
      EACCES,
      { tool: 'apply_diff', isError: true, detail: 'file_exists: x.ts' },
    ]);
    expect(verdicts[verdicts.length - 1]).toMatchObject({ mutationStorm: true, consecutiveFailures: 4 });
  });

  it('one landed mutation resets the streak (3 fails + ok + 3 fails never trips)', () => {
    const guard = createMutationGuard();
    const verdicts = observeAll(guard, [
      EACCES,
      EACCES,
      STALE,
      WRITE_OK,
      EACCES,
      STALE,
      EACCES,
    ]);
    expect(verdicts.every((v) => !v.mutationStorm)).toBe(true);
    expect(verdicts[2].consecutiveFailures).toBe(3);
    expect(verdicts[3]).toMatchObject({ mutationStorm: false, consecutiveFailures: 0, counted: true });
    expect(verdicts[verdicts.length - 1].consecutiveFailures).toBe(3);
  });

  it('read-only tools neither increment NOR reset (the storm survives interleaved reads)', () => {
    const guard = createMutationGuard();
    const verdicts = observeAll(guard, [EACCES, READ, STALE, READ, EACCES, STALE]);
    // The reads are not counted …
    expect(verdicts[1]).toMatchObject({ counted: false, consecutiveFailures: 1 });
    expect(verdicts[3]).toMatchObject({ counted: false, consecutiveFailures: 2 });
    // … and do not launder the streak: the 4th write failure still trips.
    expect(verdicts[verdicts.length - 1]).toMatchObject({
      mutationStorm: true,
      consecutiveFailures: MUTATION_FAILURE_THRESHOLD,
    });
  });

  it('keeps counting past the threshold (stopping is the caller\'s decision)', () => {
    const guard = createMutationGuard();
    observeAll(guard, [EACCES, EACCES, EACCES, EACCES]);
    const fifth = guard.observe(STALE);
    expect(fifth).toMatchObject({ mutationStorm: true, consecutiveFailures: 5 });
  });

  it('tracks the last failing sample and reset() forgets everything', () => {
    const guard = createMutationGuard();
    guard.observe(EACCES);
    expect(guard.observe(STALE).lastFailure).toMatchObject({ tool: 'edit' });
    guard.reset();
    expect(guard.observe(EACCES)).toMatchObject({ mutationStorm: false, consecutiveFailures: 1 });
  });

  it('caps the failure sample at MUTATION_FAILURE_SAMPLE_MAX', () => {
    const guard = createMutationGuard();
    const long: MutationOutcome = {
      tool: 'write_file',
      isError: true,
      detail: `EACCES: ${'x'.repeat(MUTATION_FAILURE_SAMPLE_MAX * 3)}`,
    };
    const verdict = guard.observe(long);
    expect(verdict.lastFailure?.detail?.length).toBe(MUTATION_FAILURE_SAMPLE_MAX);
  });

  it('exitCodeFromToolResult decodes the JSON ok channel and degrades to null on prose', () => {
    expect(exitCodeFromToolResult('{"exitCode":3,"stdout":""}')).toBe(3);
    expect(exitCodeFromToolResult('{"exitCode":0}')).toBe(0);
    expect(exitCodeFromToolResult('edit: stale_snapshot: src/b.ts (expected a, actual b)')).toBeNull();
    expect(exitCodeFromToolResult('{"exitCode":"3"}')).toBeNull();
    expect(exitCodeFromToolResult('')).toBeNull();
  });

  it('formats the parent-facing stop line (reason + count + last sample)', () => {
    const line = formatMutationStop({
      code: 'mutation_storm',
      consecutiveFailures: MUTATION_FAILURE_THRESHOLD,
      lastFailure: { tool: 'edit', detail: 'edit: stale_snapshot: src/b.ts' },
    });
    expect(line).toContain('mutation storm detected');
    expect(line).toContain('4 consecutive write-tool calls failed');
    expect(line).toContain('retry storm');
    expect(line).toContain('last: edit');
    expect(line).toContain('edit: stale_snapshot: src/b.ts');
  });
});
