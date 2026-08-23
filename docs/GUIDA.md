# Zelari Code — Guida all'uso

> **Versione documento:** 2.7.0
> CLI multi-agente per coding con TUI (Ink + React), **Zelari Desktop** (Tauri 2), council a 6 ruoli, super-agent **kraken**, missioni **zelari**, slash commands, MCP, SSH e provider LLM agnostici (OAuth Grok / ChatGPT / Anthropic).  
> Prodotto: **[Anathema Studio](https://anathema-studio.com/)** · licenza **Apache-2.0**.

---

## Indice

1. [Cos'è Zelari Code](#cosè-zelari-code)
2. [Prerequisiti](#prerequisiti)
3. [Installazione](#installazione)
4. [Primo avvio e wizard](#primo-avvio-e-wizard)
5. [Interfaccia TUI](#interfaccia-tui)
6. [Modalità kraken, council e zelari](#modalità-agent-e-council)
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
17a. [Host, Profile e Phase (2.0)](#host-profile-e-phase-2-0)  
17b. [Session spine 2.0 (canonica)](#session-spine-20-canonica)  
17c. [Verifica deterministica, Strict Done e Verifier LLM (2.0)](#verifica-deterministica-strict-done-e-verifier-llm-2-0)  
18. [Tool disponibili](#tool-disponibili)
19. [Capability avanzate e novità 1.26–1.34](#capability-avanzate-e-novità-112114)
20. [File di configurazione](#file-di-configurazione)
21. [Variabili d'ambiente](#variabili-dambiente)
22. [Self-update](#self-update)
23. [Sviluppo](#sviluppo)
24. [Risoluzione problemi](#risoluzione-problemi)

---

## Cos'è Zelari Code

**Zelari Code** è un agente di coding da terminale open source (Apache-2.0) di **[Anathema Studio](https://anathema-studio.com/)**. Pagina prodotto: [anathema-studio.com/zelari-code](https://anathema-studio.com/zelari-code). Offre:

- Una **TUI** ricca con scrollback nativo, sidebar git e timer di esecuzione
- Un super-agent **kraken** (default; alias `agent`/`single`) con tentacoli `task` e **Kraken Graph**
- Un **council** a 6 membri (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero)
- Missioni autonome **zelari** (design@council → build@kraken)
- **26 skill** builtin + skill personalizzate in formato `SKILL.md`
- Persistenza progetto in **`.zelari/`** e auto-curation di **`AGENTS.MD`**
- Supporto **MCP**, **SSH targets**, **folder trust**, **lifecycle hooks**, **headless**, **Zelari Desktop**, **Companion Android** e **self-update**

Il runtime condiviso è pubblicato come package npm [`@zelari/core`](https://www.npmjs.com/package/@zelari/core) (Apache-2.0).

---

## Prerequisiti

| Requisito | Versione | Note |
|---|---|---|
| **Node.js** | **≥ 24 LTS** | Testato solo su Node 24 in CI; Node 20 è stata rimossa dalla matrix (l'albero dipendenze lo richiede). |
| **npm** | **≥ 11.7** | Necessario per riprodurre il lockfile del workspace; usa la versione fissata da `packageManager`. |
| **OS** | Linux, macOS, Windows 10/11 | Windows richiede Git Bash (auto-rilevato). |
| **Account + API key** | 1 tra: xAI Grok, ChatGPT, Anthropic, OpenAI-compatible, GLM/Z.AI, MiniMax, DeepSeek | OAuth: `/login grok`, `/login chatgpt`, `/login anthropic`. |

### Dipendenze opzionali (capability avanzate)

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

1. Node.js ≥ 24 sul PATH
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
2. **Provider** — scegli tra `grok`, `minimax`, `glm`, `deepseek`, `openai-compatible` (ChatGPT / Anthropic via `/login` dopo il wizard)
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

### Layout

```
┌─────────────────────────────────────────────┬──────────┐
│  Chat (scrollback nativo — messaggi finali) │ Sidebar  │
│  ...                                        │ git diff │
│  [streaming in corso]                       │  +file   │
├─────────────────────────────────────────────┤  -file   │
│  > input bar                                │          │
├─────────────────────────────────────────────┴──────────┤
│  ● ⏵ kraken (shift+tab) · grok · grok-4.5 · sess · cwd  │
└────────────────────────────────────────────────────────┘
```

- **Chat**: i messaggi completati restano nello scrollback del terminale (non svaniscono al refresh)
- **Sidebar**: modifiche git live (`+added` / `-removed`), aggiornata ogni ~4s; nascosta su terminali stretti
- **Status bar** (sotto l'input): modalità, provider, modello, sessione, cwd, timer (`⏱ 12s` / `last 34s`)

### Scorciatoie

| Tasto | Azione |
|---|---|
| **Shift+Tab** | Cicla modalità `kraken` → `council` → `zelari` (`agent` = alias) |
| **Ctrl+C** | Esci (flush metriche + chiusura MCP) |
| Qualsiasi tasto | Salta lo splash screen iniziale (~2s) |

### Splash screen

All'avvio compare il logo ASCII per ~2 secondi. Disabilitabile:

```bash
ZELARI_NO_SPLASH=1 zelari-code
```

Saltato automaticamente su stdout non-TTY (pipe, CI) o terminali piccoli.

---

## Modalità kraken, council e zelari

Due assi indipendenti:

| Asse | Valori | Come |
|------|--------|------|
| **Mode** (dispatch) | `kraken` · `council` · `zelari` | Shift+Tab o `/mode` (`agent`/`single` = alias di kraken) |
| **Phase** (lavoro) | `plan` · `build` | `/plan` · `/build` o `--phase` |

| Mode × Phase | Tipico uso |
|--------------|------------|
| kraken + plan | Esplora/progetta senza scrivere sul progetto |
| kraken + build | **Implementer di default** — tool completi + tentacoli `task` |
| council + plan / design-phase | Piano e artifact in `.zelari/` (ruolo principale del multi-agente) |
| council + build / implementation | Soft-gate: di default resta in design-phase; Lucifero implementa solo con `ZELARI_COUNCIL_CAN_BUILD=1` |
| zelari | Missione: **design@council → build@kraken** fino a completion |

> **Esperimento (branch `experiment/plan-multiagent-build-agent`):** multi-agente = planning; agent singolo = build. Vedi variabili sotto.

### Kraken (default)

Super-agent (alias legacy `agent` / `single`): un lead che usa i tool builtin e può spawnare **tentacoli** via `task` (`explore` read-only, `general` con write, `verify` per test). Ideale per implementazione. Vedi [Kraken](#kraken-super-agent--tentacoli-e-env) in fondo alla guida.

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
5. La missione termina con **successo** quando `completion.ok` è verde sullo slice MVP, oppure si **ferma** al raggiungimento del budget di **implementazioni** (`ZELARI_MISSION_MAX_ITER`, default 6). La **design-phase** iniziale (se prevista dal brief) è **fuori budget** e non consuma iterazioni. **Default esperimento:** le slice di **implementation** usano l’**agente singolo** (`build@kraken`); la design-phase resta sul council. Con `ZELARI_BUILD_VIA_AGENT=0` (legacy) la prima implementation usa il council completo e dalle **implementation 2+** il roster è ridotto a **Minosse + Lucifero**. Stato salvato in `.zelari/mission-state.json`.

**Variabili:**

| Variabile | Default | Effetto |
|---|---|---|
| `ZELARI_MISSION_AUTO` | `0` | `1` = avvia la missione senza chiedere conferma del brief |
| `ZELARI_MISSION_MAX_ITER` | `6` | max slice di **implementation** (design-phase gratuita) |
| `ZELARI_MISSION_MAX_STALL` | `2` | slice implementation consecutive con 0 write prima di `stalled` (`0` = off) |
| `ZELARI_BUILD_VIA_AGENT` | on (≠`0`) | `0` = zelari impl di nuovo via council (legacy) |
| `ZELARI_COUNCIL_CAN_BUILD` | off | `1` = free-form council può implementare (Lucifero); forza anche zelari su path council |
| `ZELARI_MODE_MAX_TOOLS_AGENT` | `40` | budget tool call per slice agent in missione |
| `ZELARI_MODE_MAX_TOOLS_LUCIFER` | `30` | budget tool call chairman (solo path legacy council impl) |
| `ZELARI_TASK_CONTRACT` | `1` | `0` = disattiva il TaskContract della missione (goal / constraints / acceptance dal brief; default on) |

**Continuation budget-aware (2.6.3):** terminata ogni slice di implementation, un gate valuta budget residuo e storia dei gap: `repair` riprova la slice, `pivot` cambia approccio dopo lo stesso GAP ripetuto (roster ridotto), `hold` ferma la missione all'esaurimento del budget **senza** dichiarare done (il PASS deterministico resta l'unica authority; niente `passByBudget`).

### Memoria di progetto

Il backend compatibile salva gli esiti in `.zelari/memory/log.jsonl`. Con
`ZELARI_MEMORY_V2=1` (o `ZELARI_MEMORY_BACKEND=sqlite`) entra in funzione la
memoria cognitiva nativa in `.zelari/memory/memory.db`: nodi e relazioni
tipizzati, provenienza, versioni immutabili, FTS, ranking e context budget.
Council, Kraken, missioni, modalità headless e sessioni successive condividono
lo stesso scope di progetto senza MCP. Il JSONL precedente viene importato in
modo idempotente e rimane intatto.

Disattivala con `ZELARI_MEMORY=0` (degrada a no-op, il resto continua a
funzionare). Per mantenere solo il recall V2 imposta
`ZELARI_MEMORY_AUTO_WRITE=0`. Dettagli, sicurezza e diagnostica:
[`docs/MEMORY.md`](./MEMORY.md).

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
| `--print-skills` / `--set-skill` / `--remove-skill` | Skill `SKILL.md` (user/project) |
| `--generate-skill-from-url --url <https…>` | Bozza skill via modello attivo |
| `serve` | Companion host (Android/Tailscale) — vedi [Desktop](#zelari-desktop) |
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
| `--mode kraken\|council\|zelari` | `kraken` | Dispatch mode (`agent`/`single` = alias; `--council` resta legacy) |
| `--phase plan\|build` | `build` | In `plan` non muta il progetto (no write/edit/bash aggressivi) |
| `--council` | off | Alias legacy → mode council |
| `--provider <id>` | provider attivo | Override provider |
| `--model <nome>` | modello del provider | Override modello |
| `--history-file <path>` | — | Storia multi-turno (JSON) usata dalla Desktop |
| `--task-file <path>` | — | Come `--task` ma da file (evita il limite argv di Windows) |
| `--once` | off | Modalità trigger: singolo ciclo + lockfile (cron / git hook) |
| `--profile <id>` | per `--mode` | Profilo di capability: `minimal/v1` \| `kraken/v1` \| `council/v1` \| `mission/v1`. Registrato nell'header della session spine |
| `--resume <sessionId>` | — | Riprende una sessione spine 2.0 (la numerazione `seq` prosegue) |
| `--export-session <path>` | — | Scrive un export `zelari-session-export/1` JSON al termine (`-` = stdout) |
| `--strict-done` | off (kraken) | Attiva l'evidence gate ADR-0023. Le mission lo hanno **di default** (ADR-0025) |
| `--no-strict-done` | — | Opt-out del gate strict per le mission (`ZELARI_MISSION_STRICT=0`) |

### Esempi

```bash
# Agente singolo, output testuale
zelari-code --headless --task "Elenca i file in src/cli" --output plain

# Council, output JSON per piping
zelari-code --headless --task "Progetta API REST per todo" --council --output json \
  | jq 'select(.type=="message_delta") | .delta'

# Plan-only (niente mutazioni)
zelari-code --headless --mode kraken --phase plan --task "Outline the refactor"

# Provider esplicito (utile senza wizard/config)
OPENAI_API_KEY=sk-... zelari-code --headless \
  --provider openai-compatible --model grok-4 \
  --task "Review package.json"

# Riprendi una sessione spine (il contesto deriva da events.jsonl, non da --history)
zelari-code --headless --resume <sessionId> --task "Procedi con il refactor"

# Esporta la sessione per replay/analisi offline (zelari-session-export/1)
zelari-code --headless --task "..." --export-session session.json
```

### Exit code headless

| Codice | Significato |
|---|---|
| `0` | Completato (`agent_end.reason === 'completed'`) |
| `1` | Errore utente (flag mancanti, API key assente) |
| `2` | Errore runtime (provider, eccezione council) |
| `3` | Run agente terminato con errore |
| `4` | Strict evidence gate bloccato (ADR-0023/0025): dettagli nell'evento `verification.run` della session spine |

---

## Host, Profile e Phase (2.0)

La separazione concettuale del runtime 2.0 (ADR-0022): **chi** esegue, **con quali capability**, **in quale fase**.

### Host

| Host | Come si attiva | Note |
|---|---|---|
| TUI | `zelari-code` (default) | Ink + React, scrollback nativo |
| headless | `--headless --task ...` | NDJSON o plain text; per CI/script/Desktop |
| Desktop | app Tauri 2 | pilotata via canale headless + `serve` |
| serve | `/serve` | API locale per la Companion Android |

L'host **non** cambia le capability dell'agente: cambia solo la superficie di I/O. Il model context deriva sempre dalla session spine.

### Profile

Il profilo è un **manifest dichiarativo di capability** (upper bound) versionato:

| Profilo | Default di mode | Contenuto |
|---|---|---|
| `minimal/v1` | — | Harness essenziale (read-only + task) |
| `kraken/v1` | `kraken` | Harness + workspace write/edit/bash + tentacoli |
| `council/v1` | `council` | Set esteso per il flusso council |
| `mission/v1` | `zelari` | Set delle missioni autonome |

Il default dipende da `--mode`; `--profile <id>` vince sempre. L'header della session spine registra il profilo e il `toolManifestHash` del set dichiarato: run diversi sullo stesso task/profilo restano confrontabili (stesso manifest ⇒ stesso hash).

### Phase

| Fase | Effetto runtime |
|---|---|
| `build` (default) | Capability complete del profilo |
| `plan` | I tool **mutatori** (`write_file`, `edit_file`, `apply_diff`, `bash`, …) vengono strippati dal registry; restano i task tool in sola lettura |

Il profilo dichiara il limite massimo, la fase restringe al momento dell'esecuzione: per questo `council+plan` non espone `write_file` benché `council/v1` lo dichiari.

---

## Zelari Desktop

Shell **Tauri 2** opzionale (`apps/desktop/`): chat moderna che esegue `zelari-code --headless` e streama eventi NDJSON.

| Controllo | Valori | Flag CLI |
|---|---|---|
| Mode | Kraken · Council · Zelari | `--mode` (`agent` = alias) |
| Phase | Plan · Build | `--phase` |
| Provider / model | barra + Settings | `--provider` / `--model` |
| Open Folder | directory di lavoro | cwd del processo CLI |
| Overlay HUD | barra staccabile (voce + testo) | titolo **◉** (non auto-open) |

### Multi-turn e history

La chat Desktop è la source of truth per la conversazione: history multi-turn via `--history-file`. Risposte corte (“procedi”, “sì”, “1”) vengono re-ancorate al contesto precedente (anche dopo switch plan↔build).

### Settings

- **Provider** — API key, endpoint OpenAI-compatible, discover models  
- **Defaults → Verification & experiments** — interruttori persistenti per Strict Kraken, Strict Mission, criteria pack nativo e Best-of-N; il Verifier advisory può essere Automatico, sempre attivo o sempre disattivo. **Gauntlet Loop** (toggle in top-bar e Settings) è un loop host BUILD: tentacoli builder/critic con cap e wall-clock, non un prompt; mutuamente esclusivo con Graph
- **Updates** — aggiornamento **app** (Tauri / GitHub Releases) vs **CLI** (`npm install -g`)  
- **Extensions** — MCP catalog + **Skills** (crea/rimuovi `SKILL.md` user/project; import da URL col modello attivo)  
- **Connections** — **Mobile connection** (start `zelari-code serve`, QR pairing Tailscale) + SSH deploy/monitor  

### Chat Desktop

- **@file** — digita `@` per taggare file/cartelle del progetto (Open Folder); anche pulsante `@` nel file tree  
- **Skills ★** — picker skill (builtin + user); si espande al Send come `/skill` in TUI  
- Composer a larghezza piena della colonna chat  

### Companion Android + `serve`

L’agent resta sul PC; il telefono è un thin client sulla stessa rete Tailscale (o LAN).

```bash
# Host (PC) — usa il CLI monorepo o npm@1.34+
npm run build:cli
zelari-code serve --bind 0.0.0.0 --port 7421 --project /path/to/repo
# oppure Desktop → Settings → Connections → Mobile connection → Start
```

- Token: `~/.zelari-code/companion.token`  
- Health: `GET http://<host>:7421/health`  
- App: [`apps/companion-android/`](../apps/companion-android/README.md) — tap **Scan QR from Desktop**  
- **Non** usare `127.0.0.1` sul telefono (è il device, non il PC). Serve l’IP Tailscale `100.x`

ADR: [`docs/decisions/0015-companion-host-serve.md`](./decisions/0015-companion-host-serve.md).

### Primo avvio

Se mancano Node o la CLI, appare la **Setup guide**. L’installer Desktop da solo non basta.  
Se usi il monorepo in dev, preferisci `npm run desktop:dev` (fa `build:cli`) o `ZELARI_CLI_PATH` verso `bin/zelari-code.js` — il npm globale può essere indietro e **non** avere `serve`.

### Sviluppo

```bash
npm run build
npm run desktop:install
npm run desktop:dev
# Android companion debug APK
npm run companion:android
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

#### Modalità di dispatch e phase

| Comando | Descrizione |
|---|---|
| `/mode [kraken\|council\|zelari]` | Forza la modalità di dispatch (`agent`/`single` = alias di kraken). Equivalente portabile di `shift+tab`. |
| `shift+tab` (TUI) | Cicla `kraken` → `council` → `zelari`. |
| `/kraken [sessionId]` | Radio tentacoli (`.zelari/radio/`). |
| `/kraken graph <goal>` | Pianifica ed esegue un DAG di tentacoli in parallelo. |
| `/plan [goal]` | Entra in phase **plan** (no write/edit/bash sul progetto). Opzionale: invia subito `goal`. |
| `/build [goal]` | Entra in phase **build** (tool completi). Opzionale: invia subito `goal`. |
| `/trust [path]` | Mostra o fida una cartella (MCP + hook di progetto). |
| `/trust remove [path]` | Revoca il trust. |
| `/integrations` | Elenca preset MCP (`composio`, `qwen-mm-plugins`, `cua`). |

#### Provider e modello

| Comando | Descrizione |
|---|---|
| `/login <provider> [key]` | Autentica un provider; senza key avvia OAuth per `grok`, `chatgpt`, `anthropic` |
| `/provider` | Picker interattivo dei provider (↑/↓ + invio, esc annulla) |
| `/provider <id>` | Cambia provider (`openai-compatible`, `grok`, `chatgpt`, `anthropic`, `minimax`, `glm`, `deepseek`) |
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

#### Memoria

| Comando | Descrizione |
|---|---|
| `/memory` o `/memory stats` | Backend, schema, nodi, archi e candidati |
| `/memory search <query>` | Recall corrente con ranking e grafo |
| `/memory show <id>` | Contenuto, lifecycle, provenienza e metadata |
| `/memory related <id>` | Relazioni tipizzate in ingresso e uscita |
| `/memory history <id>` | Timeline delle revisioni immutabili |
| `/memory retract <id> [reason]` | Ritira senza perdere la storia |
| `/memory forget <id> --yes` | Cancella fisicamente dopo conferma esplicita |
| `/memory consolidate [query]` | Consolida candidati ripetuti con `derived_from` |
| `/memory index [--force]` | Indicizza o ricostruisce gli embedding opzionali |
| `/memory promote <id>` | Promuove conoscenza durevole nel blocco gestito di `AGENTS.md` |
| `/memory doctor` | Schema, integrità, foreign key e FTS |
| `/memory export [path]` | Esporta JSON entro il progetto |

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

#### Checkpoint e rollback

| Comando | Descrizione |
|---|---|
| `/checkpoint [label]` | Snapshot del working tree (tracciati + untracked) via git plumbing. Ogni missione zelari-mode ne prende uno all'avvio. |
| `/rollback [id\|latest]` | Ripristino atomico di un checkpoint: ripristina i file modificati, ricrea i cancellati, rimuove i creati dopo lo snapshot. Senza argomento elenca i checkpoint disponibili. |
| `ZELARI_CHECKPOINT=0` | Disabilita checkpoint automatici nelle missioni. |

#### Durable state + prompt cache

Accumulo **verificato** di artefatti (Palmer *State, Not Tokens*) e ottimizzazione del **prefix cache** (AGNT Labs *Cache Wars*). Diverso da memory RAG (soft) e da git checkpoint (solo working tree).

| Comando | Descrizione |
|---|---|
| `/state status` | HEAD durable + ultimi commit sotto `.zelari/state/` |
| `/state commit [label]` | Soft commit manuale (force; non richiede verification) |
| `/state show [id]` | Materializza discoveries (HEAD se omesso) |
| `/state restore [id] [--no-tree]` | Imposta HEAD e, se presente, ripristina il git checkpoint collegato |
| `/cache stats` | Hit rate sessione, premium vs cached, stable busts |

| Variabile | Default | Effetto |
|---|---|---|
| `ZELARI_STATE` | `1` | `0` disabilita durable state store |
| `ZELARI_STATE_AUTO` | `0` (agent) | Auto-commit agent mode (Zelari/council post-verify sono on) |
| `ZELARI_PROMPT_CACHE_TTL` | `auto` | Preferenza documentata in `/cache stats` (`1h`/`5m`/`auto`). Sul path OpenAI-compat il caching è automatico server-side: l’efficienza reale viene dal **prefix stabile** (identity+tools), non da questo flag. Marker Anthropic futuri potranno usarlo. |
| `ZELARI_CTX_DURABLE_CHARS` | `3000` | Cap del blocco durable iniettato nel volatile prompt |

**Memoria vs state:** `.zelari/memory/` è conoscenza richiamabile e versionata;
`.zelari/state/` è catena di commit post-verification. Il log sessione resta la
cronologia event-sourced e `AGENTS.MD` il livello curato. I blocchi richiamati
sono aggiunti al contesto volatile del turno, non al system prefix cachabile.

**Restore:** `/state restore [id]` ripunta HEAD e, se presente, ripristina il git checkpoint collegato. Usa `--no-tree` per solo HEAD cognitivo.

#### Semantic search

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
| `chatgpt` | ChatGPT (abbonamento) | `CHATGPT_API_KEY` | OAuth magic-link / device: `/login chatgpt` |
| `anthropic` | Claude Pro/Max | `ANTHROPIC_API_KEY` | OAuth magic-link: `/login anthropic` poi incolla `CODE#STATE` |
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
/login chatgpt                 # ChatGPT subscription (device / magic link)
/login anthropic               # apre claude.ai; poi /login anthropic CODE#STATE
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

### OAuth Grok / ChatGPT / Anthropic

**Grok** (device flow RFC 8628):

1. `/login grok` (senza key)
2. Compare un codice e un URL di verifica
3. Apri l'URL, inserisci il codice, autorizza
4. Il token (access + refresh) viene salvato in `keys.json`

**ChatGPT** (subscription, non API key):

1. `/login chatgpt`
2. Apri l'URL, inserisci il user code, autorizza
3. Token + `ChatGPT-Account-Id` salvati; i modelli si scoprono da Codex

**Anthropic** (magic link / paste-code):

1. `/login anthropic` apre `claude.ai/oauth/authorize`
2. Dopo il login la pagina mostra un codice (`CODE#STATE`)
3. `/login anthropic <codice>`

Refresh forzato: `/provider grok refresh` (o `chatgpt` / `anthropic`).
Dalla Desktop app: Impostazioni → Provider → **Refresh token**.

CLI / Desktop:

```
zelari-code --login-oauth --provider grok
zelari-code --login-oauth --provider chatgpt
zelari-code --login-oauth --provider anthropic
zelari-code --login-oauth --provider anthropic --code 'CODE#STATE'
zelari-code --refresh-oauth --provider grok
zelari-code --logout-oauth --provider chatgpt
```

### Failover cross-provider

Su errori transienti, il CLI può riprovare con un provider alternativo.

```bash
ANATHEMA_FAILOVER_PROVIDER=grok zelari-code    # provider di fallback
ANATHEMA_FAILOVER=0 zelari-code                # disabilita failover
```

---

## Skills

### Skill builtin (26)

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

#### Harness / multimodal (`ops` + MCP)

| ID | Nome |
|---|---|
| `schema-loop` | Ipotesi + check certificabili + `run_backtest` |
| `computer-use-cua` | Computer-use su app native via Cua Driver MCP |
| `qwen-mm-plugins-install-setup` | Setup Qwen-MM-Plugins (vision/video/audio) |

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
├── docs/                   # bozze documenti (design tokens, IA, …)
├── memory/                 # memoria missioni zelari
├── radio/                  # bus tentacoli Kraken
├── kraken/                 # last-graph.json (resume DAG)
├── world/                  # schema-loop (hypothesis / checks / timeline)
└── hooks/                  # lifecycle hook di progetto (solo cartelle fidate)

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

> **Legacy 1.x (compat).** Questi comandi gestiscono le superfici di compat della 1.x. Dal 2.0 il contesto del modello è derivato **solo** dalla [Session spine 2.0](#session-spine-20-canonica): `--resume` headless e l'export `--export-session` sostituiscono lo snapshot di history per riprendere una sessione.

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

## Session spine 2.0 (canonica)

La **session spine** (ADR-0016/0021) è il log event-sourced che dal 2.0 è la **unica** source of truth del contesto del modello, su ogni hot path (headless kraken/council/zelari + TUI):

```
Session log (append-only JSONL)
    ↓ deriveMessages()
derivedToAgentMessages()
    ↓
model context (AgentHarness)
```

- **Dove:** `<workspace>/.zelari/sessions/<sessionId>/events.jsonl` (override di test con `ZELARI_SESSIONS_DIR`)
- **Garanzie:** append-only con single-writer lock, `seq` monotono, `SCHEMA_VERSION`, replay tollerante (un evento sconosciuto diventa un issue, non un crash)
- **Invariant:** ciò che il modello vede ⟺ ciò che è loggato — prompt utente inclusi, cosa che il log 1.x non registrava mai
- **Eventi di stato oltre al modello:** `verification.run` / `verification.evidence`, `mission.progress`, lineage (`session.forked`), `session.started` con profilo + manifest hash

- **Harness manifest (deep, 2.6.3):** il manifest della sessione fingerprinta la superficie tool reale (name + description + input schema) oltre a profilo e resource policy — un cambio di tool/descrizione/schema cambia l'hash, e il resume segnala il drift (`session.harness_drift`)

### Resume

```bash
zelari-code --headless --resume <sessionId> --task "secondo turno"
```

La numerazione `seq` prosegue nello stesso log; nessuno snapshot di history da ricostruire a mano.

### Export

```bash
zelari-code --headless --task "..." --export-session out.json   # oppure - per stdout
```

Produce un documento `zelari-session-export/1`: proiezione completa, trajectory, lineage e `forkParent`. Un reader fresco può rigiocarlo e ottenere la stessa traiettoria semantica.

### Fork (API core)

Il fork è un'API programmatica di `@zelari/core/session` (`forkSession(store, id, { fromSeq })`): copia la traiettoria fino a `fromSeq` in un nuovo sessionId e registra l'evento `session.forked` con la lineage. Non è un flag CLI; l'export lo espone come `forkParent`.

### Legacy mirror (transitorio)

Il sidecar BrainEvent 1.x e lo store in-process restano **solo** come superficie di export/UI di compatibilità (ADR-0024, "COMPAT MIRROR"). Non sono source of truth: la loro rimozione è pianificata per una 2.x successiva, dopo la migrazione di Desktop.

---

## Verifica deterministica, Strict Done e Verifier LLM (2.0)

Il contratto di completamento 2.0 (ADR-0023/0025): **deterministico batte narrativo**.

### VerificationEngine ed evidence event-backed

Un criterion produce un check deterministico (exit code, digest sha256 dell'output, osservazioni fs). Ogni osservazione emette un evento `verification.evidence` nella spine e l'`EvidenceRef` ne registra il `seq`: l'evidence è **ancorata all'evento reale**, non alla frase di un agente.

Tier deterministiche (event-backed): `tool-output`, `command-output`, `fs-observation`. La narrazione (`claimed`) da sola non passa mai un gate.

### Criteria pack v1

Con `ZELARI_VERIFY_PACK=1` il criteria pack v1 esegue per davvero i check di progetto — typecheck, test, build — usando gli script npm reali del repo, e fonde i risultati nello stesso gate. Dalla 2.1 il pack è un gate **indipendente**: non richiede `--strict-done` né la Kraken Selection — basta il flag, anche su un turno kraken "semplice":

```bash
zelari-code --headless --task "ship F3" --strict-done   # kraken, opt-in
ZELARI_VERIFY_PACK=1 zelari-code --headless --task "ship"   # pack standalone: strict implicito
```

### CompletionPolicy e Strict Done

`PASS | REPAIR_REQUIRED | BLOCKED` — `unknown ≠ pass`: un criterion required senza evidenza è **BLOCKED**, non successo.

| Superficie | Default | Flag |
|---|---|---|
| Kraken (TUI + headless) | **off** (opt-in, ADR-0026) | `--strict-done` / `ZELARI_STRICT_DONE=1` |
| Mission `zelari` | **ON** (ADR-0025) | opt-out: `--no-strict-done` / `ZELARI_MISSION_STRICT=0` |

Quando lo strict è attivo, un `pass` conta solo se l'evidenza è **event-backed** (`EvidenceRef.seq` ancorato a un evento `verification.evidence` sulla spine). Una nota del verify tentacle senza emitter di sessione è **BLOCKED** (ADR-0026).

Gate bloccato ⇒ exit code **`4`** e stato sessione stopped, con l'evento `verification.run` che contiene criteria, status e blocker.

### Verifier LLM (advisory)

Il verifier LLM è **opt-in e advisory**: aggiunge informazione, mai autorità.

- **Lock garantito da test:** un criterion deterministico UNKNOWN/FAIL con verifier CONFIRMED resta **BLOCKED**; un PASS deterministico con verifier REJECTED resta **PASS** (la review è visibile come rischio, non riscrive il verdetto)
- **Modello:** "Same as current model" (inherit) o provider+model dedicato — si configura in **Desktop → Settings → Kraken** (persistito; il modello effettivo è registrato nell'evento `verification.run` come `effectiveModel`)
- **Stato (2.1):** la selezione persistita è risolta dal runtime e il contratto è locked; l'invocazione advisory è ora attiva nel lifecycle headless kraken — opt-in: modello dedicato configurato (Desktop → Settings → Kraken) oppure `ZELARI_VERIFIER_REVIEW=1`; il risultato entra nell'evento `verification.run` (`verifier.advisory`) e mai nel verdetto

### Mission progress (advisory) e Best-of-N (sperimentale)

- Ogni slice di missione emette `mission.progress` con una raccomandazione (`continue` / `wind-down` / `hold-for-user`): il loop **non la esegue** — mai early-stop con criterion required incompleti, mai done da score, mai rewrite del goal
- Best-of-N è una superficie sperimentale (switch in Desktop): non fa parte del contratto di completamento

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

### Capability avanzate (opt-in, no-op se la dipendenza manca)

| Tool | Permesso | Prereq | Esempio |
|---|---|---|---|
| `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_symbols` / `lsp_rename` | read / write (`lsp_rename`) | language server sul PATH | `usa lsp_references su src/cli/app.tsx:42` |
| `ast_outline` / `ast_find_symbol` | read | nessuno | `ast_outline su packages/core/src/agents/` |
| `semantic_search` | read | indice (`/index`) | `semantic_search "retry del provider"` |
| `browser_check` | sandboxed network | Playwright + chromium | `browser_check su http://localhost:3000` |
| `ssh_status` / `ssh_run` | network (SSH) | target in Settings / `~/.zelari-code` | allowlist su `ssh_run` |
| `task` | read (sub-agent) | — | ricerca isolata read-only |

### Schema loop (world model leggero)

Ispirato a [Schema harness](https://schema-harness.github.io/): ipotesi esplicita + check certificabili + `run_backtest` prima di dichiarare done.

| Tool | Ruolo |
|---|---|
| `update_world_hypothesis` | Scrive `.zelari/world/hypothesis.md` |
| `set_world_checks` | Definisce `.zelari/world/checks.json` |
| `run_backtest` | Esegue i check e report pass/fail |
| `record_world_observation` | Append su `.zelari/world/timeline.jsonl` |

Skill: `/skill schema-loop`. Kill switch tool: `ZELARI_SCHEMA_LOOP=0`.

### Hook harness

- **Diagnostics loop** — dopo edit, `eslint`/`ruff` nel result tool. `ZELARI_DIAGNOSTICS=0`.
- **Parallel batch** — letture contigue in parallelo; write/bash come barrier. `ZELARI_PARALLEL_TOOLS=0`.
- **Prompt-cache accounting** — hit-rate in status bar quando il provider la espone.

Mappa completa: [TOOLS.md](./TOOLS.md).

---

## Capability avanzate e novità 1.26–1.34

Le capability “frontier” (LSP, AST, semantic, browser, diagnostics, `task`) restano. Dalla **1.26** alla **1.34** si sono aggiunti soprattutto:

| Area | Cosa | Da |
|------|------|----|
| **Kraken** | Super-agent default, tentacoli `task`, worktree + auto-merge, radio, **Kraken Graph** DAG | 1.26–1.28 |
| **Desktop Workbench** | Tab Plan / Tasks legati a `--plan-only` / `--run-plan` | 1.33 |
| **Sicurezza** | Folder trust (`/trust`), lifecycle hooks fail-open, `--inspect` | 1.32 |
| **Vision** | `@image.jpg` e drop Desktop → `image_url` nativo (stesso provider) | 1.31 |
| **MCP presets** | `composio`, `qwen-mm-plugins`, `cua`; slash `/integrations` | 1.31 |
| **Local CLI** | `ZELARI_LOCAL_CLI=claude` + permission broker MCP | 1.31 |
| **OAuth** | `/login chatgpt`, `/login anthropic` + Desktop Sign in/Refresh/Sign out | 1.34 |
| **Windows PATH** | Auto-repair prefix npm (`--fix-path`, postinstall) | ADR-011 |

Changelog ufficiale: [CHANGELOG.md](../CHANGELOG.md).

### Esempi d'uso

```text
# LSP
"usa lsp_references su packages/core/src/core/AgentHarness.ts"

# Semantic
"/index
 semantic_search 'dove gestiamo il retry del provider'"

# Phase
"/plan outline the auth refactor
 /build implement the plan on disk"

# Mode
"/mode zelari
 progettami un'app todo full-stack"
```

### Disabilitazione

```bash
ZELARI_LSP=0 ZELARI_AST=0 ZELARI_SEMANTIC=0 ZELARI_BROWSER=0
ZELARI_DIAGNOSTICS=0 ZELARI_SSH=0 ZELARI_PARALLEL_TOOLS=0
```

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
| `CHATGPT_API_KEY` | Key ChatGPT (alternativa a OAuth) |
| `ANTHROPIC_API_KEY` | Key Anthropic (alternativa a OAuth) |
| `DEEPSEEK_API_KEY` | Key DeepSeek |
| `GLM_API_KEY` | Key GLM/Z.AI |
| `MINIMAX_API_KEY` | Key MiniMax |
| `ZELARI_LOCAL_CLI` | Provider via CLI esterna (`claude`) |
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
| `ZELARI_MCP_USER=0` | Non legge `~/.zelari-code/mcp.json` (solo project `.zelari/mcp.json`; utile in test) |
| `ZELARI_CUA=0` | Disabilita MCP Cua Driver (desktop computer-use) |
| `ZELARI_CUA_COUNCIL=1` | Espone tool Cua anche in council (default off, anti-saturazione) |
| `ZELARI_SCHEMA_LOOP=0` | Disabilita tool world model (`run_backtest`, hypothesis, checks) |
| `ZELARI_SSH=0` | Disabilita tool e target SSH |
| `ZELARI_CLI_PATH` | Desktop: path a `bin/zelari-code.js` locale |
| `ZELARI_NO_PATH_REPAIR=1` | Windows: non riparare il PATH npm |
| `ZELARI_MAX_TOOL_CALLS` | Limite tool call per turno |
| `ZELARI_TOOL_OUTPUT_LINES` | Righe output tool in TUI (default 8) |
| `ZELARI_SHELL` | Path esplicito bash (Windows) |
| `ZELARI_PROVIDER_TIMEOUT_MS` | Timeout hard sulla fetch provider (default 5 min) |
| `ZELARI_PARALLEL_TOOLS=0` | Disabilita parallelismo tool read-only |
| `ZELARI_MAX_PARALLEL_TOOLS` | Max tool paralleli per segmento (default 6) |
| `ZELARI_MAX_TOOL_LOOP_ITERATIONS` | Budget soft tool-loop per run |
| `ZELARI_MAX_TOOL_LOOP_HARD` | Ceiling hard tool-loop |

`ZELARI_MAX_TOOL_CALLS` governa l’esecuzione del turno corrente: riparte da zero a ogni nuovo messaggio utente. Il ledger della sessione conserva comunque il totale cumulativo per resume, telemetria ed eval; un resume senza nuovo turno ripristina invece il consumo dell’esecuzione interrotta.

### Capability avanzate / harness

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
| `ZELARI_STATE` | `1` | `0` disabilita durable state (`.zelari/state/`) |
| `ZELARI_CTX_DURABLE_CHARS` | `3000` | max chars durable state nel volatile prompt |

### Session spine e verifica 2.0

| Variabile | Default | Effetto |
|---|---|---|
| `ZELARI_STRICT_DONE` | `0` | `1` = evidence gate strict su kraken/TUI/headless (ADR-0025) |
| `ZELARI_MISSION_STRICT` | `1` | `0` = opt-out del gate strict mission (default ON) |
| `ZELARI_VERIFY_PACK` | `0` | `1` = criteria pack v1 nativo (typecheck/test/build reali) — gate indipendente: non richiede strict-done né Kraken Selection |
| `ZELARI_VERIFIER_REVIEW` | `0` | `1` = verifier LLM advisory dopo il gate (headless kraken); `0` forza off anche con modello dedicato |
| `ZELARI_SESSIONS_DIR` | `<workspace>/.zelari/sessions` | Override della directory della session spine (test/CI) |
| `ZELARI_EVAL_RESULTS_DIR` | `eval/results` | Override della directory del result store eval — gate di regressione (test/CI) |

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

Vedi anche [CONTRIBUTING.md](../CONTRIBUTING.md).

```bash
npm install
npm run build:cli     # tsc + esbuild bundle
npm test              # suite Vitest (centinaia di file in tests/unit)
npm run typecheck
npm run smoke         # verifica bin
```

### Struttura monorepo

```
zelari-code/
├── packages/core/            # @zelari/core — AgentHarness, council, 26 skills, tools
├── src/cli/                  # TUI Ink, provider, workspace, wizard, serve
├── apps/desktop/             # Zelari Desktop (Tauri 2)
├── apps/companion-android/   # thin client per `zelari-code serve`
├── tests/unit/               # test Vitest
└── docs/                     # questa documentazione
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



## Kraken (super-agent) — tentacoli e env

Il mode default **kraken** (ex `agent`) è un lead che spawna sub-agent via tool `task`.

| Env / comando | Effetto |
|---------------|---------|
| `ZELARI_KRAKEN_MAX_TASK_SPAWNS` | Cap spawn `task` per turno parent (default 6); reset a ogni messaggio utente |
| `ZELARI_KRAKEN_SUB_MODEL` | Modello economico per tentacoli explore/verify |
| `ZELARI_KRAKEN_EXPLORE_MODEL` / `ZELARI_KRAKEN_VERIFY_MODEL` / `ZELARI_KRAKEN_GENERAL_MODEL` | Override per tipo |
| `ZELARI_KRAKEN_GENERAL_USES_SUB=1` | Fa usare SUB_MODEL anche a general |
| `ZELARI_KRAKEN_WORKTREE=1` | Isola `task` general in git worktree sotto `.zelari/worktrees/` |
| `ZELARI_KRAKEN_WORKTREE_KEEP=1` | Non cancella worktree/branch a fine tentacolo (merge manuale) |
| `ZELARI_KRAKEN_WORKTREE_AUTO_MERGE=0` | Disattiva lo squash-merge del worktree nel parent a fine tentacolo (default on) |
| `/kraken [sessionId]` | Mostra radio tentacoli (`.zelari/radio/<session>.jsonl`) |

Dopo un `task` general il risultato include un **verify-hint**: il parent deve verificare (`bash` o `task` verify) prima di dichiarare done.

### Kraken Graph — DAG di tentacoli paralleli

`/kraken graph <goal>` (o `--kraken-graph <goal>` in headless) fa pianificare a un LLM un DAG di
task e lo esegue in parallelo dove gli scope sono disgiunti.

| Env | Effetto |
|-----|---------|
| `ZELARI_KRAKEN_GRAPH=0` | Kill-switch: disabilita del tutto il graph engine |
| `ZELARI_KRAKEN_MAX_PARALLEL` | Tentacoli concorrenti massimi |
| `ZELARI_KRAKEN_FIX_BUDGET` | Numero di nodi `fix` ammessi prima del fallimento terminale |
| `ZELARI_KRAKEN_NODE_TIMEOUT_MS` | Wall-clock per nodo, **tutti i tipi** (`0` = nessun limite). Se non impostata il budget dipende dal tipo: 300000 per `explore`/`verify`, 900000 per `general`/`fix` |
| `ZELARI_KRAKEN_WRITER_NODE_TIMEOUT_MS` | Wall-clock dei soli nodi che scrivono (`general`/`fix`), default 900000 |
| `ZELARI_KRAKEN_CANCEL_GRACE_MS` | Attesa perché un tentacolo cancellato si smonti prima di dichiararlo inarrestabile (default 30000). Un nodo che non si ferma **non** viene ri-eseguito: due tentacoli sullo stesso scope corrompono il lavoro |
| `ZELARI_KRAKEN_PLANNER_MODEL` | Modello usato **solo** per il planning. Il planning è una singola completion strutturata senza tool use: puntarlo a un modello veloce non-reasoning evita i timeout tipici dei reasoning model |
| `ZELARI_KRAKEN_PLANNER_TIMEOUT_MS` | Wall-clock della richiesta di planning (default 300000; `0` = nessun limite) |
| `ZELARI_KRAKEN_PLANNER_MAX_TOKENS` | Budget token della risposta del planner (default 8192) |

Se il planner va in timeout l'errore lo dice esplicitamente e **non** ritenta (il modello non ha
risposto: ripetere raddoppierebbe solo l'attesa). Alza `ZELARI_KRAKEN_PLANNER_TIMEOUT_MS` oppure
imposta `ZELARI_KRAKEN_PLANNER_MODEL`.

**Ripresa fra run.** A fine esecuzione lo stato terminale del grafo viene salvato in
`.zelari/kraken/last-graph.json`. Se il run precedente non è arrivato in fondo, la pianificazione
successiva riceve un riepilogo di cosa è già fatto, cosa è fallito e cosa non è mai partito — così
un "continua" pianifica il lavoro **rimanente** invece di ricominciare da zero. Un piano che non
contiene alcun nodo `general` viene rifiutato: sarebbe di sola lettura e convergerebbe senza aver
modificato nulla.


## Link utili

- [Pagina prodotto](https://anathema-studio.com/zelari-code) (IT: [zelari-codice](https://anathema-studio.com/zelari-codice))
- [Documentazione sul sito](https://anathema-studio.com/zelari-code/docs) (IT: [documentazione](https://anathema-studio.com/zelari-codice/documentazione))
- [Anathema Studio](https://anathema-studio.com/) — home
- [Repository GitHub](https://github.com/N-THEM-Studio/zelari-code) · [Releases](https://github.com/N-THEM-Studio/zelari-code/releases)
- [npm: zelari-code](https://www.npmjs.com/package/zelari-code) · [npm: @zelari/core](https://www.npmjs.com/package/@zelari/core)
- [CONTRIBUTING](../CONTRIBUTING.md) · [SECURITY](../SECURITY.md) · [LICENSE (Apache-2.0)](../LICENSE)
