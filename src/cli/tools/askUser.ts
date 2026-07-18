/**
 * ask_user — interactive clarification as a first-class tool (Grok Build–style).
 *
 * Unlike ---QUESTION--- text markers (parsed after the turn ends), this tool
 * blocks the harness tool-loop until the UI resolves a Promise, then returns
 * a tool_result so the same run can continue and finish the deliverable.
 *
 * Headless / tests: without a handler, returns a soft "proceed with assumption"
 * result so the loop is not wedged.
 */

import { z } from "zod";
import { typedOk, type ToolDefinition } from "@zelari/core/harness/tools/toolTypes";

export interface AskUserRequest {
  question: string;
  choices: string[];
  context?: string;
}

/** Resolve with answer text, or null if cancelled / timed out. */
export type AskUserHandler = (req: AskUserRequest) => Promise<string | null>;

const inputSchema = z.object({
  question: z.string().min(1).describe("One focused question for the user"),
  choices: z
    .array(z.string().min(1))
    .min(2)
    .max(6)
    .describe("2–6 concrete options; user may still type a free answer in the UI"),
  context: z
    .string()
    .optional()
    .describe("Why this choice matters (one short line)"),
});

export type AskUserInput = z.infer<typeof inputSchema>;

/**
 * Build the ask_user tool. Pass `handler` from the TUI (picker + Promise);
 * omit for headless/tests.
 */
export function createAskUserTool(
  handler?: AskUserHandler,
): ToolDefinition<AskUserInput, string> {
  return {
    name: "ask_user",
    description:
      "Ask the user ONE structured clarifying question and wait for their answer before continuing. " +
      "Prefer this over free-text ---QUESTION--- blocks. Use only when blocked by a decision that " +
      "materially changes implementation; otherwise assume and document the assumption.",
    permissions: ["ui"],
    inputSchema,
    execute: async (input) => {
      const question = input.question.trim();
      const choices = input.choices.map((c) => c.trim()).filter(Boolean);
      if (choices.length < 2) {
        return typedOk(
          "[ask_user] Need at least 2 choices. Proceed with your best assumption and state it.",
        );
      }
      if (!handler) {
        return typedOk(
          "[ask_user] No interactive UI (headless/tests). " +
            "Proceed with the first reasonable choice among: " +
            choices.join(" | ") +
            ". State the assumption explicitly.",
        );
      }
      try {
        const answer = await handler({
          question,
          choices,
          context: input.context?.trim() || undefined,
        });
        if (answer == null || !String(answer).trim()) {
          return typedOk(
            "[ask_user] User cancelled or no answer. " +
              "Proceed with a documented assumption, or stop if unsafe to continue.",
          );
        }
        return typedOk(
          `[ask_user] User answered:\n` +
            `  Q: ${question}\n` +
            `  A: ${String(answer).trim()}\n` +
            `Continue the task using this answer. Do not re-ask the same question.`,
        );
      } catch (err) {
        return typedOk(
          `[ask_user] UI error (${err instanceof Error ? err.message : String(err)}). ` +
            "Proceed with a documented assumption.",
        );
      }
    },
  };
}
