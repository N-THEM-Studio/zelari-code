import { describe, it, expect } from 'vitest';
import {
  pickVisibleMessages,
  type ChatMessage,
} from '../../src/cli/components/ChatStream.js';
import { classifyToolColor } from '../../src/cli/components/CollapsibleToolOutput.js';
import { Header } from '../../src/cli/components/Header.js';
import { Sidebar } from '../../src/cli/components/Sidebar.js';
import { InputBar } from '../../src/cli/components/InputBar.js';
import { ChatStream } from '../../src/cli/components/ChatStream.js';
import { CollapsibleToolOutput } from '../../src/cli/components/CollapsibleToolOutput.js';
import React from 'react';

const mkMsg = (id: string, role: ChatMessage['role'], content: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content,
  ts: 0,
  ...overrides,
});

describe('pickVisibleMessages (v0.4.0-UI audit)', () => {
  it('returns empty array when height is 0', () => {
    const msgs = [mkMsg('1', 'user', 'hi')];
    expect(pickVisibleMessages(msgs, 0, 80)).toEqual([]);
  });

  it('returns empty array when no messages', () => {
    expect(pickVisibleMessages([], 20, 80)).toEqual([]);
  });

  it('returns all messages when they fit', () => {
    const msgs = [
      mkMsg('1', 'user', 'hello'),
      mkMsg('2', 'assistant', 'world'),
    ];
    // height=20, width=80 → user (1+1+1)=3 rows, assistant=3 rows → total 6 ≤ 19
    expect(pickVisibleMessages(msgs, 20, 80)).toHaveLength(2);
  });

  it('drops oldest messages when overflow (newest first priority)', () => {
    const msgs = [
      mkMsg('1', 'user', 'a'.repeat(1000)), // tall
      mkMsg('2', 'user', 'b'.repeat(1000)), // tall
      mkMsg('3', 'assistant', 'c'),         // short, newest
    ];
    const visible = pickVisibleMessages(msgs, 8, 80);
    // assistant (3 rows) + user 'b' (3 rows) = 6 ≤ 7 buffer → keep 3+2
    // user 'a' (3 rows) wouldn't fit → dropped
    expect(visible.map(m => m.id)).toEqual(['2', '3']);
  });

  it('truncates the top message when partially overflowing', () => {
    const msgs = [
      mkMsg('1', 'user', ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n')),
      mkMsg('2', 'assistant', 'ok'),
    ];
    // height=8, width=80 → assistant (3 rows) consumes 3 → 4 left
    // msg '1' header (1) + 4 text rows + margin (1) = 6 → won't fit at full.
    // But we have 4 remaining after assistant. Try fitting '1':
    // - remaining=4, mHeight=6 → 4-6 < 0, but remaining > 2 → truncate
    // - maxTextRows = 4 - 2 = 2 → keep 2 lines + '... [truncated]'
    const visible = pickVisibleMessages(msgs, 8, 80);
    expect(visible.length).toBeGreaterThanOrEqual(1);
    // The kept message should be truncated
    const kept = visible[0];
    expect(kept.content).toContain('[truncated]');
  });

  it('preserves tool messages as collapsed (height=1)', () => {
    const msgs = [
      mkMsg('1', 'tool', 'ls', { toolName: 'bash' }),
      mkMsg('2', 'user', 'do it'),
    ];
    const visible = pickVisibleMessages(msgs, 8, 80);
    // tool takes 1 row, user takes 3 rows → total 4 ≤ 7 buffer → both fit
    expect(visible).toHaveLength(2);
    expect(visible[0].role).toBe('tool');
    expect(visible[1].role).toBe('user');
  });

  it('handles long single-line content (wraps to multiple rows)', () => {
    const msgs = [
      mkMsg('1', 'assistant', 'a'.repeat(250)), // 250 chars / 80 width = 4 rows
    ];
    // height=8 → header (1) + 4 text rows + margin (1) = 6 ≤ 7 → fits
    const visible = pickVisibleMessages(msgs, 8, 80);
    expect(visible).toHaveLength(1);
  });
});

describe('classifyToolColor (v0.4.0-UI audit)', () => {
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

describe('React.memo wrapping (v0.4.0-UI audit)', () => {
  it('Header is wrapped in React.memo', () => {
    // React.memo components have a $$typeof of REACT_MEMO_TYPE
    expect(Header.$$typeof).toBe(React.memo(() => null).$$typeof);
  });

  it('Sidebar is wrapped in React.memo', () => {
    expect(Sidebar.$$typeof).toBe(React.memo(() => null).$$typeof);
  });

  it('InputBar is wrapped in React.memo', () => {
    expect(InputBar.$$typeof).toBe(React.memo(() => null).$$typeof);
  });

  it('ChatStream is wrapped in React.memo', () => {
    expect(ChatStream.$$typeof).toBe(React.memo(() => null).$$typeof);
  });

  it('CollapsibleToolOutput is wrapped in React.memo', () => {
    expect(CollapsibleToolOutput.$$typeof).toBe(React.memo(() => null).$$typeof);
  });
});