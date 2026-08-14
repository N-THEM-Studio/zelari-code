import { describe, it, expect, afterEach } from "vitest";
import {
  pruneToolResults,
  pruneToolResultsDetailed,
  compactHistoryDetailed,
} from "../../src/cli/hooks/historyCompaction.js";
import type { AgentMessage } from "@zelari/core/harness";

function toolMsg(id: string, content: string): AgentMessage {
  return { role: "tool", toolCallId: id, content };
}

describe("pruneToolResults (cache-aware compaction)", () => {
  afterEach(() => {
    delete process.env.ZELARI_TOOL_RESULT_MAX_CHARS;
    delete process.env.ZELARI_TOOL_RESULT_TAIL_CHARS;
  });

  it("returns the same reference when no tool result exceeds the cap", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "hi" },
      toolMsg("c1", "short result"),
    ];
    const out = pruneToolResults(msgs, { maxChars: 8000, tailChars: 1000 });
    expect(out).toBe(msgs);
  });

  it("truncates an oversized tool result to head + tail, preserving toolCallId", () => {
    const body = "H".repeat(1000) + "END-MARKER";
    const msgs: AgentMessage[] = [toolMsg("call_x", body)];
    const out = pruneToolResults(msgs, { maxChars: 100, tailChars: 10 });
    expect(out).not.toBe(msgs);
    expect(out.length).toBe(1);
    const t = out[0];
    expect(t.role).toBe("tool");
    expect(t.toolCallId).toBe("call_x");
    expect(t.content).toContain("…[pruned");
    expect(t.content).toContain("END-MARKER"); // tail preserved
    expect(t.content.length).toBeLessThan(body.length);
    expect(t.content.startsWith("H".repeat(90))).toBe(true); // head preserved
  });

  it("reports pruned count + chars omitted", () => {
    const big = "B".repeat(500);
    const msgs: AgentMessage[] = [
      { role: "user", content: "hi" },
      toolMsg("c1", big),
      toolMsg("c2", big),
      { role: "assistant", content: "done" },
    ];
    const { messages, stats } = pruneToolResultsDetailed(msgs, {
      maxChars: 100,
      tailChars: 10,
    });
    expect(stats.pruned).toBe(2);
    // 500 - 90 (head) - 10 (tail) = 400 omitted per tool result.
    expect(stats.charsOmitted).toBe(400 * 2);
    // Non-tool messages are left untouched (same references).
    expect(messages[0]).toBe(msgs[0]);
    expect(messages[3]).toBe(msgs[3]);
  });

  it("keeps tail content (final output / errors)", () => {
    const body = "START..." + "Z".repeat(200) + "...END";
    const out = pruneToolResults([toolMsg("c1", body)], {
      maxChars: 100,
      tailChars: 20,
    });
    expect(out[0].content.endsWith("...END")).toBe(true);
    expect(out[0].content).toContain("START");
  });

  it("clamps tailChars to maxChars to avoid negative head", () => {
    const body = "X".repeat(300);
    const out = pruneToolResults([toolMsg("c1", body)], {
      maxChars: 50,
      tailChars: 200,
    });
    expect(out[0].content.length).toBeLessThan(body.length);
  });

  it("does not prune tool messages already under the cap", () => {
    const msgs: AgentMessage[] = [toolMsg("c1", "tiny")];
    const out = pruneToolResults(msgs, { maxChars: 100, tailChars: 10 });
    expect(out).toBe(msgs);
  });
});

describe("compactHistoryDetailed prune integration", () => {
  afterEach(() => {
    delete process.env.ZELARI_HISTORY_TURNS;
    delete process.env.ZELARI_TOOL_RESULT_MAX_CHARS;
    delete process.env.ZELARI_TOOL_RESULT_TAIL_CHARS;
  });

  it("prunes oversized tool results in the kept window and reports prunedToolResults", () => {
    process.env.ZELARI_TOOL_RESULT_MAX_CHARS = "200";
    process.env.ZELARI_TOOL_RESULT_TAIL_CHARS = "20";
    const big = "T".repeat(5000);
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });
    }
    msgs.push({
      role: "assistant",
      content: "call",
      toolCalls: [{ id: "tc1", name: "read_file", args: {} }],
    });
    msgs.push(toolMsg("tc1", big));
    msgs.push({ role: "assistant", content: "final" });

    // maxMessages: 4 → cap 4, trigger at 8; 13 messages → compacts. The tool
    // chain is atomic, so the oversized tool result survives into the kept
    // window and must be pruned in-place.
    const r = compactHistoryDetailed(msgs, { maxMessages: 4 });
    expect(r.compacted).toBe(true);

    const keptTool = r.messages.find((m) => m.role === "tool");
    expect(keptTool).toBeDefined();
    expect(keptTool!.toolCallId).toBe("tc1");
    expect(keptTool!.content.length).toBeLessThan(big.length);
    expect(keptTool!.content).toContain("…[pruned");
    expect(r.prunedToolResults).toBe(1);
  });
});
