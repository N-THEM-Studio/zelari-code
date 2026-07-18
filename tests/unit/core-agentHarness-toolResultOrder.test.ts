/**
 * core-agentHarness-toolResultOrder.test.ts
 *
 * Regression for the MiniMax/GLM "tool result's tool id ... not found (2013)"
 * HTTP 400. The AgentHarness used to push the role:'tool' result message to the
 * transcript inline (as the tool executed, during the `tool_call` delta) but
 * only appended the role:'assistant' message that DECLARED the tool_calls on
 * the later `finish` delta — producing the invalid order
 * [tool_result, assistant] in the messages array.
 *
 * xAI/grok tolerated the reversed order (matched by id regardless of position);
 * MiniMax and GLM validate strictly and reject the next request because the
 * tool result has no PRECEDING assistant tool_calls declaration.
 *
 * The fix buffers tool results and flushes them AFTER the assistant message on
 * `finish`, giving the OpenAI-required order assistant(tool_calls) → tool(result).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgentHarness } from "@zelari/core/harness";
import { ToolRegistry } from "@zelari/core/harness/tools/registry";
import type { ProviderStreamFn, ProviderDelta } from "@zelari/core/harness";
import type { BrainEvent } from "@zelari/core/events";

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ProviderDelta {
  return { kind: "tool_call", toolCallId: id, toolName: name, args };
}
function text(s: string): ProviderDelta {
  return { kind: "text", delta: s };
}
function finish(reason = "stop"): ProviderDelta {
  return { kind: "finish", reason };
}
async function collect(
  stream: AsyncIterable<BrainEvent>,
): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("AgentHarness tool-result ordering (MiniMax 2013 regression)", () => {
  it("appends the assistant tool_calls message BEFORE its tool result", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "list_files",
      description: "list files",
      inputSchema: z.object({}),
      permissions: [],
      execute: async () => ({ ok: true, value: "entry-a\nentry-b" }),
    });

    // Turn 1: text + one tool call, finish=tool_calls (harness runs the tool,
    // re-enters). Turn 2: plain answer, finish=stop (terminates the run).
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield text("let me look");
        yield toolCall("call_abc123", "list_files", {});
        yield finish("tool_calls");
      } else {
        yield text("here is the answer");
        yield finish("stop");
      }
    } as ProviderStreamFn;

    const messages: any[] = [{ role: "user", content: "list the files" }];
    const harness = new AgentHarness({
      model: "test-model",
      provider: "minimax",
      sessionId: "sess-order-1",
      messages,
      tools: [],
      toolRegistry: registry,
      providerStream: provider,
    });

    await collect(harness.run());

    const asstIdx = messages.findIndex(
      (m) =>
        m.role === "assistant" &&
        m.toolCalls?.some((t: { id: string }) => t.id === "call_abc123"),
    );
    const toolIdx = messages.findIndex(
      (m) => m.role === "tool" && m.toolCallId === "call_abc123",
    );

    expect(asstIdx).toBeGreaterThanOrEqual(0); // assistant declaration present
    expect(toolIdx).toBeGreaterThanOrEqual(0); // tool result present
    // The core invariant MiniMax/GLM enforce: declaration precedes result.
    expect(asstIdx).toBeLessThan(toolIdx);
    // And they must be adjacent (no stray message between them).
    expect(toolIdx).toBe(asstIdx + 1);
  });

  it("keeps ordering with multiple tool calls in one turn", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "peek",
      description: "peek",
      inputSchema: z.object({ n: z.number().optional() }),
      permissions: [],
      execute: async () => ({ ok: true, value: "ok" }),
    });

    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield toolCall("call_1", "peek", { n: 1 });
        yield toolCall("call_2", "peek", { n: 2 });
        yield finish("tool_calls");
      } else {
        yield text("done");
        yield finish("stop");
      }
    } as ProviderStreamFn;

    const messages: any[] = [{ role: "user", content: "peek twice" }];
    const harness = new AgentHarness({
      model: "test-model",
      provider: "minimax",
      sessionId: "sess-order-2",
      messages,
      tools: [],
      toolRegistry: registry,
      providerStream: provider,
    });

    await collect(harness.run());

    const asstIdx = messages.findIndex(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.length === 2,
    );
    const tool1Idx = messages.findIndex(
      (m) => m.role === "tool" && m.toolCallId === "call_1",
    );
    const tool2Idx = messages.findIndex(
      (m) => m.role === "tool" && m.toolCallId === "call_2",
    );

    expect(asstIdx).toBeGreaterThanOrEqual(0);
    // Both tool results come after the single assistant message, in order.
    expect(asstIdx).toBeLessThan(tool1Idx);
    expect(tool1Idx).toBeLessThan(tool2Idx);
  });
});

describe("AgentHarness ---TOOLS--- text-format tool execution", () => {
  it("executes tool calls emitted as a ---TOOLS--- text block (not native)", async () => {
    const registry = new ToolRegistry();
    let invoked = 0;
    let seenArgs: Record<string, unknown> | null = null;
    registry.register({
      name: "noop",
      description: "noop",
      inputSchema: z.object({ x: z.number().optional() }),
      permissions: [],
      execute: async (args: Record<string, unknown>) => {
        invoked++;
        seenArgs = args;
        return { ok: true, value: "done" };
      },
    });

    // Turn 1 emits the tool call as a ---TOOLS--- TEXT block (no native call);
    // turn 2 ends the run.
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield text(
          'I will call a tool.\n---TOOLS---\n[{"name":"noop","args":{"x":7}}]\n---END---',
        );
        yield finish("stop");
      } else {
        yield text("done");
        yield finish("stop");
      }
    } as ProviderStreamFn;

    const messages: any[] = [{ role: "user", content: "go" }];
    const harness = new AgentHarness({
      model: "test-model",
      provider: "minimax",
      sessionId: "sess-texttool",
      messages,
      tools: [],
      toolRegistry: registry,
      providerStream: provider,
    });

    const events = await collect(harness.run());

    // The text-format call actually ran.
    expect(invoked).toBe(1);
    expect(seenArgs).toMatchObject({ x: 7 });
    expect(
      events.some(
        (e) => e.type === "tool_execution_start" && e.toolName === "noop",
      ),
    ).toBe(true);
    // Transcript ordering preserved: assistant(tool_calls) before tool(result).
    const asstIdx = messages.findIndex(
      (m) =>
        m.role === "assistant" &&
        m.toolCalls?.some((t: { name: string }) => t.name === "noop"),
    );
    const toolIdx = messages.findIndex((m) => m.role === "tool");
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(asstIdx);
  });

  it("re-enters tool loop when provider finishes stop but tools ran (MiniMax-M3)", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "list_files",
      description: "list",
      inputSchema: z.object({}),
      permissions: [],
      execute: async () => ({ ok: true, value: "ok" }),
    });
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield text("looking…");
        yield toolCall("call_stop", "list_files", {});
        // Bug: MiniMax sometimes emits tools then finish_reason=stop.
        yield finish("stop");
      } else {
        yield text("found the files");
        yield finish("stop");
      }
    } as ProviderStreamFn;

    const harness = new AgentHarness({
      model: "test-model",
      provider: "minimax",
      sessionId: "sess-finish-stop-tools",
      messages: [{ role: "user", content: "list" }],
      tools: [],
      toolRegistry: registry,
      providerStream: provider,
    });
    const events = await collect(harness.run());
    expect(turn).toBeGreaterThanOrEqual(2);
    const textOut = events
      .filter((e) => e.type === "message_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(textOut).toContain("found the files");
  });

  it("emits parse failure error when ---TOOLS--- block has invalid JSON", async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield text("---TOOLS---\n[not json]\n---END---");
        yield finish("stop");
      } else {
        yield text("done");
        yield finish("stop");
      }
    } as ProviderStreamFn;

    const harness = new AgentHarness({
      model: "test-model",
      provider: "minimax",
      sessionId: "sess-bad-json",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      toolRegistry: registry,
      providerStream: provider,
    });

    const events = await collect(harness.run());
    expect(
      events.some(
        (e) => e.type === "error" && e.code === "text_tools_parse_failed",
      ),
    ).toBe(true);
    // Recoverable parse fail must NOT mark agent_end as error (would abort
    // multi-step loops mid-task on MiniMax text dumps).
    const end = events.find((e) => e.type === "agent_end") as
      | { reason?: string }
      | undefined;
    expect(end?.reason).toBe("completed");
  });

  it("continues the tool-loop after a recoverable text_tools_parse_failed mid-run", async () => {
    // Turn 1: native tool → re-enter loop. Turn 2: bad ---TOOLS--- + stop.
    // Recoverable parse fail must not mark agent_end as error.
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "ping",
      inputSchema: z.object({}),
      permissions: [],
      execute: async () => ({ ok: true, value: "pong" }),
    });
    let turn = 0;
    const provider: ProviderStreamFn = async function* () {
      turn++;
      if (turn === 1) {
        yield toolCall("c1", "ping", {});
        yield finish("tool_calls");
      } else if (turn === 2) {
        yield text("---TOOLS---\n[not json]\n---END---");
        yield finish("stop");
      } else {
        yield text("recovered");
        yield finish("stop");
      }
    } as ProviderStreamFn;

    const harness = new AgentHarness({
      model: "test-model",
      provider: "minimax",
      sessionId: "sess-parse-continue",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      toolRegistry: registry,
      providerStream: provider,
      maxToolLoopIterations: 5,
    });

    const events = await collect(harness.run());
    expect(
      events.some(
        (e) => e.type === "error" && e.code === "text_tools_parse_failed",
      ),
    ).toBe(true);
    const end = events.find((e) => e.type === "agent_end") as
      | { reason?: string }
      | undefined;
    expect(end?.reason).toBe("completed");
    expect(
      events.some(
        (e) => e.type === "tool_execution_end" && e.isError === false,
      ),
    ).toBe(true);
  });

  it("does NOT emit text_tools_parse_failed when text merely mentions MiniMax", async () => {
    // Regression: bare "MiniMax" in a provider list used to match /minimax/i
    // and fire a false parse-failed error after a plain summary turn.
    const registry = new ToolRegistry();
    const provider: ProviderStreamFn = async function* () {
      yield text(
        "Providers: OpenAI-compatible, Grok, GLM, MiniMax, DeepSeek. Ready.",
      );
      yield finish("stop");
    } as ProviderStreamFn;

    const harness = new AgentHarness({
      model: "MiniMax-M3",
      provider: "minimax",
      sessionId: "sess-minimax-word",
      messages: [{ role: "user", content: "overview" }],
      tools: [],
      toolRegistry: registry,
      providerStream: provider,
    });

    const events = await collect(harness.run());
    expect(
      events.some(
        (e) => e.type === "error" && e.code === "text_tools_parse_failed",
      ),
    ).toBe(false);
  });
});
