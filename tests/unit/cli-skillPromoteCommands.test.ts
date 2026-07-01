/**
 * /promote-member slash command tests.
 * Pure parser tests — no I/O, no persistence.
 */

import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands';
import type { CodingSkillDefinition } from '@zelari/core/skills';

const emptySkills: CodingSkillDefinition[] = [];

describe('/promote-member', () => {
  it('handles "/promote-member geryon" with kind promote_member + memberId', () => {
    const result = handleSlashCommand('/promote-member geryon', emptySkills);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('promote_member');
    expect(result.promoteMemberId).toBe('geryon');
    expect(result.promoteMemberError).toBeUndefined();
  });

  it('handles "/promote-member" (no arg) with kind promote_member_error + usage message', () => {
    const result = handleSlashCommand('/promote-member', emptySkills);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('promote_member_error');
    expect(result.promoteMemberId).toBeUndefined();
    expect(result.promoteMemberError).toContain('Usage:');
    expect(result.promoteMemberError).toContain('geryon');
  });

  it('echoes the id verbatim — dispatcher does full validation (UnknownMemberError)', () => {
    // The parser is permissive: any string after the command is treated as the
    // member id. Full validation (UnknownMemberError) happens in the
    // dispatcher via promoteMember(). This keeps the parser pure.
    const result = handleSlashCommand('/promote-member zaphod', emptySkills);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('promote_member');
    expect(result.promoteMemberId).toBe('zaphod');
  });
});