import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSessionTodos,
  formatTodosForModel,
  formatTodoStatusSummary,
  listSessionTodos,
  writeSessionTodos,
  _resetSessionTodosForTests,
} from '../../src/cli/sessionTodos.js';
import { createTodoReadTool, createTodoWriteTool } from '../../src/cli/tools/todoTools.js';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  audit: () => {},
  sessionId: 'test',
};

beforeEach(() => {
  _resetSessionTodosForTests();
});

describe('sessionTodos', () => {
  it('writes and replaces todos', () => {
    writeSessionTodos([
      { content: 'A', status: 'pending' },
      { id: 'b', content: 'B', status: 'in_progress' },
    ]);
    expect(listSessionTodos()).toHaveLength(2);
    expect(formatTodosForModel()).toMatch(/B \(in_progress\)/);
    writeSessionTodos([{ id: 'c', content: 'C', status: 'completed' }]);
    expect(listSessionTodos()).toHaveLength(1);
    expect(listSessionTodos()[0].id).toBe('c');
  });

  it('merges by id when merge=true', () => {
    writeSessionTodos([
      { id: 'a', content: 'A', status: 'pending' },
      { id: 'b', content: 'B', status: 'pending' },
    ]);
    writeSessionTodos([{ id: 'a', content: 'A done', status: 'completed' }], {
      merge: true,
    });
    const list = listSessionTodos();
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.id === 'a')?.status).toBe('completed');
    expect(list.find((t) => t.id === 'b')?.status).toBe('pending');
  });

  it('clearSessionTodos empties the list', () => {
    writeSessionTodos([{ content: 'x' }]);
    clearSessionTodos();
    expect(listSessionTodos()).toEqual([]);
  });

  it('formatTodoStatusSummary', () => {
    expect(formatTodoStatusSummary([])).toBeNull();
    writeSessionTodos([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
      { content: 'C', status: 'pending' },
    ]);
    expect(formatTodoStatusSummary()).toBe('todos 1/3 · 1 active');
  });
});

describe('todo tools', () => {
  it('todo_write + todo_read round-trip', async () => {
    const write = createTodoWriteTool();
    const read = createTodoReadTool();
    const w = await write.execute(
      {
        todos: [
          { id: '1', content: 'Ship feature', status: 'in_progress' },
          { id: '2', content: 'Write tests', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.value.formatted).toMatch(/Ship feature/);

    const r = await read.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.todos).toHaveLength(2);
      expect(r.value.formatted).toMatch(/Write tests/);
    }
  });
});
