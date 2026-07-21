/**
 * todo_write / todo_read — session task list for multi-step agent work.
 *
 * @since v1.21.0
 */
import { z } from 'zod';
import {
  typedOk,
  type ToolDefinition,
} from '@zelari/core/harness/tools/toolTypes';
import {
  formatTodosForModel,
  listSessionTodos,
  writeSessionTodos,
  type SessionTodoStatus,
} from '../sessionTodos.js';

const StatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

const TodoItemSchema = z.object({
  id: z.string().min(1).max(64).optional().describe('Stable id; auto-generated if omitted'),
  content: z.string().min(1).max(500).describe('Short task description'),
  status: StatusSchema.optional().describe('Default pending'),
});

const WriteSchema = z.object({
  todos: z
    .array(TodoItemSchema)
    .min(1)
    .max(40)
    .describe('Todo items to set (replace list unless merge=true)'),
  merge: z
    .boolean()
    .optional()
    .describe('If true, upsert by id and keep unlisted items. Default false = replace.'),
});

const ReadSchema = z.object({
  // empty object so models can call with {}
  _unused: z.string().optional(),
});

export function createTodoWriteTool(): ToolDefinition<
  z.infer<typeof WriteSchema>,
  { todos: ReturnType<typeof listSessionTodos>; formatted: string }
> {
  return {
    name: 'todo_write',
    description:
      'Create or update the session todo list for this multi-step task. ' +
      'Use to track progress (pending → in_progress → completed). Prefer small, concrete items. ' +
      'Call todo_read to inspect current list. Not for durable product plans (.zelari/plan.json).',
    permissions: ['read'],
    timeoutMs: 5_000,
    inputSchema: WriteSchema,
    execute: async (input) => {
      const list = writeSessionTodos(
        input.todos.map((t) => ({
          id: t.id,
          content: t.content,
          status: (t.status ?? 'pending') as SessionTodoStatus,
        })),
        { merge: input.merge === true },
      );
      return typedOk({
        todos: list,
        formatted: formatTodosForModel(list),
      });
    },
  };
}

export function createTodoReadTool(): ToolDefinition<
  z.infer<typeof ReadSchema>,
  { todos: ReturnType<typeof listSessionTodos>; formatted: string }
> {
  return {
    name: 'todo_read',
    description:
      'Read the current session todo list. Use after todo_write or to recall open work mid-task.',
    permissions: ['read'],
    timeoutMs: 5_000,
    inputSchema: ReadSchema,
    execute: async () => {
      const list = listSessionTodos();
      return typedOk({
        todos: list,
        formatted: formatTodosForModel(list),
      });
    },
  };
}
