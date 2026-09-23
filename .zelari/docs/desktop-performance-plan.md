# Piano Prestazioni Desktop (2026-09)

Stato: **IN ESECUZIONE** — Fase 1 completata su disco (2026-09-12): W1.1+W1.5 (40 comandi async + `cli_cache.rs`, TTL 60s, invalidazione su `update_cli`), W1.2 (debounce 500ms/maxWait 2500ms con flush su run-finished/switch/unload), W1.3 (idratazione post-paint), W1.4 (update check dopo idle). Verifica: `cargo check` 0, `tsc --noEmit` (apps/desktop) 0, `vitest desktop-chatStorage` 14/14. Fasi 2–4 ancora proposte.

## Diagnosi — tre famiglie di lentezza (evidenza certa nel codice)

### A. Freeze UI su main thread — impatto ALTO (avvio + fine run)
- 43/43 comandi Tauri sono **sincroni**; ~20 spawnano processi node bloccanti via `run_cli_capture` (`apps/desktop/src-tauri/src/lib.rs:1067-1096`). In Tauri 2 i comandi sync girano sul main thread → UI congelata per la durata dello spawn.
- Al mount: treno di spawn one-shot `--version` + `--doctor --json` + `--print-config` (+ `--plugins-status` se workdir) (`apps/desktop/src/App.tsx:1216-1218`, `1171-1174`, `2422-2424`).
- A ogni run-finished: `refreshCli()` ri-spawna `--version` (`App.tsx:2385-2388`).
- Update check a +2,5s: fetch GitHub + spawn `node -e fetch(npm)` (`App.tsx:1245-1266`, `lib.rs:708-790`).
- `loadConversations()` sincrono nell'initializer di `useState` prima del primo render (`App.tsx:541-542`, `chatStorage.ts:74-78`).
- Nessuna cache della risoluzione CLI: `resolve_cli_entry_raw` rifà canonicalize/walk-up a ogni comando (`lib.rs:533-603`).

### B. Ciclo di chat O(N²) durante lo streaming — impatto ALTO
- Ogni `message_delta` (ogni token): rimappatura conversazioni + `[...messages].reverse().find(...)` + `scrubDisplayText` rieseguito su **tutto** il contenuto accumulato (`App.tsx:1964-2020`) → O(N²) sulla lunghezza della risposta.
- Ogni cambio `conversations` → `saveConversations`: sort ~80 conversazioni, slice 200 msg/conv, `JSON.stringify` dell'intero store + `localStorage.setItem` **sincroni** per ogni token (`App.tsx:835-847`, `chatStorage.ts:91-116`).
- Stick-to-bottom + ResizeObserver a frequenza token → layout thrash (`App.tsx:1313-1343`).
- Nessun coalescing dei delta lato Rust: ogni evento = 1 emit IPC × N webview × 2-3 listener (`harness_sidecar.rs` dispatch, `App.tsx:1464+`, `activity/useRunActivity.ts:80`).

### C. Reattività generale (typing, scroll) — impatto MEDIO
- `App.tsx` monolite (~4.276 righe, ~40 useState): ogni keystroke nel draft re-renderizza tutto; `MessageContent` non memoizzato e riceve callback inline nuove a ogni render (`App.tsx:3647-3735`, `3686-3703`).
- Nessuna virtualizzazione delle liste (0 match react-window/virtualized su 154 file frontend).
- Ogni riga stderr del sidecar = setState globale anche a pannello chiuso (`App.tsx:733-745`).

### D. Residui Rust — impatto MEDIO/BASSO
- `watch_plan_changes`: un thread per workspace con poll `fs::metadata` ogni 1,2s **infinito**, mai rimosso dal registry (`lib.rs:1908-1952`) → leak di thread.
- `store_and_emit_harness_state`: 3 deep-clone + 2 lock + emit per ogni evento (`harness_sidecar.rs:425-460`).

### Prima del primo messaggio
- Sidecar lazy: spawn node `--serve-harness` + boot + handshake (cap 20s) pagati **dentro il primo turno** (`harness_sidecar.rs:966→498→521`, `161`, `668`).

## Già pulito (non toccare)
- Sidecar chat longevo multiplexato per id: nessuno spawn-per-request nel ciclo chat (`harness_sidecar.rs:569`, dispatch `1173+`).
- Mutex short-scope; MemoryExplorer non per keystroke; bundle frontend essenziale, nessun sourcemap in build.

## Già fatto / deferito altrove (NON riduplicare)
- Piano perf CLI v2 → implementato in 2.38.0; flip di default (`ZELARI_SPINE_REPLAY_CACHE`, `ZELARI_REQUEST_SNAPSHOT=lite`, `WORKTREE=auto`, `ZELARI_HEADLESS_FAILOVER`) **deferred su dati dogfood** (v2 §11). Resta aperto il wiring env lato Desktop (backlog v2 §15 item 6).
- Sidecar chat isolation Fix A–E → 2.44.0 (t59–t62 completed).
- Bundling CLI come sidecar Tauri (`externalBin`) → ADR-0034 deferito deliberatamente, richiede ADR ad hoc.

## Piano per fasi (da eseguire in BUILD)

### Fase 1 — Freeze UI (quick win)
| ID | Azione | File | Sforzo |
|----|--------|------|--------|
| W1.1 | Comandi Tauri con I/O/spawn → `async fn` (+ `spawn_blocking` dove serve); cache versione/config CLI con TTL | `src-tauri/src/lib.rs` (~20 comandi) | M meccanico |
| W1.2 | Debounce ~500ms del save conversazioni + flush su `run-finished`/switch conversazione/`beforeunload` | `App.tsx:835-847`, `chatStorage.ts` | S |
| W1.3 | `loadConversations` fuori dal primo render (differito dopo il paint) | `App.tsx:541-542` | S |
| W1.4 | Update check async + dopo idle, senza spawn node sincroni | `App.tsx:1245-1266`, `lib.rs:708-790` | S |
| W1.5 | Memoizzazione della risoluzione CLI (`resolve_cli_entry_raw`) | `lib.rs:533-603` | S |

Accettazione Fase 1: al mount e a fine run la UI resta interattiva; nessun comando sync che spawni processi nel hot path.

### Fase 2 — Ciclo di chat — ✅ IMPLEMENTATA 2026-09-12
> Esiti: `delta_coalescer.rs` nuovo (218 LOC, flush 40ms, 4 trigger d'ordine, 10 test); `harness_sidecar.rs` +216/−1 via `send_to_run` choke-point; `App.tsx` +360/−152 (ref `streamRaw`, scrub throttled 250ms + finale, `applyStreamContent` tocca solo l'ultimo messaggio, commit rAF). Gate: cargo check 0, tsc 0, vitest desktop 266/266.

| ID | Azione | File | Sforzo |
|----|--------|------|--------|
| W2.1 | Testo raw del turno accumulato in ref; scrub solo a fine turno (o throttled) | `App.tsx:1964-2020` | M |
| W2.2 | Aggiornare solo l'ultimo messaggio invece di rimappare l'intera lista | `App.tsx:1981` | M |
| W2.3 | Coalescing delta lato Rust: flush 30-50ms di `message_delta`/`thinking_delta` prima dell'emit | `harness_sidecar.rs` | M |
| W2.4 | rAF-throttle di `streamTick` + stick-to-bottom | `App.tsx:1313-1343` | S |

Accettazione Fase 2: typing fluido durante generazione con storico pieno; nessun `JSON.stringify` per token.

### Fase 3 — Reattività strutturale
| ID | Azione | File |
|----|--------|------|
| W3.1 | `React.memo` su `MessageContent` + callback stabili (`useCallback`) | `MessageContent.tsx`, `App.tsx:3686-3703` |
| W3.2 | Estrarre Composer e ChatList in componenti con stato locale | `App.tsx` (monolite) |
| W3.3 | Virtualizzazione lista messaggi — valutare windowing manuale (convenzione "zero new heavy deps") | `App.tsx:3647-3735` |
| W3.4 | Pannello log sidecar isolato (stato locale al pannello aperto) | `App.tsx:733-745` |

> Esiti (2026-09-12): `App.tsx` 4483→4023 righe (−460). Nuovi componenti: `Composer.tsx` (290 LOC, stato digitato locale + `useImperativeHandle`), `ComposerSendButtons.tsx`, `ComposerMediaButtons.tsx`, `composerIcons.tsx`, `ChatList.tsx` (memo, presentazionale), `SidecarLogPanel.tsx` (stato+subscription locali, ring 200 righe, App non riceve più re-render per riga stderr). `MessageContent` avvolto in `React.memo` + callback stabili `useCallback` nel sito d'uso (test memo aggiunto). Windowing W3.3: finestra coda-ancorata `WINDOW_SIZE=60`, bottone "carica precedenti" con preservazione scroll (misura-delta scrollTop via `useLayoutEffect` + `scrollRef`), reset al cambio `conversationId`, streaming in coda sempre renderizzato (6 test in `ChatList.windowing.test.tsx`). Gate: tsc 0, vitest desktop 273/273 (32 file), zero nuove dipendenze.

### Fase 4 — Residui Rust + primo turno
| ID | Azione | File | Sforzo |
|----|--------|------|--------|
| W4.1 | `watch_plan_changes`: rimozione dal registry alla chiusura workspace o stop dopo inattività | `lib.rs:1908-1952` | S/M |
| W4.2 | `harness_state`: `Arc<Value>` condiviso, emit solo se cambiato | `harness_sidecar.rs:425-460` | S |
| W4.3 | (opzionale) Prefetch del sidecar a finestra visibile/primo focus: sposta il costo spawn+handshake fuori dal primo messaggio | `harness_sidecar.rs:966` | S/M |

> Esiti (2026-09-12): W4.1 `lib.rs` +167 — `PlanWatchRegistry` (`HashMap<String, Arc<AtomicBool>>` con claim/release/stop e take-over di slot stale), funzione pura `should_stop_plan_watch`, loop con `break` su stop richiesto o idle ≥10min senza run attivi (`RunRegistry::has_active_run_for`), nuovo comando `stop_plan_watch` registrato; ri-osservazione automatica al prossimo claim (6 test compilati). W4.2 `harness_sidecar.rs` +113 — stato come `Arc<Value>` condiviso (mappa sessione + slot globale + payload riferiscono lo stesso Arc), confronto per valore una sola volta, emit solo se cambiato (0 clone nel caso invariato), `HarnessStatePayload` con `Serialize` per riferimento (shape evento identico, pinnato da test). W4.3 — comando `prefetch_harness_sidecar` (fire-and-forget `spawn_blocking(ensure_started)`, errori solo loggati) + effect FE in `App.tsx` (+31) su `requestIdleCallback` timeout 4s con guard anti-StrictMode; path lazy primo turno invariato. Gate: `cargo check` 0 warning, `cargo check --tests` 0, `tsc --noEmit` 0, vitest desktop 273/273 (32 file).

### Solo dev (percezione durante sviluppo)
- `desktop:dev` ricostruisce la CLI da zero a ogni run (`package.json` root): aggiungere script/variabile per saltare il build CLI durante l'iterazione UI.
- `React.StrictMode` raddoppia gli effetti di boot in dev (`main.tsx:8`): non un bug, ma raddoppia gli spawn in dev.

## Misurazione (prima/dopo, obbligatoria in BUILD)
- Avvio: tempo da lancio a UI interattiva (stopwatch; opzionale `performance.mark` in `main.tsx`).
- Primo turno: tempo invio → primo token visibile.
- Streaming: fluidità typing durante generazione con storico pieno (es. 80 conversazioni).
- Gate: `npm run typecheck`, `npm run test`, smoke manuale `npm run desktop:dev`.

## Rischi
- Migrazione async comandi: mantenere identico il contratto FE (nomi/payload invoke invariati) per non toccare 41 call-site.
- Debounce del save: rischio perdita degli ultimi token su crash → flush su `beforeunload` + `run-finished` obbligatorio.
- Coalescing lato Rust: non alterare l'ordine degli eventi semantici (riguardare Fix B/t60 del piano sidecar isolation).
- Virtualizzazione: stick-to-bottom va riscritto sul virtualizer.
