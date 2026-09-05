# Evaluating the Zelari harness vs others (Artificial Analysis Index style), same model

> **Status:** deferred - to run later.
> **Saved:** 2026-07-12
> **Source:** session plan (AA-style harness eval)

## Question

How to build an index like the **Artificial Analysis Coding Agent Index** to compare **Zelari (the scaffold)** with other agent stacks, **keeping the models fixed**?

## Short answer

Yes, it is feasible - and it is the **right** experiment for a product like Zelari.
The public AA index mostly measures **models** (often at a fixed scaffold like mini-swe-agent).
Your goal is the inverse: **variable scaffold, fixed model** -> a *harness quality* score.

---

## What the AA Coding Agent Index is (reference)

Typical composite (2026 snapshot):

| Component | What it measures |
|------------|-------------|
| **DeepSWE** (~113 tasks) | Long-horizon SWE on real repos, functional verifiers |
| **Terminal-Bench v2** | Shell/machine tasks (Harbor) |
| **SWE-Atlas-QnA** (or similar) | Repo comprehension / Q&A |

Headline = (weighted) average **pass@1** (sometimes cost/time as secondary).

**Limit for you:** on the official leaderboard the harness is often **fixed** to isolate the model.
So you cannot "enter" the AA ranking just by installing Zelari: you can **replicate the methodology** in a private report and declare "Zelari scaffold vs mini-swe / Claude Code / ..., model M".

---

## Experimental principle (mandatory)

| Fixed | Variable |
|-------|-----------|
| Task set + verifier + budget (timeout, max turns, $) | **Harness** (Zelari agent / council / mini-swe / OpenHands / ...) |
| **Same model id** + temperature/default API | - |
| Same OS/container image (ideally) | - |

If you change model and harness together, the comparison is confounded.

---

## Design of a "Zelari Harness Index" (proposal)

### A. Suite (serious minimum, no full AA needed on day one)

| Track | Initial N | Grader | Zelari fit |
|-------|------------|--------|------------|
| **DeepSWE-subset** | 10-20 tasks (e.g. TS/JS) | DeepSWE / Pier verifier | Multi-file coding |
| **Terminal-Bench sample** | 10-15 | Harbor / TB harness | Strong shell |
| **Internal Honesty pack** | 5-10 | Tests + false-success rules | Zelari differentiator |

Then, if budget allows: full DeepSWE + full TB v2 -> an "AA-like" composite.

### B. Arms (harness)

1. **Zelari agent** (`--mode agent --phase build`)
2. **Zelari council** (sample only: 3-5 tasks, high cost)
3. **External baseline** (at least one): mini-swe-agent **same model**, or Claude Code / Aider if alignable on the same provider

### C. Metrics (beyond pass@1)

| Metric | Why |
|---------|--------|
| **pass@1** | AA alignment |
| **cost / task, wall time** | Scaffold efficiency |
| **tool steps** | Thrash |
| **false success** | Done claim + verifier fail / DEGRADED |
| **secrecy fail** (opt.) | Jailbreak prompt leak - product IP |

**Harness Index score** (example):

```
Score = 0.5 * DeepSWE_pass + 0.3 * TB_pass + 0.2 * Honesty_pass
```

Always report: `model`, `harness`, `n`, `pass@1 +/- CI`, `$/task`.

### D. Technical runner for Zelari

Already available:

```bash
zelari-code --headless --mode agent --phase build \
  --task "..." --workdir /repo --provider ... --model ... --output json
```

Needed:

1. A Harbor/Pier adapter (or loop script) that:
   - mounts the task repo
   - launches Zelari headless
   - exports patch / state
   - launches the official verifier
2. YAML manifest: `task_id, workdir, prompt, verify_cmd, timeout`
3. JSON/CSV aggregator -> harness x model table

You do **not** need to enter the AA monorepo; you need **same tasks + same graders**.

---

## How to present it (honesty)

| Wrong phrasing | Correct phrasing |
|-----------------|----------------|
| "We are at 40% on the AA Index" | "On DeepSWE-subset n=12, **Zelari+Grok** pass@1=X% vs **mini-swe+Grok** Y%" |
| "Better than GPT-5.5" | "At fixed model M, Zelari vs scaffold S." |

Publishable as a **blog / whitepaper / internal dashboard**, not as an official AA row (unless AA accepts custom agents).

---

## Cost and order of work

1. **Week 1:** 10 DeepSWE tasks + headless adapter + mini-swe same model
2. **Week 2:** +10 TB + honesty pack + agent vs council table (sample)
3. **After:** full DeepSWE if the harness delta is stable

Full frontier DeepSWE budget: **hundreds-to-thousands of $** per arm; start from a subset.

---

## What Zelari can "win" vs mini-swe

Not just pass@1: **fewer false successes**, recovery, tool quality, plan/build.
If pass@1 is equal but false success and cost are better, the harness index must show it.

---

## Summary

| Question | Answer |
|---------|----------|
| Can I build an AA-like index for the harness? | **Yes**, replicate tasks+graders, fix the models, vary the scaffold |
| Can I use the official AA leaderboard? | **No** as a harness ranking; yes as a **source of tasks/methodology** |
| First concrete step | DeepSWE subset + Pier/script + Zelari headless + mini-swe same-model baseline |

## External references

- [Artificial Analysis Coding Agents](https://artificialanalysis.ai/agents/coding-agents)
- [DeepSWE](https://deepswe.datacurve.ai/) / [datacurve-ai/deep-swe](https://github.com/datacurve-ai/deep-swe)
- [Pier](https://github.com/datacurve-ai/pier) (Harbor-compatible runner)
- Terminal-Bench / Harbor task format