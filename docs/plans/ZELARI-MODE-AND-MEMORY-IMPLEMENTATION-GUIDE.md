# Guida implementazione: Zelari-mode + Memoria (LanceDB / SQLite)

> **Stato:** piano di lavoro (non ancora implementato)  
> **Versione target:** zelari-code v0.8.x → v0.9.x  
> **Autore:** N-THEM Studio / derivato da sessioni di design 2026-07  
> **Repo:** [N-THEM-Studio/zelari-code](https://github.com/N-THEM-Studio/zelari-code)

---

## Indice

1. [Visione e obiettivi](#1-visione-e-obiettivi)
2. [Tre modalità CLI](#2-tre-modalità-cli)
3. [Zelari-mode — architettura](#3-zelari-mode--architettura)
4. [Mission brief e orchestratore prompt](#4-mission-brief-e-orchestratore-prompt)
5. [Skill router e builtin N-THEM](#5-skill-router-e-builtin-n-them)
6. [Memoria: LanceDB + SQLite (graph light)](#6-memoria-lancedb--sqlite-graph-light)
7. [MemPalace (opzionale)](#7-mempalace-opzionale)
8. [Integrazione council e agent](#8-integrazione-council-e-agent)
9. [Limiti contesto e compaction](#9-limiti-contesto-e-compaction)
10. [Configurazione e variabili d'ambiente](#10-configurazione-e-variabili-dambiente)
11. [Piano di implementazione per fasi](#11-piano-di-implementazione-per-fasi)
12. [Test e criteri di accettazione](#12-test-e-criteri-di-accettazione)
13. [Rischi e mitigazioni](#13-rischi-e-mitigazioni)
14. [Appendice: schema dati e tool API](#14-appendice-schema-dati-e-tool-api)

---

## 1. Visione e obiettivi

### Problema attuale

- **Council** = un run (6 specialisti + Lucifero), poi stop. Non adatto a prodotti interi da un solo prompt.
- **Skill** = invocazione manuale (`/skill`); cataloghi separati (council vs coding); nessun router automatico.
- **Contesto** = JSONL + `/compact` (drop messaggi), non memoria semantica. Loop multi-run esplodono token o perdono decisioni.
- **Greenfield in italiano** (`costruisci`, `crea`) non attiva design-phase senza keyword EN esplicite.
- **Prompt utente** può essere vago; manca un layer che strutturi intent, scope e assunzioni.

### Obiettivo

L’utente scrive **un prompt libero** (qualsiasi dominio — es. gestionale BnB, giochi, SaaS, refactor su repo esistente). Il sistema:

1. **Migliora / struttura** la richiesta (mission brief, opzionale conferma utente).
2. Esegue **Zelari-mode**: loop di council (e se necessario agent) fino a **completamento dello slice corrente** secondo `CouncilCompletion.ok` e piano in `.zelari/`.
3. **Seleziona skill automaticamente** (Taste + glasspetrae per UI, planning, handoff, ecc.).
4. **Persiste e recupera memoria** (hybrid search + graph light) tra slice e tra sessioni.
5. Aumenta **tool budget** su Lucifero nei run lunghi.

### Non-obiettivi (v1)

- Prodotto “100% finito” in un loop infinito senza definizione di slice.
- Graph RAG pesante / Ruvector nativo.
- Sostituire `.zelari/plan.json` con il vector store (il piano resta SSOT strutturato).

---

## 2. Tre modalità CLI

| Modalità | `ChatMode` | Uso |
|----------|------------|-----|
| **agent** | `'agent'` | Domande rapide, patch, esplorazione |
| **council** | `'council'` | Un run deliberato (design **o** implementation) |
| **zelari** | `'zelari'` | Missione autonoma multi-run fino a gate di completamento |

### UX

- **Shift+Tab:** ciclo `agent` → `council` → `zelari` (estendere `StatusBar.tsx`, `InputBar`, `useChatTurn`).
- **Status bar:** `zelari · slice 2/5 · impl · completion: FAIL(motion)` (esempio).
- **Slash:** `/zelari <prompt>` equivalente a mode zelari + dispatch.
- **Stop:** `/stop`, Ctrl+C con salvataggio `HANDOFF.md` + `memory_add` + `.zelari/mission-state.json`.

### Headless (fase successiva)

- `zelari-code --zelari --task "..." --yes` per CI / run notturni.

---

## 3. Zelari-mode — architettura

```
                    ┌─────────────────────┐
                    │  Prompt utente      │
                    └──────────┬──────────┘
                               ▼
                    ┌─────────────────────┐
                    │ Mission classifier   │
                    │ + Mission brief      │
                    │ + Skill router       │
                    └──────────┬──────────┘
                               ▼
              ┌────────────────┴────────────────┐
              │ Greenfield / no plan?           │
              │  → Council design-phase (opt.)  │
              └────────────────┬────────────────┘
                               ▼
         ┌─────────────────────────────────────────┐
         │ LOOP fino stop                            │
         │  1. memory_search(brief + query)        │
         │  2. pick slice da plan.json              │
         │  3. Council implementation (scope=slice)  │
         │  4. postCouncilHook → completion.json    │
         │  5. memory_add(handoff slice)             │
         │  6. se ok → next slice; else fix-turn     │
         └─────────────────────────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │ mission-state.json   │
                    │ HANDOFF (opz.)       │
                    └─────────────────────┘
```

### Stop conditions

| Condizione | Comportamento |
|------------|---------------|
| Tutti i task **high** del piano completati (configurabile) | Success |
| `maxMissionIterations` raggiunto | Stop + handoff |
| Token / wall-clock budget | Stop + handoff |
| Utente `/stop` | Stop graceful |
| `completion.ok === true` per slice MVP definito nel brief | Success MVP |

**“Completamento”** = `CouncilCompletion.ok` per **lo slice corrente** + aggiornamento `plan.json`, non “tutto il backlog mondiale”.

### File nuovi (indicativi)

| Path | Ruolo |
|------|--------|
| `packages/core/src/council/mission.ts` | Classifier greenfield / extend / fix |
| `packages/core/src/council/missionBrief.ts` | Generazione brief strutturato |
| `src/cli/skillRouter.ts` | Match prompt → skillIds per ruolo |
| `src/cli/zelariMission.ts` | State machine loop |
| `.zelari/mission-state.json` | Iterazione, slice corrente, budget |

---

## 4. Mission brief e orchestratore prompt

### Output del brief (schema)

```typescript
interface MissionBrief {
  intent: 'greenfield' | 'extend' | 'fix' | 'redesign';
  runModeHint: 'design-phase' | 'implementation' | 'hybrid';
  stackInferred: string[];           // es. react, laravel
  deliverableThisMission: string;    // 1-2 frasi
  assumptions: string[];             // es. pagamenti = stub Stripe
  outOfScope: string[];
  skillPack: string[];               // id skill da router
  phases: Array<{ name: string; mode: CouncilRunMode }>;
  slices: Array<{ id: string; title: string; taskIds?: string[] }>;
  userPromptOriginal: string;
}
```

### Due livelli

| Livello | Quando | Azione |
|---------|--------|--------|
| **A — Brief strutturato** | Quasi sempre | Regole + euristiche + (opz.) 1 chiamata LLM leggera |
| **B — Polish / chiedi conferma** | Brief ambiguo | `clarify` o messaggio “Procedo con questo brief?” |

**Default consigliato (da confermare con Andrea):**

- Brief mostrato in chat; **auto-start** se flag `--yes` o env `ZELARI_MISSION_AUTO=1`.
- MVP: brief definisce **max N task** nello slice 1 (es. 8).

### Estensione `resolveCouncilRunMode`

Aggiungere keyword **IT/EN**:

- IT: `costruisci`, `crea`, `nuovo progetto`, `da zero`, `sviluppa`, `realizza`, `vetrina`, `pannello`
- EN: esistenti + `build`, `scaffold`, `landing`, `frontend`, `fullstack`
- UI: `glasspetrae`, `redesign`, `ui`, `tailwind`

Logica **hybrid:** repo vuoto o senza `plan.json` + intent greenfield → design-phase poi implementation in catena (Zelari-mode).

---

## 5. Skill router e builtin N-THEM

### Due cataloghi oggi

| Catalogo | Uso attuale |
|----------|-------------|
| `SKILL_CATALOG` | Council via `roles.ts` → `computeAgentSkills` |
| `CODING_SKILL_CATALOG` | `/skill` via `registerCodingSkill` |

**Obiettivo:** router unificato che popola **entrambi** i canali e `perRunSkillIds` per council.

### Skill builtin da shipare

| ID | Fonte | Council | `/skill` |
|----|--------|---------|----------|
| `design-taste-glasspetrae` | Taste Skill MIT + appendice glasspetrae | Overlay corto (~4-8 KB) in design-phase / UI |
| `zelari-agents-md-scoped` | Adatt. davidondrej `folder-specific-claude-and-agents-md` | Nettuno, Lucifero |
| `zelari-read-decisions` | Adatt. `read-all-adrs` → `.zelari/decisions/` | Nettuno, Minosse |
| `zelari-session-handoff` | Adatt. davidondrej `handoff` (tono N-THEM) | Opz. fine slice |

**Non builtin:** cmux, deepapi, codex-goal-loop, delegating-to-agents (stack David-specific).

### Router (euristica v1)

Input: `userMessage`, `MissionBrief`, `cwd`, `hasPlan`, `runMode`.

Output: `Record<AgentId, string[]>` skill ids.

Esempi match:

- `landing`, `vetrina`, `ui`, `glasspetrae` → `design-taste-glasspetrae` su geryon, minos, lucifer
- `architettura`, `laravel`, `react`, `api` → `architect-feature` / planning skills su charont, nettun
- `refactor`, `bug` → debug/refactor catalog

Implementazione: `packages/core/src/council/skillRouter.ts` + test con prompt BnB generico.

### Iniezione council condizionale

Estendere `buildSystemPrompt` / `computeAgentSkills` con:

```typescript
options?: {
  councilRunMode?: CouncilRunMode;
  routedSkillIds?: string[];
}
```

Regole:

- Skill design (`design-taste-glasspetrae`) **solo** se `design-phase` o keyword UI nel brief.
- In implementation puro “fix auth” → no overlay Taste full.

### File asset

```
packages/core/src/agents/skills/assets/
  design-taste-glasspetrae-full.md      # vendored pin SHA upstream
  design-taste-glasspetrae-council.md   # condensato
  glasspetrae-appendix.md               # token petra/aqua, glifi, glass utilities
packages/core/src/agents/skills/builtin/
  frontend-design.ts                    # registerSkill + registerCodingSkill
  workspace-docs.ts                     # zelari-* handoff/decisions/agents-md
```

`src/cli/app.tsx`: `import '@zelari/core/skills/builtin/frontend-design'` (e workspace-docs).

### THIRD_PARTY_NOTICES

- Taste Skill (MIT, Leon Lin / MemPalace team per parti derivate davidondrej MIT).

---

## 6. Memoria: LanceDB + SQLite (graph light)

### Perché questa scelta (vs MemPalace in core)

- **npm shippable:** tutto Node, niente Python obbligatorio.
- **Hybrid search:** vector + FTS in LanceDB.
- **Controllo metadata** per council slice / session / project.

### Per-project path (obbligatorio)

```
<projectRoot>/.zelari/memory/
  zelari.lance/     # LanceDB
  zelari.db         # SQLite facts + graph
```

Non usare solo `~/.zelari/memory` globale (mischia progetti).

### Interfaccia `MemoryBackend`

```typescript
// packages/core/src/memory/types.ts

export interface MemoryChunk {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface MemorySearchOptions {
  limit?: number;
  useGraph?: boolean;
  metadataFilter?: Record<string, unknown>;
}

export interface MemoryBackend {
  init(projectRoot: string): Promise<void>;
  add(
    content: string,
    metadata?: Record<string, unknown>,
    graph?: {
      entities?: Array<{ name: string; type?: string }>;
      relations?: Array<{ from: string; to: string; type: string; weight?: number }>;
    },
  ): Promise<string>; // fact id
  search(query: string, options?: MemorySearchOptions): Promise<MemoryResult[]>;
  close(): Promise<void>;
}
```

### Schema SQLite (corretto — fix rispetto a snippet iniziale)

```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  metadata TEXT
);

CREATE TABLE fact_entities (
  fact_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (fact_id, entity_id),
  FOREIGN KEY (fact_id) REFERENCES facts(id),
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT,
  FOREIGN KEY (from_entity) REFERENCES entities(id),
  FOREIGN KEY (to_entity) REFERENCES entities(id)
);
```

**Graph expansion:** da entità match → `relations` → `fact_entities` → `facts` / Lance per testo. **Mai** `facts.id = entity_id`.

### LanceDB

- Colonne tabella `memories`: `id`, `text`, `vector` (float32[384] per MiniLM), `metadata` (JSON string).
- Dopo create: FTS index su `text`; attendere index ready prima hybrid (vedi docs LanceDB JS).
- Verificare API JS corrente per `queryType: 'hybrid'` (test integrazione obbligatorio).

### Embeddings

- `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` (o equivalente 384-dim).
- **Lazy load** al primo `memory.init`; messaggio TUI: `[memory] caricamento embedding…`.
- **Dynamic import** per non gonfiare bundle CLI se memory disabilitata.

### Dipendenze npm

Pacchetto consigliato: `packages/memory` workspace `@zelari/memory` oppure sotto `packages/core/src/memory`.

```json
{
  "dependencies": {
    "@lancedb/lancedb": "^0.31.0",
    "@huggingface/transformers": "^3.0.0",
    "better-sqlite3": "^11.0.0"
  },
  "optionalDependencies": {
    "better-sqlite3": "^11.0.0"
  }
}
```

Se `better-sqlite3` fallisce: `ZELARI_MEMORY=0` e degradazione graceful (solo `.zelari/` + plan).

**Evitare** `postinstall` che crea directory in homedir.

### Tool harness

| Tool | Descrizione |
|------|-------------|
| `memory_add` | Salva chunk + metadata + graph opzionale |
| `memory_search` | Hybrid + optional graph 1-hop |

Metadata consigliati su ogni `add`:

- `projectRoot`, `sessionId`, `missionId`, `sliceId`, `runMode`, `source`: `council` \| `agent` \| `handoff` \| `verify`

### Fase 2 (non v1)

- Entity extraction via LLM nel `memory_add`.
- `memory_reflect()` riassunto periodico.
- Backend alternativo MemPalace MCP.

---

## 7. MemPalace (opzionale)

Per utenti che preferiscono palace / conversation mining:

- MCP in `.zelari/mcp.json`: `mempalace-mcp` via `uv tool run`.
- Implementazione `McpMemPalaceBackend implements MemoryBackend`.
- Env: `ZELARI_MEMORY_BACKEND=lancedb` (default) \| `mempalace`.

Non bloccare v1 su MemPalace.

---

## 8. Integrazione council e agent

### `dispatchCouncil` / `councilApi`

Prima di `runCouncilPure`:

```typescript
const brief = await buildMissionBrief(userMessage, projectRoot);
const routed = routeSkills(brief, agents);
const memoryHits = await memory.search(brief.deliverableThisMission + ' ' + userMessage, {
  limit: 8,
  useGraph: true,
  metadataFilter: { projectRoot },
});
const ragContext = formatMemoryHits(memoryHits) + existingRag;
```

Passare a `PureCouncilConfig`:

- `runMode` da brief / classifier
- `maxToolCallsPerTurn` elevato per Lucifero in zelari-mode (es. 30, env `ZELARI_MODE_MAX_TOOLS_LUCIFER`)
- `aiConfig` o estensione con `routedSkillIds`

### `useChatTurn` — Zelari-mode

Nuovo branch: se `mode === 'zelari'` → `runZelariMission()` invece di singolo `dispatchCouncil` / agent.

`runZelariMission`:

1. `buildMissionBrief`
2. Opz. conferma utente
3. Loop con `maxMissionIterations`
4. Tra iterazioni: **non** reiniettare intero JSONL — solo brief + plan summary + memory hits + last `completion.json`

### Post-slice

Dopo `postCouncilHook`:

```typescript
await memory.add(
  JSON.stringify({ completion, slice, filesTouched }),
  { sliceId, sessionId, source: 'council' },
  entitiesFromBrief(brief),
);
```

---

## 9. Limiti contesto e compaction

| Layer | Ruolo in Zelari-mode |
|-------|----------------------|
| **Hot (prompt)** | Mission brief, ultimi 2-3 messaggi, plan summary, top-8 memory |
| **Warm** | `.zelari/plan.json`, `completion.json`, `AGENTS.MD`, decisions |
| **Cold** | JSONL session, Lance drawers, git |

`/compact` resta per scrollback TUI; **non** sostituisce `memory_search`.

### Skill grandi (Taste ~87 KB)

- Council: solo `design-taste-glasspetrae-council.md`
- Full: `/skill` o drawer in memory dopo primo design run

---

## 10. Configurazione e variabili d'ambiente

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `ZELARI_MEMORY` | `1` | `0` disabilita Lance backend |
| `ZELARI_MEMORY_BACKEND` | `lancedb` | `mempalace` futuro |
| `ZELARI_MISSION_AUTO` | `0` | `1` salta conferma brief |
| `ZELARI_MISSION_MAX_ITER` | `6` | Max implementazioni (design-phase fuori budget) |
| `ZELARI_MODE_MAX_TOOLS_LUCIFER` | `30` | Tool cap implementer |
| `ZELARI_COUNCIL_MODE` | (auto) | `design` / `impl` override |
| `ZELARI_VERIFY_AUTOFIX` | `0` | Già documentato roadmap verify |

---

## 11. Piano di implementazione per fasi

### Fase 0 — Decisioni prodotto (gate)

- [ ] Brief: auto-start vs conferma
- [ ] Stop: tutti task high vs MVP slice nel brief
- [ ] Headless zelari in v0.8 o v0.9

### Fase 1 — Memoria (fondazione)

- [ ] `MemoryBackend` + `LanceSqliteBackend`
- [ ] Fix schema `fact_entities`
- [ ] Test integrazione hybrid Lance (tmp dir)
- [ ] Tool `memory_add` / `memory_search` nel registry CLI
- [ ] Wire `ragContext` in council dispatch (read-only)

### Fase 2 — Mission + router

- [ ] `mission.ts` classifier + keyword IT
- [ ] `missionBrief.ts` (euristica + LLM opzionale)
- [ ] `skillRouter.ts` + test prompt generici
- [ ] Builtin skill files (Taste+glasspetrae, zelari-*)

### Fase 3 — Zelari-mode TUI

- [ ] `ChatMode: 'zelari'`
- [ ] `zelariMission.ts` state machine
- [ ] Tool limits Lucifero
- [ ] `mission-state.json` + handoff

### Fase 4 — Council integration

- [ ] `computeAgentSkills` + runMode + routed ids
- [ ] Auto-chain design → impl in greenfield
- [ ] `memory_add` post-slice

### Fase 5 — Docs e release

- [ ] `docs/GUIDA.md` sezioni Zelari-mode + memoria
- [ ] `THIRD_PARTY_NOTICES`
- [ ] `scripts/sync-vendored-skills.mjs` (pin Taste upstream)

---

## 12. Test e criteri di accettazione

### Memoria

- [ ] `memory.add` + `memory.search` roundtrip stesso projectRoot
- [ ] Hybrid query trova termine FTS esatto e parafrasi semantica
- [ ] Graph: entity → relation → fact corretto (no entity id come fact id)
- [ ] Progetti A e B isolati (path `.zelari/memory` distinti)

### Skill router

- [ ] Prompt BnB generico assegna planning + design skill a ruoli attesi
- [ ] Prompt “fix login” non assegna Taste overlay

### Zelari-mode (smoke)

- [ ] Prompt greenfield in cartella vuota: genera brief, almeno 1 council run, scrive `mission-state.json`
- [ ] Dopo 2 iter, `memory_search` recupera decisione slice 1 senza JSONL completo nel prompt

### Regression

- [ ] `npm test` verde
- [ ] Council singolo run (`mode council`) invariato se `ZELARI_MEMORY=0`

---

## 13. Rischi e mitigazioni

| Rischio | Mitigazione |
|---------|-------------|
| `better-sqlite3` fallisce su install globale | optionalDep + `ZELARI_MEMORY=0` |
| Primo avvio lento (embedding) | Lazy load + messaggio TUI |
| Loop infinito / costo API | `maxMissionIterations`, budget, handoff |
| Memoria stale | Prompt “verifica su disco”; SSOT plan/completion |
| API Lance JS diversa da snippet | Test integrazione reale, pin versione |
| Scope creep automatico | Brief `outOfScope` + slice espliciti in plan |

---

## 14. Appendice: schema dati e tool API

### `mission-state.json` (esempio)

```json
{
  "missionId": "m_abc123",
  "userPrompt": "costruisci gestionale BnB...",
  "brief": { "intent": "greenfield", "skillPack": ["design-taste-glasspetrae"] },
  "iteration": 2,
  "currentSliceId": "slice-2",
  "status": "running",
  "lastCompletionOk": false,
  "startedAt": "2026-07-05T12:00:00Z",
  "updatedAt": "2026-07-05T12:45:00Z"
}
```

### Tool `memory_search` (schema Zod indicativo)

```typescript
{
  query: string;
  limit?: number;      // default 8
  useGraph?: boolean;  // default true
}
```

### Tool `memory_add`

```typescript
{
  content: string;
  metadata?: Record<string, unknown>;
  entities?: { name: string; type?: string }[];
  relations?: { from: string; to: string; type: string; weight?: number }[];
}
```

### Riferimenti codice esistente

| Area | Path |
|------|------|
| Council dispatch | `src/cli/councilDispatcher.ts` |
| Run mode | `packages/core/src/council/runMode.ts` |
| Completion | `packages/core/src/council/completion/` |
| Post hook | `src/cli/workspace/postCouncilHook.ts` |
| Skills MD | `src/cli/skillsMd.ts` |
| Compaction | `src/cli/compaction.ts` |
| MCP client | `src/cli/mcp/mcpClient.ts` |
| Roadmap delivery | `docs/plans/2026-07-05-council-complete-delivery-roadmap.md` |

---

## Changelog documento

| Data | Nota |
|------|------|
| 2026-07-05 | Prima stesura unificata: Zelari-mode + memoria Lance/SQLite + skill builtin |

---

*Fine guida — implementare solo dopo conferma Fase 0 e review piano.*