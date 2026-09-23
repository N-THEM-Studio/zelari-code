# ADR-0038: Async tool call placeholders ("still running")

**Status:** accepted
**Date:** 2026-09-23
**Deciders:** zelari-code council

## Context

The unreal-agent harness allows the model to emit multiple independent tool calls in the same turn. While a long-running tool executes, the model context shows a "still running" placeholder that gets replaced by the actual result at a natural boundary (the next model turn).

Zelari Code already runs consecutive parallel-safe tools via `Promise.all` in `executePendingTools()` (AgentHarness), but the model sees nothing until ALL tools complete. This means:
- A 30-second `bash` tool blocks the model from seeing results of a 1-second `read_file` that finished 29 seconds ago
- The model cannot react to early results or emit follow-up calls while long tools run
- The idle watchdog may fire during long parallel batches

## Decision

We implement async tool call with "still running" placeholders:

1. **Detection**: In `executePendingTools()`, when multiple parallel-safe tool calls are pending, start ALL of them concurrently (already done). For each call that finishes before others, yield a `tool_execution_end` event immediately (already done for the event stream, but NOT yet injected into the model context mid-turn).

2. **Placeholder injection**: When a tool call starts, inject a synthetic `tool.result` message into the rolling model history with content `"[tool call still running — result will arrive at the next turn boundary]"`. This keeps the provider's message ordering intact (tool_result follows tool_call).

3. **Result replacement at natural boundary**: At the next turn boundary (when `executePendingTools` returns ALL results), replace the placeholder messages with actual results in the model history. The provider sees: tool_call → tool_result(placeholder) → ... → tool_call → tool_result(actual). At the boundary, the placeholders are replaced so the next provider request has the real data.

4. **Provider ordering**: The placeholder approach respects OpenAI-style ordering (assistant message with tool_calls → tool messages with results). The placeholder is a valid tool_result that the provider accepts. Replacement happens only before the NEXT provider request, never mid-stream.

5. **Scope**: This applies to the main agent loop only (AgentHarness.run()). Tentacles (task tool) use the same harness but are unaffected — they run their own loop. The `observe_batch` read-only batching is orthogonal (it batches observations, not tool calls).

## Consequences

**Positive:**
- Early results visible to model sooner → faster reaction to partial progress
- Long-running tools don't block short ones from being reported
- Idle watchdog sees activity during parallel batches
- Provider ordering preserved (placeholder is a valid tool_result)

**Negative:**
- Model history manipulation between turns (replacing placeholders) adds complexity
- Must handle edge case: what if the model emits more calls before all placeholders are replaced?
- Testing must verify at least 2 providers (primary + fallback)

**Neutral:**
- Existing parallel execution (`Promise.all` chunks) is preserved — this adds mid-turn reporting, not new parallelism
- `tool_execution_end` BrainEvents already fire per-call (they just don't reach the model context until now)

## Implementation sketch

```
// In executePendingTools(), after each invokeOne() resolves:
1. Emit tool_execution_end (already done)
2. Inject placeholder tool_result into messages[] with callId
3. At turn boundary (all done): replace placeholders with actual results
```

The placeholder content is machine-readable: `[still-running:${callId}]`. The replacement is a simple string find-and-replace in the messages array before the next provider request.
