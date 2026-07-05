/**
 * council-implementer-topology.test.ts
 *
 * Increment 1 of the reliable-verification architecture: in implementation mode
 * only the chairman (Lucifero) writes files; specialists + Minosse are advisors
 * (read-only). This removes the multi-writer chaos where every member edits the
 * same files, and makes `luciferWriteCount` reflect reality (so the DEGRADED_RUN
 * "Lucifero wrote no files" false positive disappears when Lucifero implements).
 *
 * @see docs/plans/2026-07-05-council-reliable-verification-architecture.md
 */
import { describe, it, expect } from 'vitest';
import {
  councilModeBanner,
  restrictImplementationWrites,
  MUTATING_PROJECT_TOOLS,
  IMPLEMENTATION_MODE_BANNER,
  IMPLEMENTATION_IMPLEMENTER_BANNER,
  IMPLEMENTATION_ADVISOR_BANNER,
  DESIGN_PHASE_MODE_BANNER,
} from '@zelari/core/council';

describe('councilModeBanner — role-aware implementation banner', () => {
  it('returns the implementer banner for the chairman', () => {
    expect(councilModeBanner('implementation', { isImplementer: true }))
      .toBe(IMPLEMENTATION_IMPLEMENTER_BANNER);
  });

  it('returns the advisor banner for specialists / Minosse', () => {
    const banner = councilModeBanner('implementation', { isImplementer: false });
    expect(banner).toBe(IMPLEMENTATION_ADVISOR_BANNER);
    expect(banner).toMatch(/do NOT write or edit project files/i);
    expect(banner).toMatch(/sole implementer/i);
  });

  it('falls back to the legacy generic banner when role is unspecified', () => {
    // Backward compatibility for callers that don't distinguish roles.
    expect(councilModeBanner('implementation')).toBe(IMPLEMENTATION_MODE_BANNER);
  });

  it('design-phase ignores isImplementer', () => {
    expect(councilModeBanner('design-phase', { isImplementer: true }))
      .toBe(DESIGN_PHASE_MODE_BANNER);
    expect(councilModeBanner('design-phase', { isImplementer: false }))
      .toBe(DESIGN_PHASE_MODE_BANNER);
  });
});

describe('restrictImplementationWrites — one implementer in implementation mode', () => {
  const tools = ['read_file', 'grep_content', 'list_files', 'write_file', 'edit_file', 'bash'];

  it('strips write/edit for advisors in implementation mode', () => {
    const out = restrictImplementationWrites(tools, {
      runMode: 'implementation',
      isImplementer: false,
    });
    expect(out).not.toContain('write_file');
    expect(out).not.toContain('edit_file');
    // Read/inspect tools survive.
    expect(out).toEqual(expect.arrayContaining(['read_file', 'grep_content', 'list_files', 'bash']));
  });

  it('keeps the full set for the implementer (chairman)', () => {
    const out = restrictImplementationWrites(tools, {
      runMode: 'implementation',
      isImplementer: true,
    });
    expect(out).toEqual(tools);
  });

  it('keeps the full set in design-phase regardless of role', () => {
    expect(restrictImplementationWrites(tools, { runMode: 'design-phase', isImplementer: false }))
      .toEqual(tools);
  });

  it('is a no-op when there are no mutating tools', () => {
    const readOnly = ['read_file', 'grep_content'];
    expect(restrictImplementationWrites(readOnly, { runMode: 'implementation', isImplementer: false }))
      .toEqual(readOnly);
  });

  it('MUTATING_PROJECT_TOOLS lists the file mutators', () => {
    expect(MUTATING_PROJECT_TOOLS).toContain('write_file');
    expect(MUTATING_PROJECT_TOOLS).toContain('edit_file');
  });
});
