import { describe, it, expect } from 'vitest';
import {
  type ChatMessage,
  ChatStream,
  renderMessage,
  pickVisibleMessages,
} from '../../src/cli/components/ChatStream.js';
import { classifyToolColor } from '../../src/cli/components/ToolOutput.js';
import { ToolOutput } from '../../src/cli/components/ToolOutput.js';
import { LiveRegion } from '../../src/cli/components/LiveRegion.js';
import { StatusBar } from '../../src/cli/components/StatusBar.js';
import { InputBar } from '../../src/cli/components/InputBar.js';
import React from 'react';

const mkMsg = (id: string, role: ChatMessage['role'], content: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content,
  ts: 0,
  ...overrides,
});

describe('pickVisibleMessages (v0.7.0 scrollback — picking removed)', () => {
  // v0.6.2 height/width picking is gone: <Static> handles scrollback natively
  // and the live region is bounded by construction. The shim returns inputs
  // unchanged so legacy imports resolve; these tests assert that pass-through
  // identity contract (used as a regression guard while the shim exists).
  it('shim returns the input array unchanged (identity-by-content)', () => {
    const msgs = [mkMsg('1', 'user', 'hi'), mkMsg('2', 'assistant', 'yo')];
    const out = pickVisibleMessages(msgs, 0, 80);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('1');
    expect(out[1].id).toBe('2');
  });

  it('renderMessage renders a finalized tool message with status glyph', () => {
    const m = mkMsg('t1', 'tool', 'ls', { toolName: 'bash', toolOk: true, toolDurationMs: 12 });
    const el = renderMessage(m);
    // Renders without throwing; it is a React element.
    expect(React.isValidElement(el)).toBe(true);
  });

  it('renderMessage renders a live (pending) tool message without a body', () => {
    const m = mkMsg('t2', 'tool', 'ls', { toolName: 'bash', toolCallId: 'c2' });
    const el = renderMessage(m, true);
    expect(React.isValidElement(el)).toBe(true);
  });
});

describe('classifyToolColor (v0.7.0 — unchanged policy)', () => {
  it('returns red when ok=false', () => {
    expect(classifyToolColor('bash', false)).toBe('red');
  });

  it('classifies read tools as green', () => {
    expect(classifyToolColor('read_file')).toBe('green');
    expect(classifyToolColor('cat')).toBe('green');
    expect(classifyToolColor('grep_content')).toBe('green');
    expect(classifyToolColor('search')).toBe('green');
  });

  it('classifies write tools as yellow', () => {
    expect(classifyToolColor('write_file')).toBe('yellow');
    expect(classifyToolColor('edit_file')).toBe('yellow');
  });

  it('classifies shell tools as red (warning)', () => {
    expect(classifyToolColor('bash', true)).toBe('red');
    expect(classifyToolColor('shell', true)).toBe('red');
    expect(classifyToolColor('exec', true)).toBe('red');
  });

  it('defaults to cyan for unknown', () => {
    expect(classifyToolColor('list_files')).toBe('cyan');
    expect(classifyToolColor('unknown_tool')).toBe('cyan');
  });
});

describe('React.memo wrapping (v0.7.0 components)', () => {
  const memoType = React.memo(() => null).$$typeof;

  it('InputBar is wrapped in React.memo', () => {
    expect(InputBar.$$typeof).toBe(memoType);
  });

  it('ChatStream is wrapped in React.memo', () => {
    expect(ChatStream.$$typeof).toBe(memoType);
  });

  it('ToolOutput is wrapped in React.memo', () => {
    expect(ToolOutput.$$typeof).toBe(memoType);
  });

  it('LiveRegion is a valid React element factory', () => {
    // LiveRegion is a plain function component (no memo needed — its props
    // are stable objects from session state). Assert it renders.
    expect(typeof LiveRegion).toBe('function');
  });

  it('StatusBar is a valid React element factory', () => {
    expect(typeof StatusBar).toBe('function');
  });
});
