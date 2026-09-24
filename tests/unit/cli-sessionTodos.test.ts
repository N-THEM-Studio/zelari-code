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

describe('todo_write merge patches (status-only updates)', () => {
  it('merge=true patches the status of an existing id without resending content', async () => {
    const write = createTodoWriteTool();
    await write.execute({ todos: [{ id: 'a', content: 'Map routes', status: 'in_progress' }] }, ctx);
    const parsed = write.inputSchema.safeParse({ todos: [{ id: 'a', status: 'completed' }], merge: true });
    expect(parsed.success).toBe(true);
    const r = await write.execute(parsed.success ? parsed.data : ({} as never), ctx);
    expect(r.ok).toBe(true);
    expect(listSessionTodos()).toEqual([{ id: 'a', content: 'Map routes', status: 'completed' }]);
  });

  it('merge=true keeps the existing status when only content changes', () => {
    writeSessionTodos([{ id: 'a', content: 'A', status: 'in_progress' }]);
    writeSessionTodos([{ id: 'a', content: 'A (renamed)' }], { merge: true });
    expect(listSessionTodos()).toEqual([{ id: 'a', content: 'A (renamed)', status: 'in_progress' }]);
  });

  it('merge=true never overwrites an existing auto id with a new id-less item', () => {
    writeSessionTodos([{ content: 'first' }, { content: 'second' }]); // t1, t2
    writeSessionTodos([{ content: 'third' }], { merge: true });
    expect(listSessionTodos().map((t) => `${t.id}:${t.content}`)).toEqual([
      't1:first',
      't2:second',
      't3:third',
    ]);
  });

  it('a content-less patch for an unknown id is an actionable error, not a silent no-op', async () => {
    const write = createTodoWriteTool();
    await write.execute({ todos: [{ id: 'a', content: 'A' }] }, ctx);
    const r = await write.execute({ todos: [{ id: 'zz', status: 'completed' }], merge: true }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('zz');
      expect(r.error).toContain('Known ids: a');
    }
    expect(listSessionTodos()).toEqual([{ id: 'a', content: 'A', status: 'pending' }]);
  });

  it('replace mode still requires content on every item', async () => {
    const write = createTodoWriteTool();
    const r = await write.execute({ todos: [{ id: 'a', status: 'completed' }] }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('merge=true');
  });
});
