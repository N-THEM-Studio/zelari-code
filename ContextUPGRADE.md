Sì. Ho ricontrollato il `main` attuale di Zelari prima di impostare la patch. La direzione giusta è fare un refactor **incrementale**: prima correggere due incongruenze che interferiscono con context/cache, poi introdurre `RequestSnapshot → RequestMeter → cache-aware compaction`. DSH usa esattamente questa separazione concettuale: misura la request reale, fa pruning model-free, rimisura, e solo se serve fa summarization riproducendo il prefisso della request precedente. 

## Specifica da dare al coding LLM

### Obiettivo

Implementare in Zelari Code una pipeline di context management che:

1. misuri **l'intera request**, non solo `history`;
2. tenga traccia dell'ultima request realmente inviata al provider;
3. sfrutti il prompt/KV cache durante la compaction;
4. faccia pruning dei tool result **prima** di spendere una chiamata LLM;
5. rimisuri dopo ogni trasformazione;
6. non compatti solo perché è stato superato un numero arbitrario di messaggi;
7. conservi provider/model/tool schema/system prompt esattamente quando possibile;
8. esponga metriche utili per capire cache hit/miss.

Non portare Cordis/plugin architecture di DSH e non implementare ancora una SessionSurface completa.

---

# P0 — prima correggere due problemi esistenti

## 0.1 Correggere il bookkeeping della rolling history

In `useChatTurn.ts` il seed dell'harness è:

```ts
messages: [
  ...systemMessages,
  ...getHistory(),
  { role: "user", content: effectiveUserText },
]
```

ma nel `finally` il codice assume:

```ts
const seedLen = 1 /*system*/ + historySeedLen + 1 /*user*/;
```

Il problema è che `systemMessagesFromSplit()` può restituire **due** messaggi system — stable e volatile — e lo dice esplicitamente il builder. Di conseguenza il numero di messaggi system non è necessariamente 1. 

Inoltre la logica attuale rende l'inclusione del messaggio user nella rolling history dipendente indirettamente dal numero di system messages: con un solo system viene escluso dalla slice, con due può finire incluso per effetto dell'off-by-one. 

**Non aggiustare semplicemente `1` → `systemMessages.length`.**

Meglio eliminare completamente il fragile `historySeedLen`/`seedLen`.

Dopo un turno riuscito:

```ts
const all = [...harness.getMessages()];

// Initial system prefix is not part of rolling conversation history.
const providerHistory = all.slice(systemMessages.length);

setHistory(providerHistory);
```

Quindi la rolling history deve rappresentare:

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

e non i system prompt iniziali.

Questo evita anche `appendMessages()` + aritmetica sulla tail.

**Importante:** mantenere separati:

```text
providerHistory = contenuto model-facing
displayHistory  = contenuto scrubbed per UI
```

Non modificare retroattivamente il provider history dopo che è stato inviato, altrimenti non è più possibile riprodurre byte/token-stabilmente il prefix.

Se `cleanAgentContent()` è necessario anche per sicurezza prima di rimandare testo al provider, allora il cleaning deve diventare una trasformazione canonica effettuata **prima della request**, non una mutazione successiva.

---

## 0.2 Usare il provider reale nell'AgentHarness

Oggi il single-agent path costruisce:

```ts
new AgentHarness({
  model: envConfig.model,
  provider: "openai-compatible",
  ...
})
```

anche se `envConfig.providerId` può essere `deepseek`, `glm`, `grok`, ecc. 

Cambiare in:

```ts
provider: envConfig.providerId,
```

Il provider OpenAI-compatible non sembra utilizzare `params.provider` per costruire il body, perché la configurazione concreta è già nella closure, quindi questa modifica serve soprattutto a rendere corretti snapshot, fingerprint, telemetry ed eventuale routing futuro. 

---

# P1 — introdurre RoutedRequestSnapshot

Nuovo file suggerito:

```text
packages/core/src/core/requestSnapshot.ts
```

Tipi:

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

Implementare:

```ts
export function createRoutedRequestSnapshot(input: {
  provider: string;
  model: string;
  messages: readonly AgentMessage[];
  tools: readonly AgentToolSpec[];
}): RoutedRequestSnapshot;
```

La funzione deve:

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

Fare snapshot detached, idealmente con `structuredClone()`.

Il sorting dei tool deve essere identico a quello già fatto nel provider OpenAI-compatible, che attualmente ordina alfabeticamente gli schema proprio per mantenere stabile il prompt prefix. 

Per fingerprint usare SHA-256 su una serializzazione deterministica con chiavi degli object ordinate.

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

# P2 — far osservare all'harness ogni request realmente inviata

Estendere `AgentHarnessConfig`:

```ts
interface AgentHarnessConfig {
  ...
  onRequestSnapshot?: (
    snapshot: RoutedRequestSnapshot
  ) => void;
}
```

Immediatamente **prima** di ogni:

```ts
this.config.providerStream(...)
```

creare lo snapshot.

Non farlo solo sulla prima request: un coding-agent turn può fare molte request consecutive attraverso il tool loop. L'ultima request calda è quella più interessante per KV caching. L'harness attualmente richiama il provider con l'intero `this.config.messages`, model e tools ad ogni step. 

Creerei un metodo interno:

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

Usarlo sia nel path normale sia negli altri provider calls.

---

# P3 — aggiungere generation options a ProviderStreamFn

Oggi `ProviderStreamFn` espone sostanzialmente:

```ts
{
  messages,
  model,
  provider,
  tools,
  signal
}
``` 


Aggiungere:

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

Non mettere `purpose` nel model-visible prompt.

Gli adapter che non lo supportano possono ignorare le nuove option.

---

# P4 — RequestSnapshotStore

Nuovo file:

```text
src/cli/budget/requestSnapshotStore.ts
```

Per ora niente infrastruttura complessa:

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

`recordRequestUsage()` associa l'usage all'ultimo request snapshot.

Zelari ha già `UsageBreakdown` con `promptTokens`, `completionTokens`, `totalTokens` e `cachedPromptTokens`, e il provider normalizza già il campo DeepSeek `prompt_cache_hit_tokens` e quello OpenAI-style `prompt_tokens_details.cached_tokens`. Quindi il dato fondamentale è già disponibile. 

Nel `useChatTurn`:

```ts
onRequestSnapshot: snapshot => {
  recordRequestSnapshot(sessionId, snapshot);
},
```

e quando arriva `message_end`:

```ts
if (event.usage) {
  realUsage = event.usage;
  recordRequestUsage(sessionId, event.usage);
}
```

---

# P5 — sostituire TokenBudget con RequestMeter

Non cancellare subito `tokenBudget.ts`; creare prima:

```text
src/cli/budget/requestMeter.ts
```

Tipi:

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

L'attuale `estimateHistoryTokens()` conta principalmente `content` e tool calls con l'approssimazione `chars/4`; non conta system/tool schema come request envelope né `reasoningContent`. 

Il nuovo estimator deve includere almeno:

```text
system message content
conversation content
role/message overhead
tool call name
tool call args
toolCallId
reasoningContent quando sarà echoed
tool schema name
tool schema description
tool schema parameters JSON
```

`reasoningContent` è importante perché Zelari lo rimanda effettivamente a DeepSeek nei turni assistant che hanno tool calls. 

### Provider baseline

Implementare il concetto DSH:

Se:

```ts
baseline.request.headerFingerprint === current.headerFingerprint
```

allora utilizzare l'ultimo `promptTokens` reale come anchor:

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

Questa è la versione Zelari semplificata del `surfaceDeltaTokens` usato dal Token Meter di DSH: usage reale come baseline quando l'envelope canonico coincide, più delta euristico della surface. 

Se l'header fingerprint non coincide:

```ts
baselineKind = "estimated";
estimatedPromptTokens =
  systemTokens +
  toolSchemaTokens +
  conversationTokens;
```

### Regola fondamentale

```ts
contextPressureTokens =
  estimatedPromptTokens + reservedOutputTokens;
```

NON:

```ts
estimatedPromptTokens - cachedPromptTokens
```

I cached tokens costano meno/sono più veloci, ma continuano a occupare context.

---

# P6 — cambiare completamente il flusso automatico del budget

Oggi `applyBudgetPolicyAsync()` viene eseguito prima della costruzione di system prompt e tool schemas. 

Cambiare il flusso a:

```text
resolve provider/model
      ↓
build tool registry
      ↓
build stable + volatile system prompt
      ↓
build effective user message
      ↓
construct RequestEnvelope
      ↓
RequestMeter.measure()
      ↓
context policy
      ↓
possibly mutate history
      ↓
rebuild RequestEnvelope
      ↓
AgentHarness
```

Inoltre rimuovere dal normale hot path:

```ts
compactInPlace();
```

prima della misurazione.

Oggi `compactInPlace()` fa ancora compaction sulla base del numero di messaggi, indipendentemente dalla pressione token reale. 

Questo può riscrivere inutilmente il prefix e perdere cache anche quando il modello avrebbe ancora molto contesto.

`compactInPlace()` può rimanere come utility legacy/manuale finché i call site non sono migrati.

---

# P7 — pipeline prune → remeasure → summarize

La nuova `applyBudgetPolicyAsync()` deve essere più simile a:

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

DSH fa esplicitamente pruning model-free, rimisura e **salta completamente la summarization se il pruning ha riportato la request sotto soglia**. 

Zelari ha già `pruneToolResultsDetailed()`, quindi non bisogna reimplementarlo. 

Correggere però questo commento:

```ts
"preserve the cache prefix"
```

perché non è completamente vero.

Un tool result modificato invalida il vecchio cache prefix **dal primo token modificato in poi**; il prefix precedente rimane riutilizzabile e la nuova versione può diventare il nuovo prefix caldo nelle request successive. DSH lo documenta esplicitamente. 

---

# P8 — correggere il trigger di compactHistoryAsync

Attualmente `compactHistoryDetailed()` non compatta se:

```ts
messages.length <= maxMessages * 2
```

anche se l'occupancy token è enorme. 

Aggiungere:

```ts
export interface CompactHistoryOptions {
  ...
  force?: boolean;
}
```

e:

```ts
if (!opts?.force && messages.length <= maxMessages * 2) {
  return unchanged;
}
```

La compaction invocata dalla **token pressure** deve usare:

```ts
force: true
```

Successivamente potrai eliminare del tutto la selezione basata su `maxMessages` e passare a un `retainTokens`, ma non è obbligatorio nel primo PR.

---

# P9 — riscrivere `llmCompact.ts`: niente più raw fetch

Questa è la modifica con il maggiore ritorno sulla cache.

Oggi `llmCompact.ts` crea un HTTP request autonomo con:

```text
COMPACT_SYSTEM
+
extractive sketch
+
transcript flattened
```

e può inoltre scegliere un model diverso tramite `ZELARI_COMPACT_MODEL`. 

È precisamente il pattern corretto da DSH perché distrugge il warm prefix: DSH ha sostituito il system prompt dedicato con **system + tools + conversation prefix originali + una user instruction finale**. 

Nuova API:

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

Eliminare da `llmCompact.ts`:

```text
resolveCompactProviderConfig
getProviderConfig
resolveApiKeyWithMeta
PROVIDER_ENDPOINTS
raw fetch
COMPACT_SYSTEM
flattened transcript request
```

Sostituire `COMPACT_SYSTEM` con:

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

E poi:

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

**I tools devono essere inclusi anche se non devono essere chiamati.**

Toglierli modifica il prefix token sequence e riduce drasticamente il cache reuse. È una delle decisioni esplicite del fix DSH. 

---

# P10 — costruire il replay dalla request precedente

`compactHistoryAsync()` deve ricevere l'ultima request snapshot:

```ts
opts?: {
  ...
  requestSnapshot?: RoutedRequestSnapshot;
  providerStream?: ProviderStreamFn;
}
```

Quando deve compattare:

```ts
const droppedMsgs = messages.slice(0, cut);
```

costruire:

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

Per default **non usare `ZELARI_COMPACT_MODEL`** se il tuo scopo è KV-cache efficiency.

Puoi mantenere l'env override, ma deve essere trattato esplicitamente come:

```text
cacheReuseExpected = false
```

perché un altro provider/model rappresenta un trade-off volontario. Anche DSH consente un summarization model diverso, ma documenta che così si rinuncia al cache reuse. 

---

# P11 — verificare che il replay sia realmente un prefix

Aggiungerei:

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

Non bloccare la compaction se non coincide.

Serve per telemetry:

```text
compaction replay:
  provider/model match: yes
  header match: yes
  exact message prefix: yes
  replay messages: 41
  expected KV reuse: ~72k tokens
```

oppure:

```text
header match: yes
message divergence at: 17
reason: pruned tool result
expected KV reuse: prefix before message 17
```

Il cache reuse deve essere **best effort**, mai una precondizione di correttezza.

---

# P12 — il checkpoint deve essere `user`, non nuovo `system`

Oggi Zelari mette il summary come:

```ts
{
  role: "system",
  content: summaryText,
}
``` 


Cambierei in:

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

È lo stesso pattern generale usato da DSH: il checkpoint sostituisce la vecchia surface come model-visible user context anziché inventare un nuovo system policy block. 

Vantaggi:

```text
stable system
volatile system
checkpoint
recent transcript
current user
```

anziché proliferare system messages che semanticamente non sono policy.

---

# P13 — rifiutare summary che non fanno risparmiare context

Prima di commit:

```ts
const sourceTokens = estimateMessages(droppedMsgs);
const summaryTokens = estimateMessage(summaryMessage);

if (summaryTokens >= sourceTokens) {
  // Don't replace useful source with an equal/larger summary.
  fallbackToExtractiveOrHardTrim();
}
```

Meglio ancora:

```ts
if (summaryTokens > sourceTokens * 0.65) {
  // optional quality/efficiency threshold
}
```

DSH considera errore una summary che non è più piccola del contenuto che sostituisce. 

---

# P14 — metriche cache

Aggiungere almeno queste informazioni ai metrics/debug logs:

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

Zelari raccoglie già i cached prompt tokens e li usa per il cost accounting, quindi questa parte richiede soprattutto conservarli insieme al fingerprint della request che li ha prodotti. 

---

# P15 — non implementare ancora SessionSurface completa

Il JSONL di Zelari è già append-only e batcha gli eventi in modo efficiente. 

Per questo PR basta mantenere:

```text
full JSONL log
+
current provider history
+
session_compacted event
```

Eventualmente estendere `session_compacted`:

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

Una vera `SessionSurface` con operazioni append/replace può essere una fase successiva. DSH la usa per lasciare gli eventi originali nel log ma cambiare in modo durabile la proiezione vista dal modello. 

---

## Flusso target finale

Il coding LLM dovrebbe arrivare a questo:

```text
USER TURN
   │
   ├─ resolve provider/model
   ├─ build tools
   ├─ build stable system
   ├─ build volatile system
   ├─ build current user
   │
   ▼
RequestEnvelope
   │
   ▼
RequestMeter.measure()
   │
   ├── <70% ──────────────────────────────► send
   │
   ├── 70–80% ── warn ───────────────────► send
   │
   └── >=80%
          │
          ▼
      prune old oversized tool results
          │
          ▼
      remeasure
          │
          ├── safe ───────────────────────► send
          │
          └── >=85%
                 │
                 ▼
            select old balanced prefix
                 │
                 ▼
       last RoutedRequestSnapshot
                 │
                 ▼
       SYSTEM(original)
       TOOLS(original)
       DROPPED MESSAGES(original/pruned)
       USER(compaction instruction)
                 │
                 ▼
             summary
                 │
                 ▼
        verify summary shrinks
                 │
                 ▼
       replace old prefix with checkpoint
                 │
                 ▼
              remeasure
                 │
                 ├── safe ────────────────► send
                 │
                 └── >=95%
                        │
                        ▼
                  emergency trim
                        │
                        ▼
                       send
```

## Test obbligatori

Chiederei al coding LLM di considerare il lavoro incompleto finché non passano questi casi:

```text
1. systemMessages.length = 2 non causa più history slicing errato.

2. single-agent rolling history contiene:
   user → assistant → tool → assistant
   e NON contiene i system prompt iniziali.

3. AgentHarness snapshot riporta "deepseek", non "openai-compatible",
   quando DeepSeek è il provider reale.

4. Tool schemas nello snapshot sono sempre ordinati deterministicamente.

5. Due RequestEnvelope logicamente identici producono lo stesso fingerprint.

6. Una modifica al volatile system cambia headerFingerprint.

7. Una modifica soltanto alla tail conversation cambia requestFingerprint
   ma mantiene headerFingerprint.

8. RequestMeter include system + tools + reasoningContent + history.

9. Con usage provider compatibile e stesso header,
   RequestMeter usa baseline + surface delta.

10. cachedPromptTokens NON vengono sottratti da contextPressureTokens.

11. A 80%:
    prune tool result → remeasure → occupancy 77%
    => zero chiamate summarizer.

12. A 88% dopo pruning:
    => una chiamata summarizer.

13. La request summarizer contiene esattamente:
    old system prefix
    old tool schemas
    dropped message prefix
    trailing COMPACTION_INSTRUCTION

14. Non esiste un COMPACT_SYSTEM prima della conversation.

15. Il summarizer usa stesso provider/model per default.

16. Se ZELARI_COMPACT_MODEL forza altro model:
    cacheReuseExpected === false.

17. Tool call prodotto accidentalmente dal summarizer
    => summary rejected/fallback extractive.

18. Summary >= source token size
    => non viene committata.

19. Nessun cut può separare:
    assistant(tool_calls) → tool(result).

20. High token pressure con pochi messaggi enormi
    forza comunque la compaction.

21. Provider-reported cachedPromptTokens continua a propagarsi
    fino alle metriche.

22. /clear e /new cancellano anche RequestSnapshotStore.
```

### Ordine dei commit che suggerisco

Farei **5 commit separati**, per permettere rollback e benchmark:

```text
1. fix(context): canonical rolling history and real provider identity
2. feat(context): routed request snapshots and deterministic fingerprints
3. feat(context): full request meter with provider usage baseline
4. feat(compaction): prune-remeasure and cache-aware prefix replay
5. feat(metrics): request/cache observability and regression tests
```

Non mescolerei ancora SessionSurface, Code Mode o `run_code` in questi commit.

### Risultato che mi aspetterei

La parte più importante non è solo ridurre il numero di token. È ottenere questa proprietà:

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
                      ↑
             nuova parte uncached
```

invece dell'attuale:

```text
COMPACT_SYSTEM
USER "flattened A B C D"
```

che diverge dal primo token. È precisamente il problema che DeepSeek Harness ha corretto nel luglio 2026. 

E c'è una seconda vittoria importante: **non fare più LLM compaction quando basta accorciare due `read_file`/`grep` enormi**. DSH rimisura dopo il pruning proprio per evitare quella chiamata. 

Io darei al coding LLM **questa specifica come primo pass** e gli direi esplicitamente: *non implementare SessionSurface o Code Mode finché questi cinque commit non sono verdi*. Una volta fatto questo, il passo successivo che farei è una **seconda RFC per `observe_batch`/Code Mode**, perché è lì che puoi ottenere un'altra grossa riduzione di context growth durante esplorazioni repo con decine di `grep/read_file`.
