# Diagnosi: lag input, peso e desync modelli (Desktop + TUI)

> Data: 2026-09-15 · Fase: PLAN (verificato solo in lettura, nessuna modifica sorgente)
> Complementare a `2026-09-10-kraken-lead-performance-plan-v2.md` (che copre la latenza di ESECUZIONE kraken: routing, gate, executor, spine). Qui si copre il livello UI (Desktop + TUI) e il desync modelli, non trattati altrove.
> Metodo: 4 ricognizioni read-only con evidenze file:line.

---

## 1. Desync modelli — chat vs Impostazioni → Agenti (DESKTOP)

**Sintomo**: il modello scelto in chat non comunica con quello mostrato/nella vista Agenti delle impostazioni.

**Causa radice: tre sorgenti di stato indipendenti + una lettura "sticky".**

| Superficie | Stato | Storage |
|---|---|---|
| Barra modello in chat | React `model` (`apps/desktop/src/App.tsx:660`) + `Conversation.model` per conversazione | localStorage chat |
| Riempimento iniziale | `refreshConfig` (`App.tsx:1197–1208`) — **sticky**: `setModel(prev => prev || …)` → dopo il primo load non si aggiorna MAI più dal config CLI | — |
| Switch sessione | `onSelectSession` (`App.tsx:2478–2483`) — setta `model` da `c.model` **senza persistere** nel config CLI | — |
| Vista Agenti → Lead | **read-only**, mostra `config.modelByProvider[active]` (`AgentsSection.tsx:106–108`) | `provider.json` (CLI) |
| Vista Agenti → tentacoli (Explore/General/Verify/Planner) | `onPrefsChange({kraken*Model})` (`AgentsSection.tsx:111–149`) | `zelari-desktop-prefs` localStorage — **Kraken-only, ignora la chat** |
| Verifier | override separato | `provider.json` |

Effetto: cambi modello in chat → la vista Agenti continua a mostrare `modelByProvider`; cambi in Agenti → la chat non se ne accorge (i tentacoli non toccano mai la chat per design, ma nulla lo comunica); cambi conversazione → la barra cambia ma il config CLI no, e `refreshConfig` sticky non riallinea mai.

**Fix proposto (minimo e onesto)**:
1. Regola di prodotto: Lead+barra chat = UNA sola sorgente (o sempre `modelByProvider`, o persist `setAppConfig` su switch sessione).
2. Rimuovere lo sticky `prev ||` in `refreshConfig` (o applicare sempre `c.modelByProvider` salvo override esplicito per-conversazione).
3. Etichettare i selettori tentacoli come "solo Kraken" o aggiungere opzione "eredita dalla chat".
4. Su `onSelectSession`: persistere su CLI o marcare visivamente "modello di questa conversazione ≠ default".

---

## 2. Lag digitazione in chat (DESKTOP) — causa dominante

**Ogni tasto ri-renderizza l'intero albero App.**

- `App.tsx` = **un solo componente da ~4276 righe con 50+ `useState`** (`App.tsx:532`).
- Il draft del composer è stato controllato al top: `draft` (`App.tsx:549`) → `onDraftChange` fa `setDraft` **e** `setMention` (`App.tsx:2778–2788`) → doppio update per tasto.
- La textarea è `value={draft}` (`App.tsx:4048–4054`).
- Il transcript vive NELLO STESSO componente: `messages.filter().map()` → `<MessageContent>` (`App.tsx:3647–3693`).
- **Zero `React.memo`** in tutto `apps/desktop/src/**/*.tsx`. `MessageContent` (`MessageContent.tsx:297`) ri-parsa markdown + regex inline (`:26–43`) per OGNI messaggio visibile a OGNI tasto. Costo proporzionale alla lunghezza conversazione, non al tasto.
- Sidebar e pannelli estratti ma non memoizzati → ri-renderizzati come figli di App.
- Eventi sidecar in streaming (`agentClient.ts`: `permission_respond` ~104, `harness-sidecar-status` ~700, `harness-sidecar-log` ~720, `run-finished` ~776) mutano `conversations` in App → full re-render ANCHE mentre si digita.
- Polling sempre attivi: git 5s (`ProjectPanel.tsx:142`), companion 4s (`CompanionServeSection.tsx:45`), graph tail 1.5s (`KrakenGraphVisualizer.tsx:76`), workbench tail 1.5s (`WorkbenchLiveTail.tsx:61`), plan 2s (`PlanReviewPanel.tsx:58`), kraken activity 1s durante run (`KrakenActivity.tsx:143`).

**Regressione recente plausibile** (git log): `7c3e615` (inline markdown nei reply, per-render), `d91f5db`/`570a966` (parallel chat isolation, più stato per-conv in App), `1780ce9` (MCP manager), `19e591d` (tentacle thinking), `b341baf`/`e5be61f` (composer popover / runs dashboard). Nessuno ha isolato l'input: hanno fatto crescere il componente che già ri-renderizzava per tasto.

**Nota dev vs prod**: `desktop:dev` (vite + React Refresh, non minificato) è atteso MOLTO più lento di `tauri:build`; ma il path per-tasto full-App resta anche in prod.

---

## 3. Lag digitazione TUI (CLI)

Stesso pattern architetturale in ink:

- Input controllato su App: `setInput` (`src/cli/app.tsx:104`), passato (`:351–355`); ogni tasto → reconcile di `<Static>` + `<LiveRegion>` + `<InputBar>` + `<StatusBar>` + `<Sidebar>`.
- `InputBar` è `React.memo` ma protegge solo da update esterni, non dal costo del parent (`InputBar.tsx:41–58`).
- `StatusBar` NON memoizzata: a ogni render richiama `formatTodoStatusSummary`, `formatKrakenLiveSummary`, `formatKrakenGraphSummary`, `getVerifyChip`, `permissionsChip`, **`jailStatusChip()` con `probeJailBackend()`** (`app.tsx:33–44, 358–385`).
- `<Static items={[banner, ...session.messages]}>`: nuovo array + render-prop a ogni tasto (`app.tsx:310–331`); con transcript lunghi = CPU extra sullo stesso tick dell'echo.
- Non è colpa di spine/JSONL/sqlite: il replay avviene solo al mount (`useSession.ts:93+`).
- Contenzione durante i turni: spinner 100ms (`Spinner.tsx:23`), timer 1s (`useExecutionTimer.ts:27`), stream batch ≤60Hz.

---

## 4. Peso generale (startup + idle)

1. **Bundle unico gigante**: `main.ts` importa staticamente Ink/React, app, PluginGate, metrics, providerConfig, wizard, headless, desktopConfig, OAuth, plugins, skills, updater, MCP, SSH, harness… tutto in `dist/cli/main.bundled.js` anche per `--version` (`src/cli/main.ts`; `scripts/bundle-cli.mjs` bundle:true).
2. **Doppia scrittura sessione**: ogni evento chat → JSONL + spine (`app.tsx:57–60`).
3. **Git poll 4s sempre attivo** in TUI (`src/cli/hooks/useGitChanges.ts:148–177`).
4. Update check a 3s dal mount + model discovery in background se cache stale (`main.ts`; `app.tsx:174`).
5. `useChatTurn.ts` ~2812 righe / ~123KB caricato con App.
6. Duplicazioni: `providerConfig.ts` + `userSettings.js` + `desktopConfig.ts`; dist `main.js` + `main.bundled.js`; JSONL+spine mirror; memory nativa vs `--memory-mcp` vs `--memory-json`.
7. Gardener/evolution/sqlite NON sono attivi a idle (già verificato): il "peso percepito" è bundle+poll+doppia scrittura, non i sottomodelli.

---

## 5. Piano d'intervento (proposta, fase BUILD)

### Slice 1 — Desktop: isolare il composer (P0, impatto massimo)
- Estrarre `ChatComposer` con stato `draft` INTERNO; lift su submit (o debounce 150ms se serve la mention popup).
- `setMention` solo se la query `@` cambia davvero (`App.tsx:2778`).
- Tocchi: `App.tsx:549, 2778–2788, 4048–4054`.
- ACCETTAZIONE: digitare con transcript 500+ messaggi → la catena di render dal tasto tocca SOLO il composer (verificabile con profiler/count di render).

### Slice 2 — Desktop: memoizzare il transcript (P0)
- `React.memo(MessageContent)` (+ hash contenuto se serve) (`MessageContent.tsx:297`); `React.memo(Sidebar)`; estrarre `ChatTranscript` da `App.tsx:3647+` con `useMemo` su lista messaggi.
- ACCETTAZIONE: con stream attivo, il parse markdown non gira sul path del tasto.

### Slice 3 — Desktop: batch eventi sidecar + polling on-demand (P1)
- Throttle/batch `harness-sidecar-log` e aggiornamenti stream (rAF o 50ms) (`App.tsx:724–727`, `agentClient.ts:700–776`).
- Pausa polling quando il pannello non è visibile (graph 1.5s, plan 2s, activity 1s, git 5s → solo tab attiva).
- ACCETTAZIONE: durante un run kraken, digitare resta fluido.

### Slice 4 — Desktop: sync modelli (P0 per la correttezza percepita)
- Come §1: singola sorgente Lead/chat, fix sticky `refreshConfig`, persist o label su switch sessione, label "solo Kraken" sui tentacoli.
- ACCETTAZIONE: cambio modello in chat → Agenti allineato (e viceversa per il Lead); switch sessione coerente.

### Slice 5 — TUI: input locale + StatusBar memo (P1)
- Stato input locale in `InputBar` (lift su submit) OPPURE isolare shell/composer; `React.memo(StatusBar)` con chip precomputate fuori dal path per-tasto (mai `probeJailBackend()` nel render); `Static items` memoizzato (`app.tsx:310–331, 358–385`; `InputBar.tsx`).
- ACCETTAZIONE: echo del tasto non dipende dalla lunghezza transcript.

### Slice 6 — Peso (P2, coordinato col piano v2)
- Dynamic `import("./app.js")` per i path solo-flag (`--version`, `--print-config`, OAuth, memory) in `main.ts`.
- Git poll solo con sidebar/chip visibile o 15–30s / `fs.watch(".git/HEAD")`.
- Defer model discovery + PluginGate al primo turno/`/model`.
- (Doppia scrittura JSONL+spine: già trattata come Int4 nel piano v2 — non doppiare.)

### NOTA operativa immediata (zero codice)
- Se si usa `desktop:dev` in sviluppo: la prod build (`npm run desktop:build`) è attesa molto più reattiva (React non minificato + HMR pesano); ma Slice 1–2 restano necessari in prod.

---

## 6. Registro evidenze principali
- `apps/desktop/src/App.tsx:532,549,660,724–727,1197–1208,1313–1324,2778–2788,3647–3693,4048–4054`
- `apps/desktop/src/components/settings/AgentsSection.tsx:61–149`
- `apps/desktop/src/components/MessageContent.tsx:26–43,297`
- `apps/desktop/src/agentClient.ts:104,700,720,776`
- `src/cli/app.tsx:33–44,104,310–331,351–355,358–385`
- `src/cli/components/InputBar.tsx:41–58`; `src/cli/components/Spinner.tsx:23`
- `src/cli/hooks/useGitChanges.ts:148–177`; `src/cli/hooks/useSession.ts:93+`
- `src/cli/main.ts` (import statici); `scripts/bundle-cli.mjs`
- Commit sospetti: `7c3e615`, `d91f5db`, `570a966`, `1780ce9`, `19e591d`, `b341baf`, `e5be61f`
