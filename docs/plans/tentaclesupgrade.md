Exactly. I had widened the target too much. **Kraken must stay Kraken**: DAG, tentacles, parallelism, worktree, verify/rework. From DSH I would take only some internal mechanisms that can make *this* model much more efficient.

The most important point I see in the current Kraken is this: every tentacle builds a new `SubAgentContext`, then a new `AgentHarness` with `system + user + tools`; moreover the parent receives only the subagent's final conclusion. It is a good isolation architecture, but it means retries, rework and related tasks tend to restart "cold".

### 1. The thing I would really steal from DSH: **continuable tentacles**

DSH introduced the concept of a persistent/continuable child session: the subagent can have a durable session and a reusable activation instead of always being a disposable cognitive process.

This would be extremely strong for Kraken, especially in the cycle:

```text
general writer
      |
verify
      | FAIL
rework
      |
verify
```

Today the rework is still steered as `general`; it reuses the writer's worktree, which is great, but the model is a new tentacle.

I would do:

```text
Writer lineage W1
|
+- turn 1: implementation
|
+- external verifier
|
+- turn 2: "verifier found these issues..."
|
+- external verifier
|
+- possible turn 3
```

**Same writer session/harness.**

This means that at rework the model already has:

- files it has read;
- previous operational/model-visible reasoning;
- decisions made;
- patches applied;
- useful tool results;
- above all the **provider prefix already warm**.

For me this is **absolute P0**.

I would not make sessions continuable for every node. Only for one **lineage**:

```ts
writer root
   +- retry
   +- rework
   +- repair
```

The verifier stays deliberately fresh, so it keeps its independence.

---

### 2. `buildUpstreamContext()` must be transformed from text to an **evidence packet**

Here Kraken already had the right intuition: dependency results are passed downstream with caps of 2800 chars per dependency / 8000 total. But currently `dep.result` is taken as a string and truncated.

This:

```ts
raw.slice(0, cap)
```

is cheap, but semantically blind.

I would steal from DSH the idea that the model-visible surface need not coincide with everything that was produced, and apply it in a **Kraken-native** way. DSH does deterministic pruning of tool results before summarization.

I would have tentacles produce something like:

```ts
interface KrakenEvidence {
  summary: string;

  files: Array<{
    path: string;
    symbols?: string[];
    lines?: [number, number][];
  }>;

  findings: Array<{
    id: string;
    claim: string;
    confidence: number;
  }>;

  decisions?: string[];
  commands?: string[];
  changedFiles?: string[];

  artifacts?: Array<{
    type: 'diff' | 'test' | 'log';
    ref: string;
  }>;
}
```

And downstream:

```text
explore result 12k tokens
        |
KrakenEvidence ~800 tokens
        |
general
```

You do not need LLM summarization: **the tentacle must already close with a structured protocol**.

This would gradually replace `TaskNode.result?: string` with something like:

```ts
result?: string;
evidence?: KrakenEvidence;
```

backward-compatible.

---

### 3. A shared **Kraken Observation Cache** across tentacles

I would not copy this literally from DSH: it is a consequence that fits your architecture particularly well.

You have up to 12 parallel tentacles by default.

It is very likely that several explore/general/verify will independently do:

```text
read package.json
read tsconfig.json
grep AgentHarness
read executor.ts
git diff
...
```

I would add a cache **of observations**, not of LLM responses:

```ts
KrakenObservationCache

key = hash(
  repoSnapshot,
  cwd/worktree,
  tool,
  normalizedArgs
)
```

Example:

```text
tentacle A:
read_file("src/foo.ts")
-> filesystem
-> cache blob SHA abc

tentacle B:
read_file("src/foo.ts")
-> cache hit

tentacle C:
read_file("src/foo.ts")
-> cache hit
```

For read-only tools:

- `read_file`
- `grep_content`
- `list_files`
- `ast_outline`
- `ast_find_symbol`
- LSP read operations
- semantic search

this could be huge.

Simple invalidation:

```text
write/edit/apply_diff
       |
invalidate(path)

git/worktree change
       |
new snapshot namespace
```

This improves **wall-clock and I/O**, and indirectly token usage because you can return already normalized/pruned results.

---

### 4. I would create a **Kraken Request Profile** per tentacle kind

Today `createSubAgentContext()` is explicitly called per invocation and returns provider, model, registry and tool schemas.

I would separate:

```text
today:

createSubAgentContext()
 -> provider
 -> model
 -> ToolRegistry
 -> AgentToolSpec[]
 -> cwd-dependent state
```

into:

```text
KrakenAgentProfile              ExecutionContext
+----------------------+       +----------------------+
provider                        cwd
model                           worktree
systemPrompt                    permissions
toolSchemas                     AbortSignal
generationConfig                registry executors
fingerprint
```

The first is immutable and cached:

```ts
profiles.get('explore')
profiles.get('general')
profiles.get('verify')
```

The second is born per node.

This makes it much easier to guarantee that:

```text
general #1
general #2
general #3
```

have **byte-identical system prompt, tool schemas, tool order and generation config**.

It is the principle behind the prefix-cache stability DSH tries to preserve: changing configurations in front of the new part breaks prefix reusability.

No need to introduce their framework: one structure of yours is enough:

```ts
interface KrakenAgentProfile {
  kind: TaskAgentKind;
  provider: string;
  model: string;

  system: string;
  tools: readonly AgentToolSpec[];

  fingerprint: string;
}
```

---

### 5. I would make the **graph context append-only**, not rewritten

This is another DSH principle worth stealing.

In the planner you have:

```text
Goal
workspace
previousAttempt
```

and the workspace is built as a summary of up to 24 entries.

For a Kraken run I would instead create once:

```ts
KrakenRunContext {
  goal
  repoRoot
  gitHead
  branch
  projectDigest
  relevantInstructions
}
```

with a fingerprint:

```text
krctx:a3d9...
```

and that stays frozen for the whole run.

Nodes only add:

```text
RunContext
+ node prompt
+ dependency evidence
```

they do not continuously rebuild the global description.

The concept corresponds to the DSH distinction between stable context and runtime context materialized only when it changes.

For Kraken this is much simpler than their general system.

---

### 6. Kraken should have **local tool-result pruning**

The parent already receives only the tentacle's final result, so you are already better off than many agent systems.

But *inside* the tentacle a `grep`, test output or compiler output can keep inflating the context window during its 10-20 tool calls. `general/deep`, for example, reach 20 tool calls.

So I would implement a mini Kraken version of the DSH pruner:

```text
tool result < 8k chars
-> keep

tool result > 8k
-> head + salient lines + tail
-> original saved outside the context
```

Even better:

```text
test output:
  FAIL lines
  relevant stack traces
  final summary

grep:
  first N hits per file
  total count

read:
  requested symbol/range
  not the whole file
```

This is probably worth more than an LLM compaction of the tentacle.

---

### 7. I would drastically reduce useless LLM verifiers

Here I would go beyond DSH.

The Kraken planner automatically adds a `verify` for every `general`, and with multiple generals it then creates the merge.

This is correct for quality, but expensive.

Do:

```text
general
  |
deterministic verification
  |
  +- clean -> PASS
  |
  +- ambiguous/risky
        |
      LLM verifier
```

For example:

```text
TypeScript change
-> typecheck + targeted tests + lint

simple rename
-> LSP references + tests

generated file
-> schema validation

UI semantic behavior
-> LLM verifier
```

I would not eliminate the verifier. I would make it an **escalation layer**.

On graphs with 5 writers you could go from:

```text
5 writers
5 LLM verifiers
```

to maybe:

```text
5 writers
5 deterministic verifiers
2 LLM verifiers
```

without losing the Kraken philosophy.

---

## So my priority would be

| Priority | Change | Performance | Tokens | Quality |
|---|---|---:|---:|---:|
| **P0** | Continuable writer lineage | +++ | +++ | +++ |
| **P0** | Structured Evidence Packet | ++ | +++ | +++ |
| **P0** | Shared observation cache | +++ | ++ | ++ |
| **P1** | Stable KrakenAgentProfile | ++ | ++ (cache) | ++ |
| **P1** | Tentacle tool-result pruning | ++ | +++ | ++ |
| **P1** | deterministic-first verification | ++ | +++ | + |
| **P2** | frozen KrakenRunContext | + | ++ | + |

The thing that would truly change Kraken's performance identity is this:

```text
                     KRAKEN
                       |
               +----------------+
               |  Run Context   |
               | frozen + hash  |
               +----------------+
                       |
               +------------------+
               | ObservationCache |
               +------------------+
                       |
       +---------------+---------------+
       |               |               |
   explore         writer A       writer B
     |                 |               |
   evidence        session A      session B
     |                 |               |
     +---------+-------+               |
               |                       |
           verifier                verifier
                       | FAIL
                       |
                 resume writer A
                 <- NOT a new agent
```

**This is the direction I would choose.** Do not copy DSH's SessionSurface, Cordis, plugin architecture etc. I would take from them essentially **continuation + cache-stable prefix + deterministic pruning**, and make them native features of the Kraken DAG.

If I had to implement **only one first**, I would do `continuable writer lineage`: it is probably the one with the best change/benefit ratio because your executor already explicitly has the concept of `reworks`, lineage and inherited worktree. You need to make sure **the writer's memory follows the same lineage the filesystem already follows**.