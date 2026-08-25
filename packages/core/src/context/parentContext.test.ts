/**
 * parentContext.test — role-gated parent summary for tentacles (§51).
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../core/AgentHarness.js';
import { parentContextForRole } from './parentContext.js';

const LONG_TOOL_OUTPUT = 'line\n'.repeat(500);

function transcript(): AgentMessage[] {
  return [
    { role: 'system', content: 'LEAD SYSTEM PROMPT — must never leak to children' },
    { role: 'user', content: 'Fix the auth refresh loop in src/auth/session.ts' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc1', name: 'read_file', args: { path: 'src/auth/session.ts' } }],
    },
    { role: 'tool', toolCallId: 'tc1', content: LONG_TOOL_OUTPUT },
    { role: 'assistant', content: 'The refresh token is rotated twice; suspect double-call.' },
    { role: 'user', content: 'Delegate the fix to a general tentacle.' },
  ];
}

describe('parentContextForRole', () => {
  it('explore gets a block (policy includeParentSummary=true)', () => {
    const res = parentContextForRole('explore', transcript());
    expect(res).not.toBeNull();
    expect(res!.block).toContain('[Parent agent context — projected summary]');
    expect(res!.stats.sourceMessages).toBe(5);
  });

  it('lead gets null (policy includeParentSummary=false)', () => {
    expect(parentContextForRole('lead', transcript())).toBeNull();
  });

  it('unknown role falls back to the neutral policy → no parent summary', () => {
    expect(parentContextForRole('some-random-role', transcript())).toBeNull();
  });

  it('empty transcript → null', () => {
    expect(parentContextForRole('explore', [])).toBeNull();
  });

  it('never leaks the parent system prompt', () => {
    const res = parentContextForRole('explore', transcript());
    expect(res!.block).not.toContain('LEAD SYSTEM PROMPT');
  });

  it('tool results are summarized, not shipped in full', () => {
    const res = parentContextForRole('explore', transcript());
    // 2500 chars of tool output must not appear verbatim.
    expect(res!.block).not.toContain(LONG_TOOL_OUTPUT.slice(0, 2500));
    expect(res!.block.length).toBeLessThan(3000);
  });

  it('respects maxBlockChars with a truncation marker', () => {
    const res = parentContextForRole('general', transcript(), { maxBlockChars: 200 });
    expect(res).not.toBeNull();
    expect(res!.block).toContain('truncated to fit the role budget');
    expect(res!.block.length).toBeLessThan(400);
  });

  it('verify role also gets a block (policy on)', () => {
    expect(parentContextForRole('verify', transcript())).not.toBeNull();
  });
});
