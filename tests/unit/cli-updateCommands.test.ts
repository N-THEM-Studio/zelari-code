/**
 * /update slash command tests (Task N.4, v3-N).
 */

import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands';
import type { CodingSkillDefinition } from '@zelari/core/skills';

const emptySkills: CodingSkillDefinition[] = [];

describe('/update', () => {
  it('handles "/update" with kind update_check', () => {
    const result = handleSlashCommand('/update', emptySkills);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('update_check');
    expect(result.updateForce).toBe(false);
  });

  it('handles "/update --yes" with kind update_perform + force=true', () => {
    const result = handleSlashCommand('/update --yes', emptySkills);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('update_perform');
    expect(result.updateForce).toBe(true);
  });

  it('handles "/update -y" with kind update_perform + force=true (short form)', () => {
    const result = handleSlashCommand('/update -y', emptySkills);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('update_perform');
    expect(result.updateForce).toBe(true);
  });

  it('handles "/update something" with kind update_usage (unknown arg)', () => {
    const result = handleSlashCommand('/update something', emptySkills);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('update_usage');
    expect(result.message).toContain('Usage:');
  });
});