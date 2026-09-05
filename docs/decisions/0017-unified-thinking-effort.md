# ADR-0017 - Unified "thinking effort" selection across providers

**Status:** Proposed - **parked** (triage 2026-09-04, see "Triage outcome" at the bottom)
**Date:** proposed 2026-08-14 (git)

## Context

zelari-code supports 8 providers (`grok`, `glm`, `minimax`, `deepseek`, `openai-compatible`, `chatgpt`, `anthropic`, `custom`) with default models for each (`grok-4.5`, `glm-4.6`, `MiniMax-M2.5`, `deepseek-v4-pro`, `gpt-5.2-codex`, `claude-sonnet-4-5`).

Many of these models are *reasoning-capable*, but expose **different controls** over reasoning:

- OpenAI / xAI -> **enum** `reasoning_effort` (`low`/`medium`/`high`).
- Anthropic -> **token budget** `thinking: { type: "enabled", budget_tokens: N }`.
- DeepSeek / GLM / MiniMax -> **provider-specific** toggles/budgets.

Today **there is no user control** over effort: the provider default applies (e.g. `providerConfig.ts` documents that `grok-4.5` has a default `reasoning_effort` of `high`). The harness already **streams** thinking (`kind: 'thinking'` in `chatgpt.ts` and `anthropic.ts`; scrub of `<think>`/`<thinking>` in `useChatTurn.ts`), but the user cannot choose the effort. Real impact: high effort = more reasoning tokens = slower and more expensive; low effort = faster and cheaper. The user should be able to tune it per model and per phase (plan -> high, build -> low).

## Decision

Introduce a single abstraction **`ThinkingSpec`** and a **per-provider adapter** that translates it into the specific request parameters:

```ts
type ThinkingSpec =
  | 'auto'                                   // default: no parameter sent (provider default)
  | { kind: 'off' }                          // no extended thinking (fast/cheap)
  | { kind: 'effort'; effort: 'low' | 'medium' | 'high' }   // enum (OpenAI/xAI)
  | { kind: 'budget'; budgetTokens: number }                 // token budget (Anthropic/GLM/DeepSeek)
```

Operational rules:

1. **Per-model capability table** (`{ effort?: boolean; budget?: boolean }`): the UI offers only the choices valid for the active model. Sending an unsupported `kind` **degrades to `'auto'`** with a warning, never an error.
2. **Per-provider adapters** at the three request-building points: `openai-compatible.ts` (chat.completions), `chatgpt.ts` (Responses -> `reasoning`), `anthropic.ts` (Messages -> `thinking`).
3. **Control surface:** per-provider persistence in `provider.json` (`providerConfig.ts`), slash command `/effort` (or `/thinking`) and CLI flag `--effort`. Global default `'auto'`.
4. **Per-mode defaults:** plan/council -> high effort, build/agent -> low effort, with user override.

### Current mapping (TO BE VERIFIED at runtime against each API - it changes often)

| Provider | Kind | Request parameter (to confirm) |
|---|---|---|
| `openai-compatible` / `grok` (xAI) | effort | `reasoning_effort`: `low`/`high` |
| `chatgpt` (OpenAI) | effort | Responses: `reasoning.effort`; Chat: `reasoning_effort` |
| `anthropic` | budget | `thinking: { type: "enabled", budget_tokens: N }` |
| `glm` (Z.AI) | budget | `thinking: { type: "enabled", budget_tokens: N }` |
| `deepseek` | toggle/budget | `thinking` / `-reasoner` variant (to verify) |
| `minimax` | effort/budget | provider-specific (to verify) |

## Alternatives considered

1. **Free per-provider `extraBody` passthrough** - rejected: no cross-provider semantics, no validation, no consistent UI.
2. **Only a `low/medium/high` enum for everyone** - rejected: Anthropic/GLM/DeepSeek use token budgets; forcing a fictional enum loses fidelity.
3. **Only token budget** - rejected: OpenAI/xAI do not accept raw budgets, they accept effort enums.

## Consequences

**Positive**

- Uniform cost/latency control across all providers from a single surface.
- Sensible per-mode defaults (plan high, build low).
- The capability table keeps the UI honest (no invalid choices).

**Negative / residual**

- The per-provider mapping must chase APIs that change fast; an unknown mapping degrades silently to `'auto'` - mitigate with a "known mapping version" + warning log.

## TODO

- [ ] Define `ThinkingSpec` + capability table (`canThinking: { effort?, budget? }`) per model.
- [ ] Implement the adapters in the three providers (`openai-compatible`, `chatgpt`, `anthropic`).
- [ ] Add config field in `provider.json`, `/effort` command, `--effort` flag.
- [ ] Verify parameter names live (`reasoning_effort`, `reasoning`, `thinking.budget_tokens`) per provider
      before finalizing the mapping.

## Triage outcome (2026-09-04, task t37/S6)

**Verdict: parked** - neither accepted nor withdrawn. On-disk evidence:

- `ThinkingSpec`, `reasoningEffort`, `reasoning_effort`: **zero occurrences** in `src/` and `packages/core/src/` (grep 2026-09-04); no `--effort` flag, no `/effort` command.
- The described surface (capability table, per-provider adapters, persistence in `provider.json`) was never implemented since the proposal (2026-08-14).

**Reopening conditions:** the competitive benchmark (t31, `bench:competitive` in `tools/eval/`) now measures tokens/cost per run. If the data shows reasoning effort is a significant cost/latency lever across providers, resume this ADR updating the provider mapping. Until then the per-provider defaults already documented in `providerConfig.ts` remain valid.