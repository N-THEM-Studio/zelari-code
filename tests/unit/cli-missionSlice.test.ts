import { describe, it, expect } from 'vitest';
import {
  createWriteCounter,
  buildAgentMissionUserPrompt,
  AGENT_MISSION_IMPLEMENTER_PREAMBLE,
} from '../../src/cli/missionSlice.js';

describe('createWriteCounter', () => {
  it('counts successful write_file/edit_file', () => {
    const { state, onEvent } = createWriteCounter();
    onEvent({
      type: 'tool_execution_start',
      toolCallId: '1',
      toolName: 'write_file',
    });
    onEvent({
      type: 'tool_execution_end',
      toolCallId: '1',
      isError: false,
      result: 'ok wrote 12 bytes',
    });
    onEvent({
      type: 'tool_execution_start',
      toolCallId: '2',
      toolName: 'edit_file',
    });
    onEvent({
      type: 'tool_execution_end',
      toolCallId: '2',
      isError: false,
      result: 'occurrencesReplaced: 2',
    });
    expect(state.emittedWrites).toBe(2);
    expect(state.successfulWrites).toBe(2);
  });

  it('does not count failed or zero-replacement edits', () => {
    const { state, onEvent } = createWriteCounter();
    onEvent({
      type: 'tool_execution_start',
      toolCallId: '1',
      toolName: 'write_file',
    });
    onEvent({
      type: 'tool_execution_end',
      toolCallId: '1',
      isError: true,
      result: 'error',
    });
    onEvent({
      type: 'tool_execution_start',
      toolCallId: '2',
      toolName: 'edit_file',
    });
    onEvent({
      type: 'tool_execution_end',
      toolCallId: '2',
      isError: false,
      result: 'occurrencesReplaced: 0',
    });
    expect(state.emittedWrites).toBe(2);
    expect(state.successfulWrites).toBe(0);
  });

  it('ignores non-mutating tools', () => {
    const { state, onEvent } = createWriteCounter();
    onEvent({
      type: 'tool_execution_start',
      toolCallId: '1',
      toolName: 'read_file',
    });
    onEvent({
      type: 'tool_execution_end',
      toolCallId: '1',
      isError: false,
      result: 'content',
    });
    expect(state.emittedWrites).toBe(0);
    expect(state.successfulWrites).toBe(0);
  });
});

describe('buildAgentMissionUserPrompt', () => {
  it('includes implementer preamble and slice body', () => {
    const p = buildAgentMissionUserPrompt('Implement the login form');
    expect(p).toContain(AGENT_MISSION_IMPLEMENTER_PREAMBLE);
    expect(p).toContain('Implement the login form');
  });

  it('appends memory context when provided', () => {
    const p = buildAgentMissionUserPrompt('task', 'prior failure: missing CSS');
    expect(p).toContain('## Memory context');
    expect(p).toContain('prior failure: missing CSS');
  });
});
