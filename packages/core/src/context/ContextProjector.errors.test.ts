/**
 * ContextProjector.errors.test.ts — K4.3/F25: the judge SEES failures.
 *
 * Red-if-reopens: F25 was "blind verifier" — with `toolResults: 'summary-only'`
 * a tentacle judge saw ONLY the first line of a tool result (`summarizeToolResult`
 * first-line-only), so the actual error detail never reached the agent that
 * must decide the verdict. If the projection ever collapses failing results
 * to one line again, these tests fail first.
 *
 * Locks:
 * - summary-only + failing result ⇒ full payload up to the cap, never first-line;
 * - failing result beyond the cap ⇒ head AND tail kept, truncation marked;
 * - SUCCESSFUL results keep the cheap one-line summary (no budget regression);
 * - typed guard codes (e.g. tool_args_parse_failed) count as failures too.
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../core/AgentHarness.js';
import { DEFAULT_CONTEXT_POLICY, type AgentContextPolicy } from './ContextPolicy.js';
import { projectContext } from './ContextProjector.js';

const summaryOnly: AgentContextPolicy = {
  ...DEFAULT_CONTEXT_POLICY,
  history: 'full',
  toolResults: 'summary-only',
};

function toolResult(content: string): AgentMessage {
  return { role: 'tool', content, toolCallId: 'call_1' };
}

describe('K4.3/F25 — summary-only never blinds the judge on failures', () => {
  it('a failing tool result keeps the FULL payload up to the cap, not the first line', () => {
    const failure = [
      'npm run test',
      'Error: expected 200 got 500',
      '    at handler (src/api.ts:42:11)',
      'exit code 1',
    ].join('\n');
    const out = projectContext([toolResult(failure)], summaryOnly);
    const msg = out.messages.find((m) => m.role === 'tool')!;
    // The detail AFTER the first line is what F25 used to drop.
    expect(msg.content).toContain('    at handler (src/api.ts:42:11)');
    expect(msg.content).toContain('exit code 1');
    expect(msg.content).not.toContain('first line]');
  });

  it('a failing result beyond the cap keeps head AND tail with a truncation marker', () => {
    const policy: AgentContextPolicy = { ...summaryOnly, maxToolResultChars: 500 };
    const failure = `Error: exploded\n${'x'.repeat(2000)}\nlast line of the stack`;
    const out = projectContext([toolResult(failure)], policy);
    const msg = out.messages.find((m) => m.role === 'tool')!;
    expect(msg.content.startsWith('Error: exploded')).toBe(true);
    expect(msg.content.endsWith('last line of the stack')).toBe(true);
    expect(msg.content).toContain('truncated by context projection');
    expect(msg.content).not.toContain('first line]');
  });

  it('a SUCCESSFUL tool result still gets the cheap one-line summary', () => {
    const ok = 'all good\nsecond line of verbose output';
    const out = projectContext([toolResult(ok)], summaryOnly);
    const msg = out.messages.find((m) => m.role === 'tool')!;
    expect(msg.content).toContain('first line]');
    expect(msg.content).not.toContain('second line');
  });

  it('typed guard codes count as failures too (tool_args_parse_failed stays visible)', () => {
    const typed = '{"ok":false,"code":"tool_args_parse_failed","detail":"Unexpected token"}';
    const out = projectContext([toolResult(typed)], summaryOnly);
    const msg = out.messages.find((m) => m.role === 'tool')!;
    expect(msg.content).toContain('tool_args_parse_failed');
    expect(msg.content).not.toContain('first line]');
  });
});
