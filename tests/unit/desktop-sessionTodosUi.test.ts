import { describe, it, expect } from 'vitest';
import {
  parseTodoToolResult,
  parseTodosFromUnknown,
  mergeDesktopTodos,
  formatDesktopTodoSummary,
} from '../../apps/desktop/src/sessionTodosUi.js';

describe('desktop sessionTodosUi', () => {
  it('parses JSON tool result', () => {
    const raw = JSON.stringify({
      todos: [
        { id: '1', content: 'Ship', status: 'completed' },
        { id: '2', content: 'Test', status: 'in_progress' },
      ],
      formatted: '…',
    });
    const todos = parseTodoToolResult(raw);
    expect(todos).toHaveLength(2);
    expect(todos?.[0].status).toBe('completed');
    expect(formatDesktopTodoSummary(todos!)).toMatch(/1\/2/);
    expect(formatDesktopTodoSummary(todos!)).toMatch(/1 active/);
  });

  it('parses markdown checklist lines', () => {
    const raw = `
- [x] a: Done item (completed)
- [>] b: Working (in_progress)
- [ ] c: Later (pending)
`;
    const todos = parseTodoToolResult(raw);
    expect(todos).toHaveLength(3);
    expect(todos?.map((t) => t.status)).toEqual([
      'completed',
      'in_progress',
      'pending',
    ]);
  });

  it('returns null for empty/garbage', () => {
    expect(parseTodoToolResult('')).toBeNull();
    expect(parseTodoToolResult('hello world')).toBeNull();
  });

  it('parses todo_write args objects (live start event)', () => {
    const todos = parseTodosFromUnknown({
      todos: [{ id: 'a', content: 'Read file', status: 'in_progress' }],
      merge: false,
    });
    expect(todos).toEqual([
      { id: 'a', content: 'Read file', status: 'in_progress' },
    ]);
  });

  it('merges incoming todos by id', () => {
    const merged = mergeDesktopTodos(
      [
        { id: 'a', content: 'Old', status: 'pending' },
        { id: 'b', content: 'Keep', status: 'pending' },
      ],
      [{ id: 'a', content: 'New', status: 'completed' }],
    );
    expect(merged).toEqual([
      { id: 'a', content: 'New', status: 'completed' },
      { id: 'b', content: 'Keep', status: 'pending' },
    ]);
  });
});
