# Zelari Code — Guida all'uso

> **Versione documento:** 0.7.9  
> CLI multi-agente per coding con TUI (Ink + React), council a 6 ruoli, slash commands e provider LLM agnostici.

---

## Indice

1. [Cos'è Zelari Code](#cosè-zelari-code)
2. [Installazione](#installazione)
3. [Primo avvio e wizard](#primo-avvio-e-wizard)
4. [Interfaccia TUI](#interfaccia-tui)
5. [Modalità agent e council](#modalità-agent-e-council)
6. [Comandi da terminale (flags)](#comandi-da-terminale-flags)
7. [Modalità headless (CI/script)](#modalità-headless-ciscript)
8. [Comandi slash](#comandi-slash)
9. [Provider e autenticazione](#provider-e-autenticazione)
10. [Skills](#skills)
11. [Council (multi-agente)](#council-multi-agente)
12. [Workspace `.zelari/`](#workspace-zelari)
13. [MCP (Model Context Protocol)](#mcp-model-context-protocol)
14. [Sessioni e branch](#sessioni-e-branch)
15. [Tool disponibili](#tool-disponibili)
16. [File di configurazione](#file-di-configurazione)
17. [Variabili d'ambiente](#variabili-dambiente)
18. [Self-update](#self-update)
19. [Sviluppo](#sviluppo)
20. [Risoluzione problemi](#risoluzione-problemi)

---

## Cos'è Zelari Code

**Zelari Code** è un agente di coding da terminale sviluppato da [N-THEM Studio](https://github.com/N-THEM-Studio). Estratto da [AnathemaBrain](https://github.com/N-THEM-Studio/AnathemaBrain), offre:

- Una **TUI** ricca con scrollback nativo, sidebar git e timer di esecuzione
- Un **agente singolo** con tool filesystem, shell, ricerca e web
- Un **council** a 6 membri (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero)
- **23 skill** builtin + skill personalizzate in formato `SKILL.md`
- Persistenza progetto in **`.zelari/`** e auto-curation di **`AGENTS.MD`**
- Supporto **MCP**, **headless mode** e **self-update**

Il runtime condiviso è pubblicato come package npm [`@zelari/core`](https://www.npmjs.com/package/@zelari/core) (MIT).

---

## Installazione

### Requisiti

- **Node.js ≥ 20**
- Account e API key per almeno un provider LLM (o OAuth Grok)

### Installazione globale

```bash
npm install -g zelari-code
zelari-code --version
```

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

---

## Modalità headless (CI/script)

Esegue un singolo task senza montare la TUI. Utile per pipeline CI, script e automazione.

```bash
zelari-code --headless --task "Spiega cosa fa src/cli/main.ts" --output json
```

### Opzioni headless

| Flag | Default | Descrizione |
|---|---|---|
| `--task <testo>` | *(obbligatorio)* | Prompt da eseguire |
| `--output json\|plain` | `json` | `json` = NDJSON (un evento BrainEvent per riga); `plain` = solo testo assistant |
| `--council` | off | Usa il pipeline council invece dell'agente singolo |
| `--provider <id>` | provider attivo | Override provider |
| `--model <nome>` | modello del provider | Override modello |

### Esempi

```bash
# Agente singolo, output testuale
zelari-code --headless --task "Elenca i file in src/cli" --output plain

# Council, output JSON per piping
zelari-code --headless --task "Progetta API REST per todo" --council --output json \
  | jq 'select(.type=="message_delta") | .delta'

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

## Comandi slash

Tutti i comandi iniziano con `/` e si digitano nella barra di input della TUI.

### Riferimento rapido

#### Aiuto e uscita

| Comando | Descrizione |
|---|---|
| `/help` | Elenco comandi e skill disponibili |
| `/exit` | Esci dalla CLI |

#### Provider e modello

| Comando | Descrizione |
|---|---|
| `/login <provider> [key]` | Autentica un provider; senza key avvia OAuth per `grok` |
| `/provider` | Picker interattivo dei provider (↑/↓ + invio, esc annulla) |
| `/provider <id>` | Cambia provider (`openai-compatible`, `grok`, `minimax`, `glm`, `custom`) |
| `/provider list` | Mostra provider attivo e disponibili (testo) |
| `/provider custom <url>` | Endpoint custom (Ollama, LM Studio, vLLM, …) |
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
| `minimax` | MiniMax | `MINIMAX_API_KEY` | — |
| `glm` | GLM / Z.AI | `GLM_API_KEY` | Base URL: `https://api.z.ai/v1` |
| `custom` | Custom | dipende | Usa `/provider custom <url>` |

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

Disabilitare tutto: `ZELARI_MCP=0`

Vedi anche [TOOLS.md](./TOOLS.md).

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

### Tool / MCP / shell

| Variabile | Effetto |
|---|---|
| `ZELARI_MCP=0` | Disabilita MCP |
| `ZELARI_MAX_TOOL_CALLS` | Limite tool call per turno |
| `ZELARI_TOOL_OUTPUT_LINES` | Righe output tool in TUI (default 8) |
| `ZELARI_SHELL` | Path esplicito bash (Windows) |

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