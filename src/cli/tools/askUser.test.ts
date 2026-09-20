/**
 * ask_user (WS7 slice 4 / t139) — `ask_user.fired` on the session spine.
 *
 * The model stopping the loop to ask the operator is a DECISION ("was the user
 * asked?"), and one a shadow replay must be able to read back. It is state-only
 * telemetry: the tool result the model sees is byte-identical with or without a
 * sink, and a throwing sink can never break the answer path.
 */
import { describe, expect, it } from "vitest";
import {
  SESSION_SCHEMA_VERSION,
  buildProjection,
  decisionPayloadError,
  type SessionEventEnvelope,
  type SessionEventInput,
} from "@zelari/core/session";
import type { ToolContext } from "@zelari/core/harness/tools/toolTypes";
import { createAskUserTool } from "./askUser.js";

interface Collector {
  events: SessionEventInput[];
  ctx: ToolContext;
}

function collector(emit?: (input: SessionEventInput) => Promise<unknown>): Collector {
  const events: SessionEventInput[] = [];
  return {
    events,
    ctx: {
      signal: new AbortController().signal,
      cwd: process.cwd(),
      audit: () => undefined,
      sessionId: "ask-user-test",
      emitSessionEvent: emit ?? (async (input) => { events.push(input); return { seq: events.length }; }),
    },
  };
}

/** Hand-built envelopes — enough for buildProjection (no spine on disk needed). */
function envelopes(inputs: readonly SessionEventInput[]): SessionEventEnvelope[] {
  return inputs.map((input, i) => ({
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: "ask-user-test",
    seq: i + 1,
    ts: 1_700_000_000_000 + i,
    kind: input.kind,
    actor: input.actor,
    data: input.data ?? {},
  }));
}

describe("WS7 slice 4 — ask_user.fired", () => {
  it("records the question on the spine BEFORE the operator is asked", async () => {
    const { events, ctx } = collector();
    let seenAtHandler = -1;
    const tool = createAskUserTool(async () => {
      seenAtHandler = events.length;
      return "the first one";
    });

    const res = await tool.execute(
      { question: "Which cap?", choices: ["20", "50"], context: "tokens per turn" },
      ctx,
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain("User answered");
    // The event was written before the handler ran (the decision precedes the answer).
    expect(seenAtHandler).toBe(1);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("ask_user.fired");
    expect(events[0]!.data).toMatchObject({
      question: "Which cap?",
      choices: ["20", "50"],
      context: "tokens per turn",
    });
    expect(decisionPayloadError("ask_user.fired", events[0]!.data)).toBeNull();

    const projection = buildProjection(envelopes(events));
    expect(projection.decisionEvents.map((d) => d.kind)).toEqual(["ask_user.fired"]);
    expect(projection.decisionEvents[0]!.detail).toBe("Which cap?  [choices: 20, 50]");
  });

  it("headless (no handler): nobody is asked, so nothing is recorded", async () => {
    const { events, ctx } = collector();
    const tool = createAskUserTool();
    const res = await tool.execute({ question: "Which cap?", choices: ["20", "50"] }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain("No interactive UI");
    expect(events).toEqual([]);
  });

  it("an invalid ask (fewer than 2 choices) never fires", async () => {
    const { events, ctx } = collector();
    const tool = createAskUserTool(async () => "x");
    const res = await tool.execute({ question: "Which cap?", choices: ["20"] }, ctx);
    expect(res.ok).toBe(true);
    expect(events).toEqual([]);
  });

  it("BEST-EFFORT: a THROWING sink never breaks the answer path", async () => {
    const { ctx } = collector(() => Promise.reject(new Error("SESSION_LOG_LOCKED")));
    const tool = createAskUserTool(async () => "the first one");
    const res = await tool.execute({ question: "Which cap?", choices: ["20", "50"] }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain("the first one");
  });

  it("BEST-EFFORT: an ABSENT sink (legacy host) still returns the answer", async () => {
    const noSink: ToolContext = {
      signal: new AbortController().signal,
      cwd: process.cwd(),
      audit: () => undefined,
      sessionId: "ask-user-test",
    };
    const tool = createAskUserTool(async () => "the second one");
    const res = await tool.execute({ question: "Which cap?", choices: ["20", "50"] }, noSink);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain("the second one");
  });
});
