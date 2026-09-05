# ADR-0006: Real Lucifero chairman synthesis

- **Status:** Accepted
- **Proposed:** 2026-07-02
- **Accepted:** 2026-07-02 (self-accepted with the v0.6.0 release; the chairman was already defined in `roles.ts:175-` and the `onSynthesisStart`/`onSynthesisChunk`/`onSynthesisDone` callbacks were already present in `councilApi.ts:115-117`, so the stub was the only missing part)
- **Author:** MiniMax-M3
- **Depends on:** [ADR-0005](0005-deprecate-legacy-src-paths.md) (for the stable subpaths used by test Slice 3)

## Context

`Lucifero` (the "Final Synthesizer", ninth circle of Dante's Inferno) was declared in `packages/core/src/agents/roles.ts:175-203` with a detailed systemPrompt, but in `councilApi.ts:528-557` its execution was a **stub**:

```ts
// Lucifero synthesis (Phase 13 will add full chairman integration)
if (chairman && !completedIds.has(chairman.id)) {
  callbacks.onSynthesisStart?.();
  callbacks.onSynthesisDone?.('Lucifero synthesis: see agent outputs above.');
  emitMemberCost({ memberId: chairman.id, name: chairman.name,
    usage: null, durationMs: 0, toolCalls: 0, errored: false });
  yield createBrainEvent('member_cost', ...);
}
```

Operational consequences before v0.6.0:

1. The council returned only the 5 specialists (and Minosse if `debateMode: true`). No real final synthesis.
2. The `onSynthesisChunk` callback was never called, so the typewriter effect on the TUI did not exist.
3. `durationMs: 0` and `usage: null` fooled `councilCost.ts` which did not count the chairman.
4. The "Lucifero" header never appeared in ChatStream because no events with `memberId='lucifer'` were emitted.

## Decision

Promote the chairman to a real `AgentHarness` invocation, identical to the 5-specialist pattern (lines 322-389 of `councilApi.ts`):

1. **Context construction.** `buildAgentMessages(chairman, userMessage, ..., agentOutputs, ...)` is called with `agentOutputs` (outputs of the 5 specialists and Minosse) as `priorOutputs`. The chairman therefore receives a prompt that contains the synthesis of all previous members - exactly like the specialists received their predecessors.

2. **Tool calls.** `computeAgentTools(chairman, aiConfig)` + `getProviderTools(...)` as for the specialists. The chairman can therefore create workspace artifacts (phase/task/idea/risk/document) when its systemPrompt requires it.

3. **Streaming.** For every `event` emitted by the chairman:
   - `tool_execution_start` -> increments `toolCalls`.
   - `message_end` with `usage` -> captures the token breakdown.
   - `message_delta` -> accumulates `fullText` + calls `callbacks.onSynthesisChunk(delta)` for the typewriter effect.
   - `error` with `severity !== 'cancelled'` -> marks `errored = true` (the AgentHarness internally captures provider errors and re-emits them as a BrainErrorEvent; we must not lose this signal).

4. **Robustness.** If the chairman LLM fails, the council run does NOT abort. The 5 specialist outputs remain available as the fallback synthesis. The `lucifer` member is marked `errored: true` in `member_cost` and `onSynthesisDone` receives a textual marker: `[Chairman synthesis failed: <reason>]`.

5. **Visible reasoning.** `memberId: 'lucifer'` and `memberName: 'Lucifero'` are passed to `AgentHarness` (via v0.5.0's `memberFields()`) -> ChatStream renders the Lucifero header in purple (#8b5cf6) automatically, with no rendering changes.

6. **Backward compat.** `councilSize: 3` (default) still **excludes** Lucifero (he is the 6th member in `getCouncilAgents(6)`). Existing tests with `councilSize: 3` see no regressions. Activating the chairman requires `councilSize: 6` (or, in the future, a dedicated flag).

## Alternatives considered

- **Keep the stub and document it as "by design"**: rejected because the user pays for a synthesis that does not exist, and an empty `onSynthesisChunk` is a lying API.
- **Chairman as a separate LLM (not AgentHarness)**: rejected for consistency with the specialists and to reuse automatic tool execution.
- **Chairman as a deterministic merge of the 5 outputs (no LLM)**: rejected because Lucifero's systemPrompt explicitly requires reasoning over conflicts, priorities, and applying Minosse's feedback - it is not a simple concatenation.

## Consequences

**Positive**
- The user receives a real synthesis (5 specialists + Minosse + Lucifero = 6 voices).
- The council run is now consistent with the documentation and with the systemPrompts defined in `roles.ts`.
- `councilCost` can include the chairman in totals (real durationMs and token usage).
- The TUI can show a typewriter effect during the synthesis.

**Negative / risks**
- +1 LLM invocation for every `dispatchCouncil` with `councilSize: 6` -> cost and latency increase. Mitigation: users who want speed can use `councilSize: 3` (no chairman) or, in the future, a `--no-chairman` flag.
- If the chairman LLM is configured differently from the specialists (heavier model), council time grows. The same `config.model` is used, so there is no difference by default.

## TODO

- [x] Slice 1: real chairman with harness.run + streaming.
- [x] Slice 2: visible reasoning (memberId/memberName -> ChatStream). Implemented for free by the already existing v0.5 pattern.
- [x] Slice 3: 7 unit + E2E tests (`council-chairman.test.ts`).
- [ ] Slice 4 (grounding helper `groundCouncil()`): moved to v0.6.1. It was described in the v0.6 plan but is additional scope; better an atomic chairman release.
- [ ] CLI flag `--no-chairman` to skip Lucifero without dropping to `councilSize: 3` (Low Ego: is it really needed? let's see if users ask for it).