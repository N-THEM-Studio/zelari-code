import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  compactHistory,
  resolveMaxMessages,
  type CompactHistoryOptions,
} from "../../src/cli/hooks/historyCompaction.js";
import type { AgentMessage } from "@zelari/core/harness";

/** Build a plain user/assistant alternation (no tool calls). */
function plainTurns(n: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });
  }
  return out;
}

/**
 * Build a transcript that contains an assistant(tool_calls) → tool(result)
 * chain at a specific position — the structurally-sensitive pattern the
 * atomic-drop rule must protect.
 */
function transcriptWithToolChain(): AgentMessage[] {
  return [
    { role: "user", content: "do the thing" },
    {
      role: "assistant",
      content: "ok, calling the tool",
      toolCalls: [{ id: "call_1", name: "read_file", args: { path: "a.ts" } }],
    },
    { role: "tool", toolCallId: "call_1", content: "file contents" },
    { role: "assistant", content: "done" },
    { role: "user", content: "thanks" },
    { role: "assistant", content: "np" },
  ];
}

describe("historyCompaction (v1.6.0)", () => {
  const origEnv = process.env.ZELARI_HISTORY_TURNS;

  afterEach(() => {
    // Restore env so tests don't leak ZELARI_HISTORY_TURNS into siblings.
    if (origEnv === undefined) delete process.env.ZELARI_HISTORY_TURNS;
    else process.env.ZELARI_HISTORY_TURNS = origEnv;
  });

  describe("resolveMaxMessages", () => {
    it("defaults to 6 turns × 4 = 24 messages when env unset", () => {
      delete process.env.ZELARI_HISTORY_TURNS;
      expect(resolveMaxMessages()).toBe(24);
    });

    it("tightens window when durableStatePresent and env unset", () => {
      delete process.env.ZELARI_HISTORY_TURNS;
      // default 6 → min(6,3)=3 turns × 4 = 12
      expect(resolveMaxMessages({ durableStatePresent: true })).toBe(12);
    });

    it("returns 0 (history disabled) when ZELARI_HISTORY_TURNS=0", () => {
      process.env.ZELARI_HISTORY_TURNS = "0";
      expect(resolveMaxMessages()).toBe(0);
    });

    it("honors a custom ZELARI_HISTORY_TURNS", () => {
      process.env.ZELARI_HISTORY_TURNS = "3";
      expect(resolveMaxMessages()).toBe(12);
    });

    it("treats garbage env as the default", () => {
      process.env.ZELARI_HISTORY_TURNS = "garbage";
      expect(resolveMaxMessages()).toBe(24);
    });
  });

  describe("compactHistory", () => {
    it("returns the same array reference when under the cap (no compaction)", () => {
      delete process.env.ZELARI_HISTORY_TURNS;
      const msgs = plainTurns(10);
      // default cap 24 → 2×48 trigger. 10 < 48 → no compaction.
      const result = compactHistory(msgs);
      expect(result).toBe(msgs);
    });

    it("returns [] when history is disabled (ZELARI_HISTORY_TURNS=0)", () => {
      process.env.ZELARI_HISTORY_TURNS = "0";
      const msgs = plainTurns(100);
      const result = compactHistory(msgs);
      expect(result).toEqual([]);
    });

    it("drops the oldest messages and prepends a summary marker when over cap", () => {
      process.env.ZELARI_HISTORY_TURNS = "2"; // cap = 8, trigger at 16
      const opts: CompactHistoryOptions = { maxMessages: 8 };
      // Override: force a small cap via opts directly to make the test
      // deterministic regardless of the ×4 multiplier. We pass maxMessages
      // explicitly and expect the function to honor it as the cap.
      const msgs = plainTurns(20);
      // resolveMaxMessages(opts) divides opts.maxMessages by 4 → turns=2 → 8.
      const result = compactHistory(msgs, opts);
      expect(result.length).toBeLessThan(msgs.length);
      expect(result[0].role).toBe("system");
      expect(result[0].content).toContain("[history]");
      // The kept tail should be the most recent messages.
      const lastKept = result[result.length - 1];
      expect(lastKept.content).toBe("m19");
    });

    it("NEVER orphans a tool result from its declaring assistant (atomic drop)", () => {
      // This is the critical invariant: a role:'tool' must always have its
      // declaring assistant(tool_calls) in the kept window. Build a transcript
      // where the tool chain sits right at the naive cut boundary.
      process.env.ZELARI_HISTORY_TURNS = "1"; // cap = 4, trigger at 8
      // Pad before the tool chain so the naive cut lands inside it.
      const msgs: AgentMessage[] = [
        ...plainTurns(6), // 6 messages of padding
        ...transcriptWithToolChain(), // adds the chain at the end
      ];
      // 12 total, cap 4 → naive cut at index 8. The tool chain starts at
      // index 6 (user "do the thing"), 7 (assistant toolCalls), 8 (tool).
      // A naive cut at 8 would orphan the tool result (index 8) from its
      // assistant (index 7). The atomic rule must push the cut back.
      const result = compactHistory(msgs, { maxMessages: 4 });
      // Find any tool message in the result.
      const toolIdx = result.findIndex((m) => m.role === "tool");
      expect(toolIdx).toBeGreaterThan(-1);
      const toolMsg = result[toolIdx];
      // The declaring assistant must be present BEFORE the tool.
      const hasDeclarer = result
        .slice(0, toolIdx)
        .some(
          (m) =>
            m.role === "assistant" &&
            m.toolCalls?.some((tc) => tc.id === toolMsg.toolCallId),
        );
      expect(hasDeclarer).toBe(true);
    });

    it("keeps the full tool chain intact (assistant + all its tool results)", () => {
      // Multiple tool results from one assistant call.
      process.env.ZELARI_HISTORY_TURNS = "1";
      const msgs: AgentMessage[] = [
        ...plainTurns(6),
        { role: "user", content: "u" },
        {
          role: "assistant",
          content: "two calls",
          toolCalls: [
            { id: "c1", name: "read_file", args: {} },
            { id: "c2", name: "list_files", args: {} },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "r1" },
        { role: "tool", toolCallId: "c2", content: "r2" },
        { role: "assistant", content: "done" },
      ];
      const result = compactHistory(msgs, { maxMessages: 4 });
      // Both tool results must be present, each with their declarer.
      const toolMsgs = result.filter((m) => m.role === "tool");
      expect(toolMsgs.length).toBe(2);
      for (const tm of toolMsgs) {
        const idx = result.indexOf(tm);
        const hasDeclarer = result
          .slice(0, idx)
          .some(
            (m) =>
              m.role === "assistant" &&
              m.toolCalls?.some((tc) => tc.id === tm.toolCallId),
          );
        expect(hasDeclarer).toBe(true);
      }
    });

    it("does not compact when exactly at 2× cap (boundary)", () => {
      process.env.ZELARI_HISTORY_TURNS = "1"; // cap 4, trigger at 8
      const msgs = plainTurns(8); // exactly 2×4
      const result = compactHistory(msgs, { maxMessages: 4 });
      expect(result).toBe(msgs); // no compaction at the boundary
    });

    it("regression: compacted transcript keeps assistant(tool_calls) BEFORE its tool(result) — provider-order invariant", () => {
      // Strict providers (MiniMax/GLM) return HTTP 400 if a role:'tool'
      // message is not immediately preceded by the assistant that declared
      // the matching tool_calls. This test guards the compaction output
      // against ever violating that order — the whole point of the atomic
      // drop rule. See core-agentHarness-toolResultOrder.test.ts for the
      // harness-side invariant; this covers the compaction-side.
      process.env.ZELARI_HISTORY_TURNS = "1";
      const msgs: AgentMessage[] = [
        ...plainTurns(6),
        { role: "user", content: "u" },
        {
          role: "assistant",
          content: "calling tool",
          toolCalls: [{ id: "cx", name: "read_file", args: {} }],
        },
        { role: "tool", toolCallId: "cx", content: "result" },
        { role: "assistant", content: "final" },
      ];
      const result = compactHistory(msgs, { maxMessages: 4 });
      // Walk the result: every tool message must have its declarer BEFORE it.
      for (let i = 0; i < result.length; i++) {
        if (result[i].role === "tool" && result[i].toolCallId) {
          const hasPriorDeclarer = result
            .slice(0, i)
            .some(
              (m) =>
                m.role === "assistant" &&
                m.toolCalls?.some((tc) => tc.id === result[i].toolCallId),
            );
          expect(hasPriorDeclarer).toBe(true);
        }
      }
    });
  });
});
