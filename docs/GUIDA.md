# Zelari Code — Guida all'uso

> **Versione documento:** 1.12.0  
> CLI multi-agente per coding con TUI (Ink + React), **Zelari Desktop** (Tauri), council a 6 ruoli, slash commands, MCP, SSH e provider LLM agnostici.

---

## Indice

1. [Cos'è Zelari Code](#cosè-zelari-code)
2. [Prerequisiti](#prerequisiti)
3. [Installazione](#installazione)
4. [Primo avvio e wizard](#primo-avvio-e-wizard)
5. [Interfaccia TUI](#interfaccia-tui)
6. [Modalità agent, council e zelari](#modalità-agent-e-council)
7. [Comandi da terminale (flags)](#comandi-da-terminale-flags)
8. [Modalità headless (CI/script)](#modalità-headless-ciscript)
9. [Zelari Desktop](#zelari-desktop)
10. [Comandi slash](#comandi-slash)
11. [Provider e autenticazione](#provider-e-autenticazione)
12. [Skills](#skills)
13. [Council (multi-agente)](#council-multi-agente)
14. [Workspace `.zelari/`](#workspace-zelari)
15. [MCP (Model Context Protocol)](#mcp-model-context-protocol)
16. [SSH (deploy / monitor)](#ssh-deploy--monitor)
17. [Sessioni e branch](#sessioni-e-branch)
18. [Tool disponibili](#tool-disponibili)
19. [Novità v1.3.0 (frontier tools)](#novità-v130-frontier-tools)
20. [File di configurazione](#file-di-configurazione)
21. [Variabili d'ambiente](#variabili-dambiente)
22. [Self-update](#self-update)
23. [Sviluppo](#sviluppo)
24. [Risoluzione problemi](#risoluzione-problemi)

---

## Cos'è Zelari Code

**Zelari Code** è un agente di coding da terminale sviluppato da [N-THEM Studio](https://github.com/N-THEM-Studio). Estratto da [AnathemaBrain](https://github.com/N-THEM-Studio/AnathemaBrain), offre:

- Una **TUI** ricca con scrollback nativo, sidebar git e timer di esecuzione
- Un **agente singolo** con tool filesystem, shell, ricerca e web
- Un **council** a 6 membri (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero)
- **23 skill** builtin + skill personalizzate in formato `SKILL.md`
- Persistenza progetto in **`.zelari/`** e auto-curation di **`AGENTS.MD`**
- Supporto **MCP**, **SSH targets**, **headless mode**, **Zelari Desktop** e **self-update**

Il runtime condiviso è pubblicato come package npm [`@zelari/core`](https://www.npmjs.com/package/@zelari/core) (MIT).

---

## Prerequisiti

| Requisito | Versione | Note |
|---|---|---|
| **Node.js** | **≥ 20 LTS** | Testato su 20.x e 22.x. Versioni precedenti mancano di `fetch` stabile, `AbortController.timeout`, e `node:test`. |
| **npm** | **≥ 10** | Fornito con Node 20 LTS; testato con npm 10 e 11. |
| **OS** | Linux, macOS, Windows 10/11 | Windows richiede Git Bash (auto-rilevato). |
| **Account + API key** | 1 tra: xAI Grok, OpenAI-compatible, GLM/Z.AI, MiniMax, DeepSeek | Grok supporta OAuth via `/login grok`. |

### Dipendenze opzionali (per i tool v1.3.0)

La CLI funziona senza queste — il tool salta in automatico se la dipendenza manca. Servono solo se vuoi usare lo specifico tool group.

| Tool group | Dipendenza | Note |
|---|---|---|
| `lsp_*` | Language server sul PATH (`typescript-language-server`, `pyright-langserver`, …) | cinque tool: `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_rename` |
| `ast_*` | *(nessuna)* | TypeScript Compiler API integrato — `ast_outline`, `ast_find_symbol` |
| `semantic_search` | modello embedding locale (default `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers`) | scaricato on first use, ~25 MB |
| `browser_check` | Playwright + chromium (`npx playwright install chromium`) | ~150 MB una tantum |
| diagnostics loop | `eslint` e/o `ruff` sul PATH (preferibilmente project-local) | post-edit compile/lint feedback |

Disabilitazione globale: `ZELARI_LSP=0`, `ZELARI_AST=0`, `ZELARI_SEMANTIC=0`, `ZELARI_BROWSER=0`, `ZELARI_DIAGNOSTICS=0`.

## Installazione

### Installazione globale (CLI — prodotto principale)

```bash
npm install -g zelari-code
zelari-code --version
```

### Zelari Desktop (opzionale)

Gli installer da [GitHub Releases](https://github.com/N-THEM-Studio/zelari-code/releases) **non** installano la CLI globale. Dopo l’installer (o in dev):

1. Node.js ≥ 20 sul PATH  
2. `npm install -g zelari-code` (o **Settings → Update CLI** nella Desktop)  
3. API key in Settings → Provider  

Vedi [Zelari Desktop](#zelari-desktop) e [`apps/desktop/README.md`](../apps/desktop/README.md).

### Windows: `zelari-code` non trovato

Dopo `npm install -g`, aggiungi il prefix npm al `PATH`:

**PowerShell** (come admin, poi riavvia il terminale):

```powershell
$npmPrefix = npm config get prefix
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$npmPrefix", "User")
```

Verifica: `where zelari-code` (CMD) o `Get-Command zelari-code` (PowerShell).

### Installazione da sorgente

```bash
git clone https://github.com/N-THEM-Studio/zelari-code.git
cd zelari-code
npm install
npm run build:cli
npm link
zelari-code
```

---

## Primo avvio e wizard

Al primo avvio (o se manca `provider.json`), parte un **wizard** in 5 step:

1. **Welcome** — panoramica
2. **Provider** — scegli tra `grok`, `minimax`, `glm`, `openai-compatible`
3. **Model** — nome modello (Enter per il default)
4. **API key** — `env` (variabile d'ambiente), `keystore` (salva in locale) o `skip`
5. **Confirm** — riepilogo e commit

Al termine scrive la configurazione in `~/.tmp/zelari-code/` e passa automaticamente alla TUI.

### Saltare o ripetere il wizard

```bash
zelari-code --no-wizard          # salta il wizard
zelari-code --reset-config       # forza il wizard (cancella provider.json al commit)
ZELARI_NO_WIZARD=1 zelari-code   # equivalente env di --no-wizard
```

---

## Interfaccia TUI

### Layout (v0.7.x)

```
┌─────────────────────────────────────────────┬──────────┐
│  Chat (scrollback nativo — messaggi finali) │ Sidebar  │
│  ...                                        │ git diff │
│  [streaming in corso]                       │  +file   │
├─────────────────────────────────────────────┤  -file   │
│  > input bar                                │          │
├─────────────────────────────────────────────┴──────────┤
│  ● ⏵ agent (shift+tab) · grok · grok-4 · sess · cwd  │
└────────────────────────────────────────────────────────┘
```

- **Chat**: i messaggi completati restano nello scrollback del terminale (non svaniscono al refresh)
- **Sidebar**: modifiche git live (`+added` / `-removed`), aggiornata ogni ~4s; nascosta su terminali stretti
- **Status bar** (sotto l'input): modalità, provider, modello, sessione, cwd, timer (`⏱ 12s` / `last 34s`)

### Scorciatoie

| Tasto | Azione |
|---|---|
| **Shift+Tab** | Alterna modalità `agent` ↔ `council` |
| **Ctrl+C** | Esci (flush metriche + chiusura MCP) |
| Qualsiasi tasto | Salta lo splash screen iniziale (~2s) |

### Splash screen

All'avvio compare il logo ASCII N-THEM per ~2 secondi. Disabilitabile:

```bash
ZELARI_NO_SPLASH=1 zelari-code
```

Saltato automaticamente su stdout non-TTY (pipe, CI) o terminali piccoli.

---

## Modalità agent e council

### Agent (default)

Un singolo harness LLM con accesso ai tool builtin (read/write/edit, bash, grep, web, …). Ideale per task puntuali: fix bug, refactor, spiegazioni.

### Council

Pipeline sequenziale a **6 membri** che collaborano su planning, ideazione, knowledge map, review e sintesi. Ideale per design, architettura, piani complessi.

| ID | Nome | Ruolo |
|---|---|---|
| `charont` | Caronte | Orchestrator — decompone il problema |
| `nettun` | Nettuno | Planner — fasi, task, milestone |
| `geryon` | Gerione | Ideator — idee e documenti design |
| `pluton` | Plutone | Knowledge Architect — knowledge map |
| `minos` | Minosse | Critic — review qualità e rischi |
| `lucifer` | Lucifero | Synthesizer — output finale / implementazione |

### Come attivare il council

1. **Shift+Tab** → la status bar mostra `⛬ council`
2. Scrivi un prompt libero e invia
3. Oppure usa `/council <testo>` esplicitamente

### Tier council (lite vs full)

| Tier | Membri | Come attivarlo |
|---|---|---|
| **full** (default) | 6 | — |
| **lite** | 3 | `ZELARI_COUNCIL_TIER=lite` |
| custom | 1–6 | `ZELARI_COUNCIL_SIZE=4` |

### Modalità design-phase vs implementation

Il council rileva automaticamente se il task è di **design** (architettura, spec, progetto greenfield) o **implementazione** (codebase esistente). In design-phase i membri persistono artefatti in `.zelari/` via tool workspace.

Override manuale: `ZELARI_COUNCIL_MODE=design-phase` o `implementation`.

Le keyword sono **bilingue**: `costruisci`, `crea`, `vetrina`, `gestionale`, `da zero` attivano la design-phase; `correggi`, `rifattorizza`, `implementa` restano in implementation.

### Zelari (missioni autonome)

La terza modalità (`⚡ zelari`) trasforma **un prompt libero** in una **missione multi-run**: invece di un singolo giro di council, il sistema itera fino a completare uno *slice MVP*.

**Come funziona:**

1. **Shift+Tab** finché la status bar mostra `⚡ zelari` (oppure `/zelari <prompt>`).
2. Zelari costruisce un **mission brief** (intent, stack inferito, deliverable, assunzioni, out-of-scope, slice MVP) e lo mostra in chat.
3. Confermi con `ok` (o imposti `ZELARI_MISSION_AUTO=1` per l'avvio automatico).
4. Il loop gira: per i progetti greenfield prima **design-phase**, poi **implementation** a ripetizione. Tra un'iterazione e l'altra viene re-iniettato solo un contesto compatto (brief + hit di memoria), mai l'intero transcript.
5. La missione termina con **successo** quando `completion.ok` è verde sullo slice MVP, oppure si **ferma** al raggiungimento del budget di iterazioni (`ZELARI_MISSION_MAX_ITER`, default 10), salvando lo stato in `.zelari/mission-state.json`.

In zelari-mode il **chairman (Lucifero)** riceve un budget di tool più alto (`ZELARI_MODE_MAX_TOOLS_LUCIFER`, default 30) per reggere i run di implementazione lunghi.

**Variabili:**

| Variabile | Default | Effetto |
|---|---|---|
| `ZELARI_MISSION_AUTO` | `0` | `1` = avvia la missione senza chiedere conferma del brief |
| `ZELARI_MISSION_MAX_ITER` | `10` | numero massimo di iterazioni del loop |
| `ZELARI_MODE_MAX_TOOLS_LUCIFER` | `30` | budget di tool call per il chairman in zelari-mode |

### Memoria di progetto

Zelari-mode persiste gli esiti di ogni slice in una **memoria file-based** per-progetto: `.zelari/memory/log.jsonl` (una riga per fatto). Alla ricerca (per keyword) i risultati rilevanti vengono passati al council come contesto RAG. Nessuna dipendenza nativa, nessun vector store — è un seam per un eventuale backend semantico futuro.

Disattivala con `ZELARI_MEMORY=0` (degrada a no-op, il resto continua a funzionare). La memoria è **isolata per progetto**: progetti diversi non si mischiano.

---

## Comandi da terminale (flags)

```bash
zelari-code [opzioni]
```

| Flag | Descrizione |
|---|---|
| `--version`, `-v` | Stampa versione ed esce |
| `--help`, `-h` | Stampa help ed esce |
| `--no-wizard` | Salta il wizard al primo avvio |
| `--reset-config` | Forza il wizard (reset configurazione) |
| `--headless` | Esecuzione non interattiva (vedi sotto) |
| `--doctor` | Diagnostica ambiente (PATH, node, git, bash agente) |
| `--fix-path` | Windows: ripara prefix npm nel PATH utente |
| `--print-config` / `--set-config` / `--set-key` / `--discover-models` | Helper config per Desktop / script |
| `--print-mcp` / `--set-mcp` / `--remove-mcp` | Gestione `mcp.json` |
| `--print-ssh-targets` / `--set-ssh-target` / `--remove-ssh-target` / `--test-ssh-target` | Target SSH |
| `--print-ssh-pubkey --path <…>` | Mostra contenuto `.pub` (copia su server) |

---

## Modalità headless (CI/script)

Esegue un singolo task senza montare la TUI. Utile per pipeline CI, script e **Zelari Desktop**.

```bash
zelari-code --headless --task "Spiega cosa fa src/cli/main.ts" --output json
```

### Opzioni headless

| Flag | Default | Descrizione |
|---|---|---|
| `--task <testo>` | *(obbligatorio)* | Prompt da eseguire |
| `--output json\|plain` | `json` | `json` = NDJSON (un evento BrainEvent per riga); `plain` = solo testo assistant |
| `--mode agent\|council\|zelari` | `agent` | Dispatch mode (preferito a `--council` legacy) |
| `--phase plan\|build` | `build` | In `plan` non muta il progetto (no write/edit/bash aggressivi) |
| `--council` | off | Alias legacy → mode council |
| `--provider <id>` | provider attivo | Override provider |
| `--model <nome>` | modello del provider | Override modello |
| `--history-file <path>` | — | Storia multi-turno (JSON) usata dalla Desktop |

### Esempi

```bash
# Agente singolo, output testuale
zelari-code --headless --task "Elenca i file in src/cli" --output plain

# Council, output JSON per piping
zelari-code --headless --task "Progetta API REST per todo" --council --output json \
  | jq 'select(.type=="message_delta") | .delta'

# Plan-only (niente mutazioni)
zelari-code --headless --mode agent --phase plan --task "Outline the refactor"

# Provider esplicito (utile senza wizard/config)
OPENAI_API_KEY=sk-... zelari-code --headless \
  --provider openai-compatible --model grok-4 \
  --task "Review package.json"
```

### Exit code headless

| Codice | Significato |
|---|---|
| `0` | Completato (`agent_end.reason === 'completed'`) |
| `1` | Errore utente (flag mancanti, API key assente) |
| `2` | Errore runtime (provider, eccezione council) |
| `3` | Run agente terminato con errore |

---

## Zelari Desktop

Shell **Tauri 2** opzionale (`apps/desktop/`): chat moderna che esegue `zelari-code --headless` e streama eventi NDJSON.

| Controllo | Valori | Flag CLI |
|---|---|---|
| Mode | Agent · Council · Zelari | `--mode` |
| Phase | Plan · Build | `--phase` |
| Provider / model | barra + Settings | `--provider` / `--model` |
| Open Folder | directory di lavoro | cwd del processo CLI |

### Settings

- **Provider** — API key, endpoint OpenAI-compatible, discover models  
- **Updates** — aggiornamento **app** (Tauri / GitHub Releases) vs **CLI** (`npm install -g`)  
- **MCP Extensions** — catalogo server comuni → scrive `mcp.json`  
- **Connections (SSH)** — host per deploy/monitor (vedi [SSH](#ssh-deploy--monitor))  

### Primo avvio

Se mancano Node o la CLI, appare la **Setup guide**. L’installer Desktop da solo non basta.

### Sviluppo

```bash
npm run build
npm run desktop:install
npm run desktop:dev
```

Override monorepo: `ZELARI_CLI_PATH` → path a `bin/zelari-code.js`.

---

## Comandi slash

Tutti i comandi iniziano con `/` e si digitano nella barra di input della TUI.

### Riferimento rapido (allineato al README)

#### Aiuto e uscita

| Comando | Descrizione |
|---|---|
| `/help` | Elenco comandi e skill disponibili |
| `/exit` | Esci dalla CLI |

#### Modalità di dispatch (v1.3.0)

| Comando | Descrizione |
|---|---|
| `/mode [agent\|council\|zelari]` | Forza la modalità di dispatch. Equivalente portabile di `shift+tab` (utile in terminali dove `shift+tab` è catturato). |
| `shift+tab` (TUI) | Cicla `agent` → `council` → `zelari`. Hardening v1.3.0: rileva terminali senza supporto e cade sul comando. |

#### Provider e modello

| Comando | Descrizione |
|---|---|
| `/login <provider> [key]` | Autentica un provider; senza key avvia OAuth per `grok` |
| `/provider` | Picker interattivo dei provider (↑/↓ + invio, esc annulla) |
| `/provider <id>` | Cambia provider (`openai-compatible`, `grok`, `minimax`, `glm`, `deepseek`) |
| `/provider list` | Mostra provider attivo e disponibili (testo) |
| `/provider custom <url>` | Endpoint custom (Ollama, LM Studio, vLLM, DeepSeek, …) |
| `/provider custom clear` | Rimuove override endpoint |
| `/provider <id> refresh` | Forza refresh token OAuth |
| `/provider <id> status` | Stato chiave, scadenza, sorgente |
| `/model` | Picker interattivo dei modelli (auto-discovery se cache assente o >6h) |
| `/model <nome>` | Imposta modello per il provider attivo |
| `/model show` | Mostra modello corrente |
| `/model refresh` | Ri-scopre modelli dal provider |
| `/models` | Elenco modelli scoperti (cache) |
| `/models refresh` (o `/discover`) | Aggiorna cache modelli |

#### Skills

| Comando | Descrizione |
|---|---|
| `/skill <id> [input]` | Invoca una skill con prompt opzionale |
| `/skill-stats [id]` | Statistiche invocazioni (success rate, durata, token) |
| `/skill-compare <id1> <id2>` | Confronto side-by-side tra due skill |

> `/help` elenca tutte le skill caricate (builtin + `SKILL.md` utente).

#### Council

| Comando | Descrizione |
|---|---|
| `/council <input>` | Invoca il council sul testo fornito |
| `/council-feedback <memberId> <1-5> [nota]` | Valuta un membro (es. `/council-feedback geryon 4 ottime idee`) |
| `/promote-member <memberId>` | Promuove un membro council a skill standalone |

#### Sessioni e transcript

| Comando | Descrizione |
|---|---|
| `/sessions` | Elenco sessioni passate |
| `/resume <id>` | Riprende una sessione (effetto al prossimo avvio) |
| `/new` | Nuova sessione |
| `/clear` | Pulisce il transcript visibile (sessione preservata) |
| `/compact [--threshold N] [--keep N]` | Compatta il transcript JSONL |

#### Branch (isolamento sessioni)

| Comando | Descrizione |
|---|---|
| `/branch <nome>` | Snapshot della sessione corrente in un nuovo branch |
| `/branches` | Elenco branch |
| `/checkout <nome>` | Imposta branch attivo (**effetto al prossimo avvio**) |

#### Git e file

| Comando | Descrizione |
|---|---|
| `/diff [--staged]` | Mostra diff working tree (o staged con `--staged`) |
| `/undo [--yes]` | Revert modifiche non committate (**richiede `--yes`**) |

#### Steering (prompt in coda)

| Comando | Descrizione |
|---|---|
| `/steer <testo>` | Accoda un follow-up durante un run attivo |
| `/steer --interrupt <testo>` | Cancella il run corrente e accoda il nuovo prompt |

#### Workspace

| Comando | Descrizione |
|---|---|
| `/workspace` | Elenco artefatti `.zelari/` |
| `/workspace show plan` | Render `plan.md` |
| `/workspace show decisions` | Elenco ADR |
| `/workspace show risks` | Render `risks.md` |
| `/workspace show agents` | Render `AGENTS.MD` |
| `/workspace show docs` | Elenco bozze in `docs/` |
| `/workspace sync` | Ri-cura `AGENTS.MD` adesso |
| `/workspace reset --yes` | Cancella `.zelari/` (**distruttivo**) |

#### Checkpoint e rollback (v1.2.0)

| Comando | Descrizione |
|---|---|
| `/checkpoint [label]` | Snapshot del working tree (tracciati + untracked) via git plumbing. Ogni missione zelari-mode ne prende uno all'avvio. |
| `/rollback [id\|latest]` | Ripristino atomico di un checkpoint: ripristina i file modificati, ricrea i cancellati, rimuove i creati dopo lo snapshot. Senza argomento elenca i checkpoint disponibili. |
| `ZELARI_CHECKPOINT=0` | Disabilita checkpoint automatici nelle missioni. |

#### Semantic search (v1.3.0)

| Comando | Descrizione |
|---|---|
| `/index` | Costruisce / rinfresca l'indice vettoriale del progetto. Richiesto prima del primo `semantic_search`. |
| `semantic_search "<query>"` (tool) | Ricerca semantica concettuale via embeddings locali. |

#### Update

| Comando | Descrizione |
|---|---|
| `/update` | Controlla aggiornamenti su npm |
| `/update --yes` | Installa `zelari-code@latest` globalmente |

---

## Provider e autenticazione

### Provider supportati

| ID | Nome | Variabile env | Note |
|---|---|---|---|
| `openai-compatible` | OpenAI-compatible | `OPENAI_API_KEY` | OpenAI, Together, Groq, endpoint custom |
| `grok` | xAI Grok | `GROK_API_KEY` | OAuth via `/login grok` (RFC 8628) |
| `minimax` | MiniMax | `MINIMAX_API_KEY` | Base URL: `https://api.minimax.io/v1` (endpoint internazionale) |
| `glm` | GLM / Z.AI | `GLM_API_KEY` | Base URL: `https://api.z.ai/api/coding/paas/v4` (GLM Coding Plan). Per l'API pay-per-token: `/provider custom https://api.z.ai/api/paas/v4`. L'id provider è `glm`, non `zai`. |

> Per un endpoint self-hosted/terze parti non serve un provider dedicato: usa
> `openai-compatible` + `/provider custom <url>` (vedi
> [Endpoint OpenAI-compatible custom](#endpoint-openai-compatible-custom)).

### Configurare una API key

**Via variabile d'ambiente:**

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.together.xyz/v1   # endpoint custom
export OPENAI_MODEL=grok-4
zelari-code
```

**Via TUI:**

```
/login openai-compatible sk-your-key-here
/login grok                    # avvia OAuth device flow
/model grok-4
/provider grok
```

### Endpoint OpenAI-compatible custom

Per puntare a un gateway self-hosted o di terze parti (Ollama, LM Studio, vLLM,
Together, un proxy aziendale, …) usa il provider `openai-compatible` con un
endpoint custom. Nella TUI:

```
/login openai-compatible <la-tua-api-key>
/provider custom https://forgeai.dotlabstudios.com/v1
/model refresh          # (o /discover) scopre i modelli DALL'endpoint custom
/model <nome-modello>   # oppure apri il picker con /model
```

L'endpoint custom viene salvato in `provider.json` sotto il provider attivo e
vince sempre sul default. Il model discovery (`/model refresh`, `/discover`, il
picker `/model` e il refresh automatico all'avvio) interroga `<endpoint>/models`
usando lo stesso URL della chat, quindi i modelli scoperti provengono davvero
dal tuo endpoint. Se l'endpoint non espone `/v1/models`, la discovery fallisce
con un messaggio inline e puoi comunque impostare il modello a mano con
`/model <nome>`.

In alternativa via env (equivalente, senza persistenza in `provider.json`):

```bash
export OPENAI_API_KEY=<la-tua-api-key>
export OPENAI_BASE_URL=https://forgeai.dotlabstudios.com/v1
```

> Nota: `/provider custom <url>` imposta l'endpoint sul **provider attivo** (di
> norma `openai-compatible`); non esiste un provider selezionabile chiamato
> `custom`.

### OAuth Grok

1. `/login grok` (senza key)
2. Compare un codice e un URL di verifica
3. Apri l'URL, inserisci il codice, autorizza
4. Il token (access + refresh) viene salvato in `keys.json`

### Failover cross-provider

Su errori transienti, il CLI può riprovare con un provider alternativo.

```bash
ANATHEMA_FAILOVER_PROVIDER=grok zelari-code    # provider di fallback
ANATHEMA_FAILOVER=0 zelari-code                # disabilita failover
```

---

## Skills

### Skill builtin (23)

Invocabili con `/skill <id>`.

#### Planning (`planning`)

| ID | Nome |
|---|---|
| `architect-feature` | Progettazione feature end-to-end |
| `architect-decision-record` | Scrittura ADR |
| `scope-check` | Verifica scope e vincoli |
| `migrate-stack` | Piano migrazione stack |

#### Refactoring (`refactor`)

| ID | Nome |
|---|---|
| `extract-reusable` | Estrazione moduli riusabili |
| `simplify-conditionals` | Semplificazione condizionali |
| `refactor-monolith` | Split monolite |

#### Debug (`debug`)

| ID | Nome |
|---|---|
| `reproduce-bug` | Reproduzione bug |
| `debug-with-rag` | Debug con contesto documentale |
| `root-cause-five-whys` | Root cause analysis (5 Whys) |

#### Review (`review`)

| ID | Nome |
|---|---|
| `code-review` | Code review multi-ruolo |
| `security-audit` | Audit sicurezza |
| `performance-review` | Review performance |
| `test-coverage-analysis` | Analisi coverage |

#### Test (`test`)

| ID | Nome |
|---|---|
| `write-unit-tests` | Unit test |
| `write-integration-tests` | Integration test |
| `regression-test` | Test di regressione |

#### Docs (`docs`)

| ID | Nome |
|---|---|
| `write-readme` | README |
| `write-tsdoc` | TSDoc/JSDoc |
| `write-changelog` | Changelog |

#### Git-ops (`ops`)

| ID | Nome |
|---|---|
| `commit-message` | Messaggio commit |
| `pr-description` | Descrizione PR |
| `ci-pipeline` | Pipeline CI |

### Skill personalizzate (`SKILL.md`)

Formato compatibile con opencode, Hermes e Claude Code. Directory di discovery (la prima vince):

1. `<progetto>/.zelari/skills/<nome>/SKILL.md`
2. `<progetto>/.claude/skills/<nome>/SKILL.md`
3. `<progetto>/.opencode/skills/<nome>/SKILL.md`
4. `~/.zelari-code/skills/<nome>/SKILL.md`

**Frontmatter minimo:**

```yaml
---
name: my-skill
description: Cosa fa questa skill
category: review        # opzionale
tools: read_file,grep   # opzionale
cost: medium            # opzionale: low|medium|high
---
Corpo markdown = system prompt della skill.
```

Invocazione: `/skill my-skill argomento opzionale`.

### Statistiche skill

Le invocazioni sono loggate in `~/.tmp/zelari-code/skill-history.jsonl`.

```
/skill-stats                  # tutte le skill
/skill-stats code-review      # una skill
/skill-compare debug refactor # confronto
```

---

## Council (multi-agente)

### Flusso tipico

1. Attiva modalità council (**Shift+Tab** o `/council …`)
2. Descrivi il task: *"Progetta l'architettura di un'app React per luxury marketplace"*
3. I membri eseguono in sequenza; Nettuno persiste il piano via `createPlan`
4. Al termine: post-hook aggiorna `AGENTS.MD` e completa il design (`completeDesign`)
5. Artefatti in `.zelari/` consultabili con `/workspace`

### Feedback e ranking

```
/council-feedback nettun 5 piano dettagliato e actionable
/council-feedback minos 3 critiche utili ma troppo generiche
```

I feedback influenzano l'ordinamento dei membri specialist nelle run future.

### Promuovere un membro

```
/promote-member geryon
```

Crea una skill standalone basata sul system prompt del membro, salvata in `~/.zelari-code/skills/`.

---

## Workspace `.zelari/`

Directory **per-progetto** (auto-gitignored) dove il council persiste artefatti strutturati.

```
.zelari/
├── plan.md / plan.json     # fasi, task, milestone
├── risks.md                # registro rischi
├── decisions/              # ADR (001-slug.md)
├── reviews/                # verdict Minosse
└── docs/                   # bozze documenti (design tokens, IA, …)

AGENTS.MD                   # alla root — auto-curato dal council
```

### Comandi workspace

Vedi [sezione slash](#workspace) sopra.

### AGENTS.MD

Partizionato in:

- **Blocchi manuali** — preservati verbatim
- **Sezioni auto** (`<!-- zelari:auto:start section="..." -->`) — sovrascritte a ogni sync

Sezioni auto: `tech-stack`, `decisions`, `conventions`, `build`, `open-questions`.

Disabilitare: `ZELARI_AGENTS_MD=0`

---

## MCP (Model Context Protocol)

Server MCP esterni espongono tool aggiuntivi al CLI e al council.

### Configurazione

File in formato Claude Desktop (il progetto vince sui conflitti):

- `<progetto>/.zelari/mcp.json`
- `~/.zelari-code/mcp.json`

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

I tool MCP appaiono come `mcp_<server>_<tool>` nel registry.

**Desktop:** Settings → **MCP Extensions** installa voci comuni (npx on-demand) senza editare a mano.

CLI: `--print-mcp`, `--set-mcp`, `--remove-mcp`.

Disabilitare tutto: `ZELARI_MCP=0`

Vedi anche [TOOLS.md](./TOOLS.md).

---

## SSH (deploy / monitor)

Zelari **non** è un client SSH interattivo: registra **target** e espone tool OpenSSH (`ssh` sul PATH) all’agente.

### Config

| File | Contenuto |
|---|---|
| `~/.zelari-code/ssh-targets.json` | Host, user, port, auth, allowlist comandi |
| `~/.zelari-code/ssh-secrets.json` | Password (solo auth=password; non in chat/LLM) |

### Auth

| Mode | Cosa serve |
|---|---|
| **password** | IP/host + username + password (caso VPS tipico) |
| **agent** | Chiavi già caricate in `ssh-agent` |
| **keyPath** | Path chiave privata locale (+ `.pub` opzionale per copia su server) |

### Desktop

Settings → **Connections** → Add target → Auth **Password** → Host/IP, User, Password → Save → **Test**.

### Tool agente

| Tool | Uso |
|---|---|
| `ssh_status` | Health check sul target (`true` / status) |
| `ssh_run` | Comando remoto **solo** se matcha `allowedCommands` (literal o `prefix*`) |

Esempio allowlist: `systemctl status *`, `journalctl *`, `docker ps*`, `df -h*`, `uptime`.

### CLI

```bash
zelari-code --print-ssh-targets
zelari-code --set-ssh-target --json '{"id":"vps1","name":"VPS","host":"1.2.3.4","user":"root","auth":"password","password":"…","allowedCommands":["uptime","df -h*"]}'
zelari-code --test-ssh-target --id vps1
zelari-code --print-ssh-pubkey --path %USERPROFILE%\.ssh\id_ed25519.pub
```

Kill switch: `ZELARI_SSH=0`.

---

## Sessioni e branch

### Sessioni

Ogni conversazione è persistita come JSONL in `~/.tmp/zelari-code/sessions/<id>.jsonl`.

```
/sessions          # elenco
/resume abc123     # imposta sessione da riprendere
/new               # nuova sessione
/compact           # compatta transcript lungo
```

### Branch

I branch isolano snapshot di sessioni (non sono branch git):

```
/branch feature-x     # crea branch con snapshot corrente
/branches             # elenco
/checkout feature-x   # attivo al PROSSIMO avvio di zelari-code
```

> Dopo `/checkout`, esci con `/exit` e rilancia `zelari-code`.

---

## Tool disponibili

Riepilogo; dettaglio in [TOOLS.md](./TOOLS.md).

### Harness (sempre disponibili)

| Tool | Permessi |
|---|---|
| `read_file`, `write_file`, `edit_file` | filesystem (sandbox project root) |
| `bash` | shell (blocklist sicurezza) |
| `grep_content` | ricerca regex ricorsiva |
| `list_files` | listing directory |
| `show_diff`, `apply_diff` | diff e patch |
| `fetch_url` | HTTP GET, HTML→testo |
| `web_search` | DuckDuckGo (o Tavily con `TAVILY_API_KEY`) |

### Workspace (council / skill che li richiedono)

`createPlan`, `createPhase`, `createTask`, `updateTask`, `addIdea`, `createMilestone`, `createDocument`, `searchDocuments`, `linkDocuments`, `getDocumentBacklinks`

### Frontier tools v1.3.0 (opt-in, no-op se la dipendenza manca)

| Tool | Permesso | Prereq | Esempio |
|---|---|---|---|
| `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_symbols` / `lsp_rename` | read / write (`lsp_rename`) | language server sul PATH | `usa lsp_references su src/cli/app.tsx:42 per trovare tutti gli usi di "agentLoop"` |
| `ast_outline` / `ast_find_symbol` | read | nessuno | `ast_outline su packages/core/src/agents/council/` |
| `semantic_search` | read | indice costruito (`/index` prima) | `semantic_search "dove gestiamo l'auto-retry del provider"` |
| `browser_check` | sandboxed network | Playwright + chromium | `browser_check su http://localhost:3000 dopo aver cliccato Submit` |

### Hook v1.2.0

- **Diagnostics loop** — dopo `edit_file`/`write_file`, l'harness lancia `eslint`/`ruff` (LSP-pluggable) e inietta gli errori nello stesso turno. Disattiva: `ZELARI_DIAGNOSTICS=0`.
- **Sub-agent delegation (`task` tool)** — delega un sub-task a un sub-agente isolato con context proprio, registry read-only, max 12 turni, no ricorsione.
- **Prompt-cache accounting** — hit-rate visibile in status bar (`cache 73%`).

---

## Novità v1.3.0 (frontier tools)

v1.3.0 è una **release frontier**: aggiunge cinque famiglie di capability che spostano il CLI da "agente singolo con tool file/web" a "agente con accesso strutturato al codice e al browser".

### Cosa è cambiato in sintesi

1. **LSP code intelligence** — cinque tool (`lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_rename`) che parlano con language server reali. L'agente ora può chiedere "dove è definita la funzione X?" o "rinomina X in Y in tutto il workspace" con precisione LSP.
2. **AST structural tools** — `ast_outline` e `ast_find_symbol` via TypeScript Compiler API. Nessuna dipendenza esterna, funzionano out-of-the-box su progetti TS.
3. **Semantic code search** — `semantic_search` indicizza il progetto via embeddings locali (default `Xenova/all-MiniLM-L6-v2`) e permette query concettuali ("dove gestiamo i retry?") invece di keyword esatte. Costruisci l'indice con `/index`.
4. **Browser verification** — `browser_check` apre un URL in un browser headless (Playwright), esegue azioni (`click`, `fill`, `goto`, `wait`), cattura console + network + screenshot. Pensato per verificare visivamente il lavoro web.
5. **shift+tab hardening + `/mode`** — il toggle della modalità ora funziona anche in terminali che catturano shift+tab, grazie al comando `/mode [agent|council|zelari]`.

### Esempi d'uso

```text
# Trova tutte le referenze a una funzione via LSP
"usa lsp_references su packages/core/src/core/harness/loop.ts per trovare tutti i caller di agentLoop"

# Rinomina simbolo via LSP (cross-workspace)
"rinomina la funzione `executeStep` in `step` ovunque con lsp_rename"

# Outline di un modulo TS senza LSP
"fai ast_outline di packages/core/src/agents/council/"

# Search semantico
"/index
 semantic_search 'dove gestiamo il retry del provider quando il primo tentativo fallisce'"

# Verifica visiva di un'app web
"browser_check http://localhost:3000, aspetta il selettore '.todo-list', fai uno screenshot, dimmi se ci sono errori console"

# Forza modalità in un terminale che cattura shift+tab
"/mode zelari
 progettami un'app todo full-stack"
```

### Costi e disabilitazione

Tutti i nuovi tool sono **opt-out**, non opt-in:

```bash
ZELARI_LSP=0      # disabilita i 5 tool LSP
ZELARI_AST=0      # disabilita ast_outline, ast_find_symbol
ZELARI_SEMANTIC=0 # disabilita semantic_search e /index
ZELARI_BROWSER=0  # disabilita browser_check
ZELARI_DIAGNOSTICS=0  # disabilita diagnostics loop
```

Se una dipendenza manca (es. nessun language server sul PATH), il tool fallisce con un messaggio chiaro e l'agente può scegliere un'alternativa.

---

## File di configurazione

Tutto sotto `~/.tmp/zelari-code/` (salvo override env):

| File | Contenuto |
|---|---|
| `provider.json` | Provider attivo, modelli, endpoint custom |
| `keys.json` | API key e token OAuth |
| `models.json` | Cache modelli scoperti |
| `sessions/<id>.jsonl` | Transcript sessioni |
| `current.txt` | ID sessione corrente |
| `branches/<nome>/` | Snapshot branch |
| `skill-history.jsonl` | Storico invocazioni skill |
| `skill-cache.json` | Cache skill |
| `council-feedback.json` | Rating membri council |
| `metrics.jsonl` | Metriche fire-and-forget |

---

## Variabili d'ambiente

### Zelari / wizard / UI

| Variabile | Effetto |
|---|---|
| `ZELARI_NO_WIZARD=1` | Salta wizard |
| `ZELARI_NO_SPLASH=1` | Salta splash screen |
| `ANATHEMA_DEV=1` | Disabilita check aggiornamenti in background |

### Provider / API

| Variabile | Effetto |
|---|---|
| `OPENAI_API_KEY` | Key OpenAI-compatible |
| `OPENAI_BASE_URL` | Endpoint custom |
| `OPENAI_MODEL` | Modello default |
| `GROK_API_KEY` | Key Grok (alternativa a OAuth) |
| `GLM_API_KEY` | Key GLM/Z.AI |
| `MINIMAX_API_KEY` | Key MiniMax |
| `TAVILY_API_KEY` | Web search via Tavily |
| `ANATHEMA_ACTIVE_PROVIDER` | Override provider attivo |
| `ANATHEMA_FAILOVER=0` | Disabilita failover |
| `ANATHEMA_FAILOVER_PROVIDER` | Provider di fallback |

### Council

| Variabile | Effetto |
|---|---|
| `ZELARI_COUNCIL_TIER=lite` | Council a 3 membri |
| `ZELARI_COUNCIL_SIZE=N` | Dimensione roster (1–6) |
| `ZELARI_COUNCIL_MODE` | `design-phase` o `implementation` |
| `ZELARI_AGENTS_MD=0` | Disabilita sync AGENTS.MD |
| `ZELARI_COMPLETE_DESIGN=0` | Disabilita post-processor design |

### Tool / MCP / shell / SSH / Desktop

| Variabile | Effetto |
|---|---|
| `ZELARI_MCP=0` | Disabilita MCP |
| `ZELARI_SSH=0` | Disabilita tool e target SSH |
| `ZELARI_CLI_PATH` | Desktop: path a `bin/zelari-code.js` locale |
| `ZELARI_NO_PATH_REPAIR=1` | Windows: non riparare il PATH npm |
| `ZELARI_MAX_TOOL_CALLS` | Limite tool call per turno |
| `ZELARI_TOOL_OUTPUT_LINES` | Righe output tool in TUI (default 8) |
| `ZELARI_SHELL` | Path esplicito bash (Windows) |
| `ZELARI_PROVIDER_TIMEOUT_MS` | Timeout hard sulla fetch provider (default 5 min) |

### Frontier tools (v1.3.0) / agentic harness (v1.2.0)

| Variabile | Default | Effetto |
|---|---|---|
| `ZELARI_LSP` | `1` | `0` disabilita i 5 tool LSP |
| `ZELARI_AST` | `1` | `0` disabilita AST tools |
| `ZELARI_SEMANTIC` | `1` | `0` disabilita semantic search + `/index` |
| `ZELARI_SEMANTIC_FILE` | `~/.tmp/zelari-code/semantic.json` | path dello store embeddings |
| `ZELARI_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | modello embedding per semantic search |
| `ZELARI_BROWSER` | `1` | `0` disabilita `browser_check` |
| `ZELARI_DIAGNOSTICS` | `1` | `0` disabilita la diagnostics loop post-edit |
| `ZELARI_DIAGNOSTICS_TIMEOUT_MS` | `5000` | timeout della diagnostics loop |
| `ZELARI_CHECKPOINT` | `1` | `0` disabilita i checkpoint automatici in zelari-mode |

### Path override (test/CI)

| Variabile | File |
|---|---|
| `ANATHEMA_PROVIDER_CONFIG_FILE` | provider.json |
| `ANATHEMA_KEYSTORE_FILE` | keys.json |
| `ANATHEMA_SESSIONS_DIR` | directory sessioni |
| `ANATHEMA_BRANCHES_DIR` | directory branch |
| `ANATHEMA_METRICS_FILE` | metrics.jsonl |
| `ANATHEMA_SKILL_HISTORY_FILE` | skill-history.jsonl |

---

## Self-update

```bash
# In TUI:
/update              # controlla versione
/update --yes        # npm install -g zelari-code@latest

# All'avvio: hint su stderr se esiste versione più recente
ANATHEMA_DEV=1 zelari-code   # disabilita il check silenzioso
```

Dopo `/update --yes`, riavvia manualmente con `/exit` e `zelari-code`.

---

## Sviluppo

```bash
npm install
npm run build:cli     # tsc + esbuild bundle
npm test              # ~900+ test vitest
npm run typecheck
npm run smoke         # verifica bin
```

### Struttura monorepo

```
zelari-code/
├── packages/core/     # @zelari/core — AgentHarness, council, skills, tools
├── src/cli/           # TUI Ink, provider, workspace, wizard
├── tests/unit/        # test Vitest
└── docs/              # questa documentazione
```

---

## Risoluzione problemi

### `zelari-code: command not found` (Windows)

Vedi [Installazione Windows](#windows-zelari-code-non-trovato).

### Wizard non parte / parte sempre

- Manca `~/.tmp/zelari-code/provider.json` → wizard al primo avvio
- `--reset-config` forza il wizard
- `--no-wizard` o `ZELARI_NO_WIZARD=1` lo sopprime

### API key mancante

```
/login <provider> <key>
# oppure
export OPENAI_API_KEY=sk-...
```

In headless senza config: passa `--provider` + variabile env.

### Council non persiste il piano

- Verifica modalità design-phase (keyword "design", "architettura", …)
- Controlla `.zelari/plan.json` dopo la run
- Nettuno deve chiamare `createPlan` (non solo prose)

### MCP non carica tool

- Verifica JSON in `.zelari/mcp.json`
- Controlla stderr per warning server rotti
- `ZELARI_MCP=0` disabilita tutto — rimuovilo

### Shell su Windows

Se `bash` fallisce, imposta Git Bash esplicitamente:

```bash
ZELARI_SHELL="C:\Program Files\Git\bin\bash.exe" zelari-code
```

### Publish npm / CI

Vedi [MIGRATION.md](../MIGRATION.md) e `docs/decisions/0002-publish-zelari-core-to-npm.md` per `@zelari/core` e Trusted Publishing.

---

## Link utili

- [Repository GitHub](https://github.com/N-THEM-Studio/zelari-code)
- [npm: zelari-code](https://www.npmjs.com/package/zelari-code)
- [npm: @zelari/core](https://www.npmjs.com/package/@zelari/core)
- [AnathemaBrain](https://github.com/N-THEM-Studio/AnathemaBrain) — GUI desktop condivisa