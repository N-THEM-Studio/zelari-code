/**
 * todo_write / todo_read — session task list for multi-step agent work.
 *
 * @since v1.21.0
 */
import { z } from 'zod';
import {
  typedErr,
  typedOk,
  type ToolDefinition,
} from '@zelari/core/harness/tools/toolTypes';
import {
  formatTodosForModel,
  listSessionTodos,
  unresolvedTodoPatches,
  writeSessionTodos,
  type SessionTodoStatus,
} from '../sessionTodos.js';

const StatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

const TodoItemSchema = z.object({
  id: z.string().min(1).max(64).optional().describe('Stable id; auto-generated if omitted'),
  content: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Short task description. Required, except with merge=true to patch an existing id (e.g. status only)'),
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
      const merge = input.merge === true;
      // `content` is optional in the schema only for merge patches: a replace
      // needs it on every item, a patch needs an id that already exists.
      const missing = merge
        ? unresolvedTodoPatches(input.todos)
        : input.todos.filter((t) => !t.content?.trim()).map((t) => t.id ?? '(no id)');
      if (missing.length > 0) {
        const known = listSessionTodos().map((t) => t.id);
        return typedErr(
          merge
            ? `todo_write: items without content must patch an existing id; unknown: ${missing.join(', ')}. ` +
                `Known ids: ${known.join(', ') || '(none)'}. Add content to create a new item.`
            : `todo_write: every item needs content when merge is false (missing on: ${missing.join(', ')}). ` +
                'Use merge=true to update only the status of existing ids.',
        );
      }
      const list = writeSessionTodos(
        input.todos.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status as SessionTodoStatus | undefined,
        })),
        { merge },
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
