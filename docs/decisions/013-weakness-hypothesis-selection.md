# 013 — Weakness-based hypothesis selection (Bennett's Razor for Kraken)

> **Status:** accepted (Slice L of `.zelari/docs/kraken-best-in-class-roadmap.md`,
> shipped in v1.31.x — adds the *Weakness* ranking layer to Spec Council and the
> planner).
> **Author:** Mavis (kraken slice L) — 2026-08-08.
> **Source paper:** Bennett, M. T. *The Optimal Choice of Hypothesis Is the
> Weakest, Not the Shortest*. AGI 2023. arXiv:2301.12987v4.

## Context

The Kraken Spec Council (`packages/core/src/kraken/personas/`) routes a writer's
output through three personas — `verify`, `spec`, `conformance` — and gates the
graph on a `VERDICT: PASS|FAIL` trailer plus a per-requirement JSON table. When
all three pass, the executor accepts the candidate; when one fails, it spawns a
bounded rework round.

What the council *cannot* do today is **rank among multiple PASS candidates**.
If two writers (or one writer and its rework) both reach `VERDICT: PASS`, the
engine keeps whichever finished first — but Bennett's 2023 paper gives a
principled, evidence-backed reason to prefer a different one.

### Bennett's formal result (sketch)

In a lattice of declarative programs, the **weakness** of a statement `l` is the
cardinality of its extension `|Z_l|` — the number of statements `l` is a
sub-statement of. For an unknown parent task `ω` of a known child `α`, the
probability of a model `h ∈ M_α` generalising to `ω` is

```
p(h ∈ M_ω | h ∈ M_α, α ⊏ ω) = 2^|Z_{S_α} ∩ Z_h| / 2^|Z_{S_α}|
```

which is monotonically increasing in `|Z_h|`. **The weakest sufficient
hypothesis maximises the probability of generalisation** — and in Bennett's
binary-arithmetic experiments, weakness generalised at **1.1×–5× the rate** of
minimum description length (MDL / Occam).

> "Explanations should be no more specific than necessary." — *Bennett's Razor*

### Why this matters for LLM agents

The paper's most quotable line for an LLM-agent product:

> "The reason why LLMs are so prone to fabrication and inconsistency may be
> because they are optimised only to minimise loss, rather than maximise
> weakness." — Bennett 2023, §6.

LLMs trained to *minimise cross-entropy* are rewarded for being specific
("the file is at line 42 and contains exactly `foo`") — the opposite of
weakness. Kraken, by contrast, *can* be optimised for weakness at the
orchestration layer: between candidate plans, candidate solutions, and
candidate skills, the one that assumes less wins.

## Decision

Adopt a **weakness-based ranking** as a first-class signal across three
plumbing points:

1. **Planner system prompt** — append *Bennett's Razor* as a tie-breaker
   directive. When two valid plans exist, the planner is asked to emit the
   one whose effects are *less specific* (fewer file paths, fewer
   constraints, fewer assumptions about external state). The prompt is
   opt-in via `ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR=1`; default off in
   v1.31.x to avoid disturbing existing plans, on by default from v1.32.x.

2. **Spec Council tie-breaker** — when multiple writers' outputs all reach
   `VERDICT: PASS`, the executor prefers the one with the highest
   `weakness_score` (parser-extracted, see below). Ties broken by
   finish-order. Currently the executor is greedy on finish order; this
   change makes it greedy on weakness-among-PASS.

3. **Skill auto-suggestion** — `skillSuggest.ts` already ranks candidate
   skills by frequency and recency. Add weakness as a third axis: a skill
   whose body is *shorter and more general* (e.g. "edit file" beats "edit
   `.ts` file with jest test above the touched line") ranks above a more
   specific one. Frequency still dominates; weakness is a tie-breaker.

### The `weakness.ts` core module

A new pure module `packages/core/src/kraken/weakness.ts` exports:

- `BENNETTS_RAZOR` — the canonical phrasing, exported as a string for
  inclusion in prompts and documentation.
- `WEAKNESS_METER_PROMPT` — a system prompt that asks a counter-LLM to
  list every *specific assertion* in a candidate solution. Returns a JSON
  `{"specificity": 0..1, "assumptions": [...]}`. `1 - specificity` is
  the weakness score.
- `rankByWeakness(candidates)` — pure ranking over `{id, text,
  extensionSize?, specificityScore?}` records. Strategy:
  1. If `extensionSize` provided → use it directly.
  2. Else if `specificityScore` → use `1 - specificityScore`.
  3. Else → text-length inverse as a last-resort MDL proxy.
  Returns `{candidate, weaknessScore, rank}[]` sorted by weakness desc.
- `measureSpecificity()` — the function the CLI uses to call the
  `WEAKNESS_METER_PROMPT` against a real model. Lives in
  `src/cli/kraken/weaknessMeter.ts` (depends on provider config) so the
  core stays pure.
- `weaknessFromVerdict()` — convenience: scan a persona's free text for
  signals like "this is guaranteed", "exactly", "must be", "always" and
  return a heuristic specificity score. Cheap, no LLM call. Used as the
  *default* tie-breaker when the meter hasn't been run.

### Why a heuristic first, an LLM second

Bennett's `|Z_h|` is uncomputable for natural-language plans: there is no
closed-form way to count "how many possible worlds this plan is consistent
with." Two practical approximations:

- **Heuristic string scan** (free, deterministic, no API call): a
  conservative list of *specificity markers* ("exactly", "must", "always",
  "guaranteed", "line N", "the file is at", "requires X.Y.Z") → high
  specificity. This catches the grossest "over-claiming" cases.
- **LLM meter** (1 extra model call, ~1–3s): the meter prompt asks the
  model to enumerate assumptions explicitly. This is what Bennett's
  formalism would do in the limit, just operationalised for prose.

The heuristic is the default in v1.31.x; the meter is opt-in via
`ZELARI_KRAKEN_WEAKNESS_METER=1`. We start with the heuristic because it
costs nothing and gives a baseline; we promote the meter when we have
evidence the heuristic misranks the kinds of plans the council actually
sees.

## Consequences

### Positive

- **Defensible ranking.** Today's Spec Council has no principled way to
  pick among PASS candidates; weakness gives one with a paper behind it.
- **LLM-fabrication resistance.** The reviewer personas are encouraged
  ("*prefer a less specific verdict*") to flag over-confident claims; the
  executor prefers the most conservative PASS.
- **Best-in-class claim.** Weakness-based ranking is genuinely novel
  among CLI coding agents — none of Claude Code DW, Codex v2, Amp, Gemini
  CLI, OpenCode, or pi-gauntlet implement anything equivalent.

### Negative / risks

- **Heuristic mismatch.** "Specificity markers" are a coarse proxy; a
  reviewer who says "the function *appears* to handle the edge case" is
  *less* specific than one who says "the function handles it" — but the
  heuristic may rank them the other way. Mitigation: the LLM meter is
  opt-in for users who care.
- **Plan's `BENNETTS_RAZOR` directive may reduce specificity too far**,
  producing plans that are too vague to act on. Mitigation: opt-in
  (default off) in v1.31.x, with a metric to track plan-success rate
  before promoting it to default-on.
- **Two ranking layers** (heuristic + meter) is a small surface-area
  cost. Acceptable: both live behind one function and one env var.

### What this is *not*

- **Not a replacement for the verify gate.** Weakness ranks among PASS
  candidates; it does not rescue a FAIL. The trailer is still the gate.
- **Not a replacement for skillSuggest frequency.** Frequency and recency
  remain the dominant signals; weakness is a tie-breaker.
- **Not a guarantee.** Bennett's theorem is conditional on uniform task
  distribution. Real workloads aren't uniform; we ship a useful proxy,
  not a proof.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **(a) Heuristic-first weakness with optional LLM meter** *(chosen)* | Cheap default, principled opt-in upgrade, no API cost in the hot path. | Heuristic is a proxy. |
| (b) Always-run LLM meter | Theoretically cleanest. | +1–3s per Spec Council decision; cumulative cost. |
| (c) Skip weakness; keep greedy on finish order | Zero change. | Misses a free, evidence-backed improvement. |
| (d) Replace Spec Council with a single "weakest-claim wins" agent | Simpler. | Throws away 3-persona coverage (conservative / literal / structured). |

## Implementation pointers

- `packages/core/src/kraken/weakness.ts` — pure module, ≥ 12 tests.
- `packages/core/src/kraken/weakness.test.ts` — covers ranking, ties,
  heuristic scan, meter-prompt shape, `weaknessFromVerdict` cases.
- `src/cli/kraken/weaknessMeter.ts` — CLI-only, calls the meter LLM.
- `src/cli/kraken/planner.ts` — appends `BENNETTS_RAZOR` to the planner
  prompt when `ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR=1`.
- `src/cli/kraken/executor.ts` — on a level where all nodes are `pass`,
  pick the candidate with the highest `weaknessScore` (parsed from
  findings) instead of finish-order. Behind
  `ZELARI_KRAKEN_RANK_BY_WEAKNESS=1`, default on once heuristic is
  validated.
- `src/cli/kraken/skillSuggest.ts` — add `weaknessScore` as a tertiary
  rank key (after frequency, recency).

## Open questions

- Should the planner system prompt be updated to mention *Bennett's
  Razor* by name, or just restate the rule? Naming it grounds the
  behaviour in the paper; restating is provider-agnostic. **Lean:
  restate** (avoid citing a paper the model may not have seen).
- Should `weakness_score` be exposed in the `/kraken workbench` digest?
  Yes — gives users a way to see *why* one PASS beat another.
