Yes. I re-checked Zelari's current `main` before setting up the patch. The right direction is an **incremental** refactor: first fix two inconsistencies that interfere with context/cache, then introduce `RequestSnapshot -> RequestMeter -> cache-aware compaction`. DSH uses exactly this conceptual separation: it measures the real request, does model-free pruning, remeasures, and only if needed does summarization by replaying the prefix of the previous request.

## Spec to hand to the coding LLM

### Goal

Implement in Zelari Code a context management pipeline that:

1. measures **the entire request**, not just `history`;
2. tracks the last request actually sent to the provider;
3. leverages the prompt/KV cache during compaction;
4. prunes tool results **before** spending an LLM call;
5. remeasures after every transformation;
6. does not compact just because an arbitrary message count was exceeded;
7. preserves provider/model/tool schema/system prompt exactly whenever possible;
8. exposes useful metrics to understand cache hit/miss.

Do not port the Cordis/plugin architecture from DSH and do not implement a full SessionSurface yet.

---

# P0 - first fix two existing problems

## 0.1 Fix the rolling history bookkeeping

In `useChatTurn.ts` the harness seed is:

```ts
messages: [
  ...systemMessages,
  ...getHistory(),
  { role: "user", content: effectiveUserText },
]
```

but in `finally` the code assumes:

```ts
const seedLen = 1 /*system*/ + historySeedLen + 1 /*user*/;
```

The problem is that `systemMessagesFromSplit()` can return **two** system messages - stable and volatile - and the builder says so explicitly. As a consequence the number of system messages is not necessarily 1.

Moreover, the current logic makes the inclusion of the user message in the rolling history indirectly depend on the number of system messages: with a single system message it is excluded from the slice, with two it can end up included due to the off-by-one.

**Do not simply adjust `1` to `systemMessages.length`.**

Better to eliminate the fragile `historySeedLen`/`seedLen` entirely.

After a successful turn:

```ts
const all = [...harness.getMessages()];

// Initial system prefix is not part of rolling conversation history.
const providerHistory = all.slice(systemMessages.length);

setHistory(providerHistory);
```

So the rolling history must represent:

```text
user
assistant
tool
assistant
tool
...
user
assistant
...
```

and not the initial system prompts.

This also avoids `appendMessages()` + arithmetic on the tail.

**Important:** keep these separate:

```text
providerHistory = model-facing content
displayHistory  = scrubbed content for the UI
```

Never retroactively modify the provider history after it has been sent, otherwise it is no longer possible to reproduce the prefix byte/token-stably.

If `cleanAgentContent()` is also needed for safety before sending text back to the provider, then the cleaning must become a canonical transformation performed **before the request**, not a subsequent mutation.

---

## 0.2 Use the real provider in AgentHarness

Today the single-agent path builds:

```ts
new AgentHarness({
  model: envConfig.model,
  provider: "openai-compatible",
  ...
})
```

even though `envConfig.providerId` can be `deepseek`, `glm`, `grok`, etc.

Change it to:

```ts
provider: envConfig.providerId,
```

The OpenAI-compatible provider does not seem to use `params.provider` to build the body, because the concrete configuration is already in the closure, so this change mainly serves to make snapshots, fingerprints, telemetry and any future routing correct.

---

# P1 - introduce RoutedRequestSnapshot

Suggested new file:

```text
packages/core/src/core/requestSnapshot.ts
```

Types:

```ts
export interface RoutedRequestSnapshot {
  readonly provider: string;
  readonly model: string;

  /** Initial contiguous system prefix. */
  readonly systemMessages: readonly AgentMessage[];

  /** Everything after the initial system prefix. */
  readonly messages: readonly AgentMessage[];

  /** Canonical lexicographic order. */
  readonly tools: readonly AgentToolSpec[];

  /** provider + model + system + tools */
  readonly headerFingerprint: string;

  /** header + messages */
  readonly requestFingerprint: string;

  readonly createdAt: number;
}

export interface RequestUsageSnapshot {
  readonly request: RoutedRequestSnapshot;
  readonly usage: UsageBreakdown;
}
```

Implement:

```ts
export function createRoutedRequestSnapshot(input: {
  provider: string;
  model: string;
  messages: readonly AgentMessage[];
  tools: readonly AgentToolSpec[];
}): RoutedRequestSnapshot;
```

The function must:

```ts
const firstConversationIndex =
  messages.findIndex(m => m.role !== "system");

const systemMessages =
  firstConversationIndex === -1
    ? messages
    : messages.slice(0, firstConversationIndex);

const conversationMessages =
  firstConversationIndex === -1
    ? []
    : messages.slice(firstConversationIndex);

const tools = [...input.tools].sort(
  (a, b) => a.name.localeCompare(b.name)
);
```

Make detached snapshots, ideally with `structuredClone()`.

The tool sorting must be identical to what the OpenAI-compatible provider already does, which currently sorts schemas alphabetically precisely to keep the prompt prefix stable.

For fingerprints use SHA-256 over a deterministic serialization with sorted object keys.

```ts
headerFingerprint = sha256(stableStringify({
  provider,
  model,
  systemMessages,
  tools,
}));

requestFingerprint = sha256(stableStringify({
  headerFingerprint,
  messages,
}));
```

---

# P2 - make the harness observe every request actually sent

Extend `AgentHarnessConfig`:

```ts
interface AgentHarnessConfig {
  ...
  onRequestSnapshot?: (
    snapshot: RoutedRequestSnapshot
  ) => void;
}
```

Immediately **before** every:

```ts
this.config.providerStream(...)
```

create the snapshot.

Do not do it only on the first request: a coding-agent turn can make many consecutive requests through the tool loop. The last hot request is the most interesting one for KV caching. The harness currently calls the provider with the entire `this.config.messages`, model and tools at every step.

I would create an internal method:

```ts
private createProviderStream(
  options?: ProviderGenerationOptions,
  tools: AgentToolSpec[] = this.config.tools,
): AsyncIterable<ProviderDelta> {
  const snapshot = createRoutedRequestSnapshot({
    provider: this.config.provider,
    model: this.config.model,
    messages: this.config.messages,
    tools,
  });

  this.config.onRequestSnapshot?.(snapshot);

  return this.config.providerStream({
    messages: this.config.messages,
    model: this.config.model,
    provider: this.config.provider,
    tools,
    signal: this.activeController?.signal,
    generation: options,
  });
}
```

Use it both in the normal path and in the other provider calls.

---

# P3 - add generation options to ProviderStreamFn

Today `ProviderStreamFn` essentially exposes:

```ts
{
  messages,
  model,
  provider,
  tools,
  signal
}
```

Add:

```ts
export interface ProviderGenerationOptions {
  temperature?: number;
  maxTokens?: number;
  purpose?: "conversation" | "compaction";
}

export type ProviderStreamFn = (params: {
  messages: AgentMessage[];
  model: string;
  provider: string;
  tools: AgentToolSpec[];
  signal?: AbortSignal;
  generation?: ProviderGenerationOptions;
}) => AsyncIterable<ProviderDelta>;
```

In `openai-compatible.ts`:

```ts
const body = {
  model: params.model,
  messages,
  stream: true,
  temperature: params.generation?.temperature ?? 0.7,
  stream_options: { include_usage: true },
};

if (params.generation?.maxTokens != null) {
  body.max_tokens = params.generation.maxTokens;
}
```

Do not put `purpose` in the model-visible prompt.

Adapters that do not support it can ignore the new options.

---

# P4 - RequestSnapshotStore

New file:

```text
src/cli/budget/requestSnapshotStore.ts
```

For now no complex infrastructure:

```ts
const latestRequests = new Map<string, RoutedRequestSnapshot>();
const latestUsage = new Map<string, RequestUsageSnapshot>();

export function recordRequestSnapshot(
  sessionId: string,
  snapshot: RoutedRequestSnapshot,
): void;

export function recordRequestUsage(
  sessionId: string,
  usage: UsageBreakdown,
): void;

export function getLatestRequestSnapshot(
  sessionId: string,
): RoutedRequestSnapshot | undefined;

export function getLatestUsageSnapshot(
  sessionId: string,
): RequestUsageSnapshot | undefined;

export function clearRequestSnapshots(
  sessionId: string,
): void;
```

`recordRequestUsage()` associates the usage with the last request snapshot.

Zelari already has `UsageBreakdown` with `promptTokens`, `completionTokens`, `totalTokens` and `cachedPromptTokens`, and the provider already normalizes the DeepSeek `prompt_cache_hit_tokens` field and the OpenAI-style `prompt_tokens_details.cached_tokens`. So the fundamental data is already available.

In `useChatTurn`:

```ts
onRequestSnapshot: snapshot => {
  recordRequestSnapshot(sessionId, snapshot);
},
```

and when `message_end` arrives:

```ts
if (event.usage) {
  realUsage = event.usage;
  recordRequestUsage(sessionId, event.usage);
}
```

---

# P5 - replace TokenBudget with RequestMeter

Do not delete `tokenBudget.ts` right away; first create:

```text
src/cli/budget/requestMeter.ts
```

Types:

```ts
export interface RequestEnvelope {
  provider: string;
  model: string;
  systemMessages: readonly AgentMessage[];
  messages: readonly AgentMessage[];
  tools: readonly AgentToolSpec[];
}

export interface RequestMeasurement {
  contextLimit: number;

  estimatedPromptTokens: number;
  reservedOutputTokens: number;
  contextPressureTokens: number;
  occupancy: number;

  systemTokens: number;
  toolSchemaTokens: number;
  conversationTokens: number;

  baselineKind: "provider" | "estimated";

  lastProviderPromptTokens?: number;
  lastCachedPromptTokens?: number;
  lastCacheHitRatio?: number;

  estimatedReusablePrefixTokens: number;

  headerFingerprint: string;
}
```

The current `estimateHistoryTokens()` mainly counts `content` and tool calls with the `chars/4` approximation; it does not count system/tool schema as request envelope, nor `reasoningContent`.

The new estimator must include at least:

```text
system message content
conversation content
role/message overhead
tool call name
tool call args
toolCallId
reasoningContent when it will be echoed
tool schema name
tool schema description
tool schema parameters JSON
```

`reasoningContent` matters because Zelari actually sends it back to DeepSeek in assistant turns that have tool calls.

### Provider baseline

Implement the DSH concept:

If:

```ts
baseline.request.headerFingerprint === current.headerFingerprint
```

then use the last real `promptTokens` as the anchor:

```ts
currentPromptEstimate =
  baseline.usage.promptTokens
  + estimateConversation(current.messages)
  - estimateConversation(baseline.request.messages);
```

Clamp:

```ts
Math.max(
  estimateHeader(current),
  currentPromptEstimate,
);
```

This is the simplified Zelari version of the `surfaceDeltaTokens` used by the DSH Token Meter: real usage as baseline when the canonical envelope matches, plus a heuristic delta of the surface.

If the header fingerprint does not match:

```ts
baselineKind = "estimated";
estimatedPromptTokens =
  systemTokens +
  toolSchemaTokens +
  conversationTokens;
```

### Fundamental rule

```ts
contextPressureTokens =
  estimatedPromptTokens + reservedOutputTokens;
```

NOT:

```ts
estimatedPromptTokens - cachedPromptTokens
```

Cached tokens cost less / are faster, but they still occupy context.

---

# P6 - completely change the automatic budget flow

Today `applyBudgetPolicyAsync()` runs before the system prompt and tool schemas are built.

Change the flow to:

```text
resolve provider/model
      v
build tool registry
      v
build stable + volatile system prompt
      v
build effective user message
      v
construct RequestEnvelope
      v
RequestMeter.measure()
      v
context policy
      v
possibly mutate history
      v
rebuild RequestEnvelope
      v
AgentHarness
```

Also remove from the normal hot path:

```ts
compactInPlace();
```

before measurement.

Today `compactInPlace()` still compacts based on message count, regardless of real token pressure.

This can needlessly rewrite the prefix and lose cache even when the model would still have plenty of context left.

`compactInPlace()` can remain as a legacy/manual utility until the call sites are migrated.

---

# P7 - prune -> remeasure -> summarize pipeline

The new `applyBudgetPolicyAsync()` should look more like this:

```ts
let measurement = requestMeter.measure(envelope);

if (measurement.occupancy >= 0.70) {
  warn();
}

if (measurement.occupancy >= 0.80) {
  const pruned = pruneToolResultsDetailed(history);

  if (pruned.stats.pruned > 0) {
    history = pruned.messages;
    envelope = rebuildEnvelope(history);
    measurement = requestMeter.measure(envelope);
  }
}

if (measurement.occupancy >= 0.85) {
  const compacted = await compactHistoryAsync(history, {
    force: true,
    ...
  });

  history = compacted.messages;

  envelope = rebuildEnvelope(history);
  measurement = requestMeter.measure(envelope);
}

if (measurement.occupancy >= 0.95) {
  history = emergencyCompact(history);
  envelope = rebuildEnvelope(history);
  measurement = requestMeter.measure(envelope);
}
```

DSH explicitly does model-free pruning, remeasures and **skips summarization entirely if pruning brought the request back under threshold**.

Zelari already has `pruneToolResultsDetailed()`, so it does not need to be reimplemented.

But fix this comment:

```ts
"preserve the cache prefix"
```

because it is not completely true.

A modified tool result invalidates the old cache prefix **from the first modified token onward**; the preceding prefix remains reusable and the new version can become the new hot prefix in subsequent requests. DSH documents this explicitly.

---

# P8 - fix the compactHistoryAsync trigger

Currently `compactHistoryDetailed()` does not compact if:

```ts
messages.length <= maxMessages * 2
```

even when token occupancy is huge.

Add:

```ts
export interface CompactHistoryOptions {
  ...
  force?: boolean;
}
```

and:

```ts
if (!opts?.force && messages.length <= maxMessages * 2) {
  return unchanged;
}
```

Compaction invoked by **token pressure** must use:

```ts
force: true
```

Later you can drop the `maxMessages`-based selection entirely and move to a `retainTokens`, but it is not mandatory in the first PR.

---

# P9 - rewrite `llmCompact.ts`: no more raw fetch

This is the change with the biggest cache payoff.

Today `llmCompact.ts` creates a standalone HTTP request with:

```text
COMPACT_SYSTEM
+
extractive sketch
+
transcript flattened
```

and it can also pick a different model via `ZELARI_COMPACT_MODEL`.

That is precisely the wrong pattern according to DSH because it destroys the warm prefix: DSH replaced the dedicated system prompt with **original system + tools + conversation prefix + a final user instruction**.

New API:

```ts
export interface CompactionReplayInput {
  providerStream: ProviderStreamFn;

  provider: string;
  model: string;

  systemMessages: readonly AgentMessage[];
  messages: readonly AgentMessage[];
  tools: readonly AgentToolSpec[];

  signal?: AbortSignal;
}

export async function llmSummarizeHistory(
  input: CompactionReplayInput
): Promise<string | null>;
```

Remove from `llmCompact.ts`:

```text
resolveCompactProviderConfig
getProviderConfig
resolveApiKeyWithMeta
PROVIDER_ENDPOINTS
raw fetch
COMPACT_SYSTEM
flattened transcript request
```

Replace `COMPACT_SYSTEM` with:

```ts
export const COMPACTION_INSTRUCTION = `
You are now acting as a compaction engine for this coding-agent session.

Condense the conversation ABOVE into a compact checkpoint sufficient to continue the task.

Preserve:
- user's goal and evolving intent
- decisions already made
- exact file paths and identifiers
- code changes already completed
- commands/errors that still matter
- constraints
- unfinished work
- the single most likely next action

Do not call tools.
Do not mention this summarization request.
Output only the checkpoint.
Be concise.
`.trim();
```

Request:

```ts
const messages: AgentMessage[] = [
  ...input.systemMessages,
  ...input.messages,
  {
    role: "user",
    content: COMPACTION_INSTRUCTION,
  },
];
```

And then:

```ts
let text = "";
let emittedToolCall = false;

for await (const delta of input.providerStream({
  provider: input.provider,
  model: input.model,
  messages,
  tools: [...input.tools],
  signal: input.signal,
  generation: {
    purpose: "compaction",
    temperature: 0.1,
    maxTokens: 900,
  },
})) {
  if (delta.kind === "text") text += delta.delta;
  if (delta.kind === "tool_call") emittedToolCall = true;
}

if (emittedToolCall) return null;
if (!text.trim()) return null;

return text.trim();
```

**Tools must be included even though they are not supposed to be called.**

Removing them changes the prefix token sequence and drastically reduces cache reuse. It is one of DSH's explicit decisions.

---

# P10 - build the replay from the previous request

`compactHistoryAsync()` must receive the last request snapshot:

```ts
opts?: {
  ...
  requestSnapshot?: RoutedRequestSnapshot;
  providerStream?: ProviderStreamFn;
}
```

When it must compact:

```ts
const droppedMsgs = messages.slice(0, cut);
```

build:

```ts
const snapshot = opts.requestSnapshot;

const systemMessages =
  snapshot?.systemMessages ?? [];

const tools =
  snapshot?.tools ?? [];

const provider =
  snapshot?.provider ?? currentProvider;

const model =
  snapshot?.model ?? currentModel;
```

By default **do not use `ZELARI_COMPACT_MODEL`** if your goal is KV-cache efficiency.

You can keep the env override, but it must be explicitly treated as:

```text
cacheReuseExpected = false
```

because a different provider/model is a deliberate trade-off. DSH also allows a different summarization model, but documents that this forfeits cache reuse.

---

# P11 - verify the replay is actually a prefix

I would add:

```ts
export function compareReplayPrefix(
  snapshot: RoutedRequestSnapshot,
  messages: readonly AgentMessage[],
): {
  exact: boolean;
  matchingMessages: number;
  mismatchIndex?: number;
};
```

Do not block compaction when it does not match.

It is for telemetry:

```text
compaction replay:
  provider/model match: yes
  header match: yes
  exact message prefix: yes
  replay messages: 41
  expected KV reuse: ~72k tokens
```

or:

```text
header match: yes
message divergence at: 17
reason: pruned tool result
expected KV reuse: prefix before message 17
```

Cache reuse must be **best effort**, never a correctness precondition.

---

# P12 - the checkpoint must be `user`, not a new `system`

Today Zelari puts the summary as:

```ts
{
  role: "system",
  content: summaryText,
}
```

I would change it to:

```ts
{
  role: "user",
  content:
    "This is an automatically generated checkpoint of earlier conversation. " +
    "Treat it as established context and continue directly.\n\n" +
    "<compacted-summary>\n" +
    summaryText +
    "\n</compacted-summary>",
}
```

It is the same general pattern DSH uses: the checkpoint replaces the old surface as model-visible user context instead of inventing a new system policy block.

Advantages:

```text
stable system
volatile system
checkpoint
recent transcript
current user
```

instead of proliferating system messages that are semantically not policy.

---

# P13 - reject summaries that do not save context

Before committing:

```ts
const sourceTokens = estimateMessages(droppedMsgs);
const summaryTokens = estimateMessage(summaryMessage);

if (summaryTokens >= sourceTokens) {
  // Don't replace useful source with an equal/larger summary.
  fallbackToExtractiveOrHardTrim();
}
```

Even better:

```ts
if (summaryTokens > sourceTokens * 0.65) {
  // optional quality/efficiency threshold
}
```

DSH considers a summary that is not smaller than the content it replaces an error.

---

# P14 - cache metrics

Add at least this information to metrics/debug logs:

```ts
interface RequestCacheMetrics {
  headerFingerprint: string;
  requestFingerprint: string;

  promptTokens?: number;
  cachedPromptTokens?: number;
  cacheHitRatio?: number;

  estimatedPromptTokens: number;
  contextPressureTokens: number;
  occupancy: number;

  estimatedReusablePrefixTokens?: number;

  purpose: "conversation" | "compaction";

  cacheReuseExpected?: boolean;
}
```

Formula:

```ts
cacheHitRatio =
  cachedPromptTokens && promptTokens
    ? cachedPromptTokens / promptTokens
    : undefined;
```

Zelari already collects cached prompt tokens and uses them for cost accounting, so this part mostly requires keeping them together with the fingerprint of the request that produced them.

---

# P15 - do not implement a full SessionSurface yet

Zelari's JSONL is already append-only and batches events efficiently.

For this PR it is enough to keep:

```text
full JSONL log
+
current provider history
+
session_compacted event
```

Optionally extend `session_compacted`:

```ts
interface BrainSessionCompactedEvent {
  type: "session_compacted";
  summary: string;
  messagesRemoved: number;

  sourceRequestFingerprint?: string;
  headerFingerprint?: string;
  sourceEstimatedTokens?: number;
  replacementEstimatedTokens?: number;
  prunedToolResults?: number;
  cacheReuseExpected?: boolean;
}
```

A real `SessionSurface` with append/replace operations can be a later phase. DSH uses it to leave the original events in the log while durably changing the projection the model sees.

---

## Final target flow

The coding LLM should arrive at this:

```text
USER TURN
   |
   v
 resolve provider/model -> build tools
        -> build stable system -> build volatile system
        -> build current user
   |
   v
RequestEnvelope
   |
   v
RequestMeter.measure()
   |
   +-- <70% ------------------> send
   |
   +-- 70-80% -> warn --------> send
   |
   +-- >=80%
         |
         v
    prune old oversized tool results
         |
         v
    remeasure
         |
         +-- safe ------------> send
         |
         +-- >=85%
                |
                v
           select old balanced prefix
                |
                v
       last RoutedRequestSnapshot
                |
                v
       SYSTEM(original)
       TOOLS(original)
       DROPPED MESSAGES(original/pruned)
       USER(compaction instruction)
                |
                v
             summary
                |
                v
       verify summary shrinks
                |
                v
       replace old prefix with checkpoint
                |
                v
              remeasure
                 |
                 +-- safe ----> send
                 |
                 +-- >=95%
                        |
                        v
                  emergency trim
                        |
                        v
                       send
```

## Mandatory tests

I would ask the coding LLM to consider the work incomplete until these cases pass:

```text
1. systemMessages.length = 2 no longer causes wrong history slicing.

2. the single-agent rolling history contains:
   user -> assistant -> tool -> assistant
   and does NOT contain the initial system prompts.

3. the AgentHarness snapshot reports "deepseek", not "openai-compatible",
   when DeepSeek is the real provider.

4. tool schemas in the snapshot are always deterministically sorted.

5. two logically identical RequestEnvelopes produce the same fingerprint.

6. a change to the volatile system changes headerFingerprint.

7. a change only to the tail conversation changes requestFingerprint
   but keeps headerFingerprint.

8. RequestMeter includes system + tools + reasoningContent + history.

9. with compatible provider usage and the same header,
   RequestMeter uses baseline + surface delta.

10. cachedPromptTokens are NOT subtracted from contextPressureTokens.

11. at 80%:
    prune tool result -> remeasure -> occupancy 77%
    => zero summarizer calls.

12. at 88% after pruning:
    => one summarizer call.

13. the summarizer request contains exactly:
    old system prefix
    old tool schemas
    dropped message prefix
    trailing COMPACTION_INSTRUCTION

14. no COMPACT_SYSTEM exists before the conversation.

15. the summarizer uses the same provider/model by default.

16. if ZELARI_COMPACT_MODEL forces a different model:
    cacheReuseExpected === false.

17. a tool call accidentally produced by the summarizer
    => summary rejected / extractive fallback.

18. summary >= source token size
    => it is not committed.

19. no cut may separate:
    assistant(tool_calls) -> tool(result).

20. high token pressure with few huge messages
    still forces compaction.

21. provider-reported cachedPromptTokens keep propagating
    all the way to metrics.

22. /clear and /new also wipe the RequestSnapshotStore.
```

### Commit order I suggest

I would do **5 separate commits**, to allow rollback and benchmarks:

```text
1. fix(context): canonical rolling history and real provider identity
2. feat(context): routed request snapshots and deterministic fingerprints
3. feat(context): full request meter with provider usage baseline
4. feat(compaction): prune-remeasure and cache-aware prefix replay
5. feat(metrics): request/cache observability and regression tests
```

I would not mix SessionSurface, Code Mode or `run_code` into these commits yet.

### Result I would expect

The most important part is not just reducing the token count. It is obtaining this property:

```text
request N:
SYSTEM STABLE
SYSTEM VOLATILE
TOOLS
HISTORY A B C D E F

compaction:
SYSTEM STABLE
SYSTEM VOLATILE
TOOLS
HISTORY A B C D
USER "compact conversation above"
                      ^
             new uncached part
```

instead of the current:

```text
COMPACT_SYSTEM
USER "flattened A B C D"
```

which diverges from the very first token. That is precisely the problem DeepSeek Harness fixed in July 2026.

And there is a second important win: **no more LLM compaction when shortening two huge `read_file`/`grep` outputs is enough**. DSH remeasures after pruning precisely to avoid that call.

I would give the coding LLM **this spec as a first pass** and tell it explicitly: *do not implement SessionSurface or Code Mode until these five commits are green*. Once that is done, the next step I would take is a **second RFC for `observe_batch`/Code Mode**, because that is where another big reduction in context growth can come from during repo explorations with dozens of `grep/read_file` calls.