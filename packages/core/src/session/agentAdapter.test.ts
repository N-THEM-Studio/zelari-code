/**
 * agentAdapter tests (Exit-1 E1.1) — DerivedMessage[] → AgentMessage[].
 * Guarantees: role/content/toolCallId mapping, no seq leakage, 1:1 mapping
 * even for includeToolCalls JSON payloads, empty-in/empty-out, no mutation
 * of the input.
 */
import { describe, expect, it } from 'vitest';
import { derivedToAgentMessages } from './agentAdapter.js';
import { deriveMessages } from './modelSurface.js';
import {
  SESSION_SCHEMA_VERSION,
  type SessionActor,
  type SessionEventEnvelope,
  type SessionEventKind,
} from './types.js';

const AGENT: SessionActor = { type: 'agent' };
const USER: SessionActor = { type: 'user' };

function envelope(
  seq: number,
  kind: SessionEventKind,
  actor: SessionActor,
  data: Record<string, unknown>,
): SessionEventEnvelope {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: 's-adapter-test',
    seq,
    ts: 1755000000000 + seq,
    kind,
    actor,
    data,
  };
}

describe('derivedToAgentMessages (E1.1)', () => {
  it('maps user/assistant turns 1:1 (role + content, no seq leakage)', () => {
    const events = [
      envelope(1, 'user.message', USER, { text: 'fix the bug' }),
      envelope(2, 'assistant.message', AGENT, { text: 'on it' }),
    ];
    const agent = derivedToAgentMessages(deriveMessages(events));
    expect(agent).toEqual([
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'on it' },
    ]);
  });

  it('maps tool results to tool messages carrying toolCallId', () => {
    const events = [
      envelope(1, 'tool.call', AGENT, { tool: 'bash', args: { command: 'ls' }, callId: 'c1' }),
      envelope(2, 'tool.result', AGENT, { callId: 'c1', tool: 'bash', output: 'file-a\nfile-b', ok: true }),
    ];
    const agent = derivedToAgentMessages(deriveMessages(events));
    expect(agent).toEqual([
      { role: 'tool', content: 'file-a\nfile-b', toolCallId: 'c1' },
    ]);
  });

  it('maps session.compacted to a system message', () => {
    const events = [
      envelope(1, 'user.message', USER, { text: 'hello' }),
      envelope(2, 'session.compacted', AGENT, { summary: 'prior context summarized' }),
    ];
    const agent = derivedToAgentMessages(deriveMessages(events));
    expect(agent).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'prior context summarized' },
    ]);
  });

  it('keeps includeToolCalls payloads 1:1 (JSON content, no invented toolCalls)', () => {
    const events = [
      envelope(1, 'tool.call', AGENT, { tool: 'bash', args: { command: 'ls' }, callId: 'c1' }),
    ];
    const derived = deriveMessages(events, { includeToolCalls: true });
    const agent = derivedToAgentMessages(derived);
    expect(agent).toHaveLength(1);
    expect(agent[0].role).toBe('assistant');
    expect(agent[0].content).toBe(JSON.stringify({ tool: 'bash', args: { command: 'ls' } }));
    expect(agent[0].toolCallId).toBe('c1');
    expect(agent[0].toolCalls).toBeUndefined();
  });

  it('empty projection → empty harness input', () => {
    expect(derivedToAgentMessages([])).toEqual([]);
    expect(derivedToAgentMessages(deriveMessages([]))).toEqual([]);
  });

  it('never mutates the input array or its messages', () => {
    const events = [envelope(1, 'user.message', USER, { text: 'stable' })];
    const derived = deriveMessages(events);
    const snapshot = JSON.stringify(derived);
    const agent = derivedToAgentMessages(derived);
    agent[0].content = 'MUTATED';
    expect(JSON.stringify(derived)).toBe(snapshot);
    expect(derived[0].content).toBe('stable');
  });
});
