# Zelari 2.37 → avanti — piano serio e fedele (rev. 9 set 2026)

> **Baseline:** `zelari-code` / `@zelari/core` **2.37.0** (2026-09-08).  
> **Alpha chiusa.** C1–C8 committed (`docs/RC_CHECKLIST.md`, ADR-0024/0025/0026).  
> **Uso dichiarato:** orchestrare (non digitare), codice che *funziona*, invoice bassa.  
> **Non-obiettivo di questo foglio:** quinto CLI, Council nuovo, Desktop, 4B, Sentinel-da-Meta, “2.1 principi”.

Documento gemello: `ZELARI-2.0-EXIT-ALPHA.md` (storico, non da riscrivere).  
Legge: `PRINCIPLES.md` P1–P6. In caso di conflitto vince il principio, non la feature.  
Questo file **sostituisce** l’ordine del NEXT precedente: la morsa sul done viene prima del monumento alla spine.

---

## 1. Tesi

Siete fuori alpha. Due rischi, in quest’ordine:

1. **Done che mente** — `kind: 'none'`, pattern B, pack verify opt-in, success senza `verification.*` event-backed. Rompe P1 e brucia token sul falso “finito”.
2. **Due cervelli** — spine + store/sidecar + radio. Rompe P1 sul resume. È debito vero, non è il vincolo di questa settimana finché un resume non ti ha già mentito.

Fedeltà = evidence meccanica sul done, poi una sola verità per il modello, orchestrazione stretta, core leggero.

```text
2.0.0     spine = SoT sul path hot, fallback store ancora previsto
2.37.0    prodotto sopra la spine; dual-write fisico ancora lì
          pack verify ancora flag; pattern B ancora vivo
prossimo  morsa sul done · freeze superfici · pin exit 4
poi       fallback store se il resume ha morso · graph = due canali
mai ora   widget, ruoli, vision, 4B, nuovo provider
```

Il NEXT precedente metteva S1 (single-write) come cuore. Quello è il cuore *del custode del runtime*. Il cuore *di chi orchestra* è: comando vero, PASS/BLOCKED, un repair, stop.

---

## 2. Cosa non fare (freeze)

Per le prossime 2–4 settimane, **no** di default:

- nuova riga Desktop (widget, chrome, honesty meter)
- nuovo provider / transport / vision tool
- nuovi ruoli council
- BoN / PPT / logprob come default
- Cordis / plugin tree
- dump dei turni interni dei tentacoli sulla spine “per completezza”
- riscrittura di `PRINCIPLES.md`
- LoRA / 4B / next-edit “impara da Kraken”
- meta-harness Muse-like, Sentinel consumer, Secure VM
- version bump 2.38 come identità di marketing

Eccezione: bug P0 (break turn, evidenza falsa, version drift, fail-open su permessi, resume che nutre il modello dallo store in un caso reale).

Ogni PR fuori da questo piano: *quale criterio P1–P6 o quale residuo qui sotto chiude?* Se la risposta è “UX” o “parity con Codex/Muse”, slitta.

---

## 3. Residui (ripuliti)

| ID | Residuo | Fonte | Priorità ora |
|----|---------|--------|----------------|
| R0 | Pack verify opt-in; `kind: 'none'` + nota tentacolo come prova; pattern B re-emette note senza tool capture | `completionPolicy.ts`, `verificationBridge.ts`, ADR-0023/0025 | **P0 di prodotto personale** |
| R4b | Claim success senza `verification.*` event-backed | policy già scritta; va pinnata sullo slice-from-plan | **P0, un test** |
| R1 | Fallback store 1.x se spine degraded / `ZELARI_SESSION_SPINE=0` | ADR-0024 TODO | P1 *se* un resume ha divergito; altrimenti dopo R0 |
| R2 | Dual-write fisico (`cli-dual-write`, BrainEvent sidecar) | `sessionSpine.ts`, `headlessSpine.ts` | stesso di R1 |
| R3 | Graph: envelope sulla spine, inner solo radio | ADR-0024 v1.1 | docs, non codice |
| R4 | Mission e2e full assente | `RC_CHECKLIST.md` | solo se usi `plan.json` + `--resume-mission` |
| R5 | Strict Kraken: ADR dice opt-in, codice in posti già ON | ADR-0026 vs P0.1 | non alzare in silenzio; misurare. Non è il primo merge |
| R6 | Eval/usage onesti | 2.37 `RunTelemetryAccumulator` | non regressare |

Non sono residui da riaprire: vision, Responses API, context meter Desktop, council split.

---

## 4. Fasi (ordine nuovo, non negoziabile)

```text
S0   Freeze + niente surface                    giorni          ← pre-condizione
M1   Morsa: pack nativo, no pattern B, exit 4   3–7 giorni      ← cuore
M2   Pin mission-done + tetto repair/token      2–4 giorni
S1   Single-write store                         solo se morso / dopo M1
S2   Mission e2e smoke                          solo se usi mission
S3   Graph = canale A, una pagina GUIDA         mezze giornata
S4   Non mentire su eval                        continuo
S5   Niente altro in questo orizzonte
```

2.37.1 = M1 (+ M2 se entra).  
2.38 = eventuale S1, non un rebrand.

---

### Fase S0 — Freeze (invariata nel contenuto)

| ID | Task | Done when |
|----|------|-----------|
| S0.1 | Policy PR: label `done-gate` / `spine` / `mission` vs `surface`. Surface richiede exception scritta | CONTRIBUTING o HANDOFF corto |
| S0.2 | Nessun ADR obbligatorio prima di M1. ADR-0027 (store) slitta a S1, non blocca il pack | |

**Criterio S0:** niente merge Desktop/Council/vision.

**Stima:** oggi.

---

### Fase M1 — Morsa sul done (cuore, P1/P2)

Obiettivo: il runtime decide PASS / REPAIR_REQUIRED / BLOCKED su **comandi eseguiti da `VerificationEngine`**. L’LLM propone, non certifica.

| ID | Task | Done when |
|----|------|-----------|
| M1.1 | Pack nativo **default ON** se il tree ha un segnale (`package.json` scripts.test/build, `pytest.ini` / `pyproject`, `go.mod`, `Cargo.toml`). Opt-out esplicito, non `ZELARI_VERIFY_PACK=1` | un repo JS fresco senza flag → il comando parte |
| M1.2 | Niente criterio + pack off → stato `UNVERIFIED` (exit 4 o 5), non `open`/`success`. `--allow-unverified` per exit 0 | test |
| M1.3 | Uccidere pattern B: nota senza tool/command capture ≠ evidence. `requireEventBackedEvidence` senza `seq` vero → BLOCKED | test che prima era verde su B diventa rosso |
| M1.4 | `krakenResultsToContract` con `check.kind === 'none'`: il tentacolo può *proporre* comandi; il runtime li **ri-esegue**. La nota non è il fascicolo | |
| M1.5 | Matching criteri per **id** stabile, non containment a 8 caratteri sul testo | |
| M1.6 | Un solo repair automatico, poi exit 4. Nel repair entra solo il fail corto (cap 1–2k), mai il log intero | token del gate ≈ 0 sul path verde |
| M1.7 | Strict: se il default codice ≠ ADR-0026, una riga in ADR o changelog. Niente flip silenzioso extra | R5 |

**Exit M1:** `kraken` headless su fixture con test che fallisce → exit 4, sempre. Stesso comando dopo un edit PASS → exit 0. Zero token modello sul path di verify.

**Stima:** 3–7 giorni. Questa è l’unica fase che deve chiudere prima di ogni altra.

---

### Fase M2 — Pin e costo (P2, P6)

| ID | Task | Done when |
|----|------|-----------|
| M2.1 | Claim success mission/slice senza evento `verification.*` event-backed → exit 4. Lock test sullo slice-from-plan (era S2.3) | CI |
| M2.2 | Progress/early-stop resta **advisory** (`continuationPolicy`). Score LLM non chiude | già vero; non regressare |
| M2.3 | Tetto $ o token di sessione già esposto in 2.37: documentare “esausto → stop”, non un altro swarm | GUIDA corta |
| M2.4 | Telemetria: `tokens: null` = fail eval. Resta il 2.37 | |

**Exit M2:** un umano legge in GUIDA “quando Zelari dice fatto, cosa è stato corso”.

**Stima:** 2–4 giorni, può sovrapporsi a M1.6–M1.7.

---

### Fase S1 — Single-write (P1) — *condizionata*

Non è più il primo cuore. Si apre se **uno** di questi è vero:

- un `--resume` / TUI restart ha già dato al modello history diversa dallo spine;
- chiudi M1 e ti avanza tempo;
- qualcuno oltre a te dipende da `deriveMessages` in produzione.

Altrimenti: dual-write resta specchio dichiarato. Non è bello. Non è il false-done.

Se si apre, ADR-0027 *Removing the 1.x store from model-context fallback* **prima** del taglio grande.

| ID | Task | Done when |
|----|------|-----------|
| S1.0 | ADR-0027 Accepted: spine down → fail dichiarato *oppure* re-import read-only, mai seed store → modello | |
| S1.1 | Seed harness = solo `deriveMessages` → `derivedToAgentMessages` su kraken / council / zelari / TUI / graph host | grep store→messages = 0 sul hot path |
| S1.2 | Degraded spine: evento `session.degraded`, niente silent seed | test |
| S1.3 | `legacyContextIsolation.test.ts` rosso se riappare un seed store | `test:session` |
| S1.4 | Store 1.x resta per UI / export / migrate-in (P5: deprecare il ruolo, non bruciare i byte) | |

**Exit S1:** spegnere lo store non cambia i messaggi al modello (test).

**Stima:** 1–2 settimane *quando* si apre.

---

### Fase S2 — Mission e2e — *condizionata*

Solo se le giornate passano da `plan.json` + interrupt + `--resume-mission`. Altrimenti lo smoke è debito del repo, non del banco.

| ID | Task | Done when |
|----|------|-----------|
| S2.1 | Smoke **senza rete modello**: 3 task → slice ≤8 → gate → 2° slice; interrupt → resume dallo stesso `mission-state.json` | CI, 0 token |
| S2.2 | Docs: `--resume <sessionId>` (spine) ≠ `--resume-mission` | GUIDA |

M2.1 copre già il done. Non aspettare S2 per l’exit 4.

---

### Fase S3 — Graph onesto — *docs, opzione A*

ADR-0024 v1.1 resta: tentacoli **non** scrivono sulla spine.  
**Scelta di questo piano: A.** Due canali (envelope sessione + radio dettaglio). Replay = Session per l’host, file radio per il nodo.

Niente `radioRef` in questo orizzonte (era B). Niente inner turn sulla spine (C, vietato).

| ID | Task | Done when |
|----|------|-----------|
| S3.1 | Una pagina GUIDA: come ricostruire un graph run. Amendment ADR-0024 di due paragrafi: “A confermata fino a ADR futuro” | |
| S3.2 | Test esistenti restano rossi se un tentacolo scrive `assistant.message` / `tool.*` sulla spine | già lì |

**Stima:** mezze giornata. Non una settimana di schema.

---

### Fase S4 — Non mentire (continuo)

| ID | Task | Done when |
|----|------|-----------|
| S4.1 | `eval:gate` blocking; baseline da tag stabile | non regressare |
| S4.2 | Core zod-only runtime | `verify:principles` |
| S4.3 | Nessun return a chars÷4 | R6 |

---

### Fase S5 — Esplicitamente fuori

Non in questo orizzonte, anche se il NEXT vecchio li elencava come “dopo S1+S2”:

- Verifier BoN su `kraken_select`
- Worktree come nuovo default orchestratore
- Pointer graph (S3-B)
- Qualsiasi personaggio council, code-mode generativo, LLaV in core

Se dopo M1 il pack default ha un costo misurato inaccettabile su task banali: gate corto (`file-exists` sul file toccato + un comando <30s), non spegnere la morsa.

---

## 5. Definition of Done

Due linee, non una:

> **Banco:** un kraken headless su un repo con test rossi esce 4; su test verdi dopo un edit esce 0; il verify non ha chiamato un modello; pattern B non salva la run.  
> **Runtime (dopo, se serve):** un turn riparte da `events.jsonl`; lo store 1.x non nutre il modello; il graph si spiega in GUIDA come due canali.

Nessuna feature Desktop nel frattempo senza exception scritta.

---

## 6. Metriche

| Metrica | 2.37.0 | Target primo tag serio (2.37.1) |
|---------|--------|----------------------------------|
| Pack nativo default su tree riconosciuto | flag | ON |
| Pattern B può produrre PASS | sì | no |
| `kind: 'none'` + nota = prova | sì | no |
| Success senza verification event-backed | buco possibile | exit 4, test |
| Token modello sul path verify verde | dipende dal tentacolo | 0 |
| Store → AgentHarness hot path | fallback dichiarato | invariato finché S1 chiuso |
| Mission e2e CI | no | solo se S2 aperto |
| PRs surface durante S0–M2 | — | 0 senza exception |

---

## 7. Governance release

- **2.37.1** = M1 (+ M2 se entra). Patch. Nome noioso, intenzionale.
- **2.38.x** = S1 se aperto, non “nuova era”.
- **2.39** = S2 solo se le mission sono uso reale.
- Non chiamare “2.1 principi” un dump di UI o un ADR sullo store.

Gate merge:

`verify:principles` → `verify:versions` → build core → typecheck → `test:session` → test morsa M1 → (se aperti) mission e2e.

---

## 8. Checklist PR

- [ ] Questa PR chiude R0 / R4b, oppure è exception firmata, oppure è S1 *dopo* evidenza di resume rotto?
- [ ] Il done è un comando corso dal runtime, non una nota del tentacolo?
- [ ] Il path verde di verify è a zero token modello?
- [ ] Il modello vede solo la Session (o c’è un test)? — obbligatorio sulle PR `spine`, non sulle PR `done-gate`
- [ ] Core senza nuova dipendenza runtime?
- [ ] Non ho aggiunto superficie?

---

## 9. Sintesi

```text
Non più:  uscire dall’alpha
Non più:  S1-spine come primo cuore
Ora:      la morsa, poi i debiti che hanno già morso

S0  freeze superfici
M1  pack nativo · no pattern B · no nota-come-prova · exit 4
M2  pin evidence · un repair · tetto spesa
S1  secondo cervello, se il resume ha mentito
S2  mission smoke, se usi le mission
S3  graph = due canali, una pagina
S4  eval onesti
S5  niente
```

Fedeli = P1 sul **verdetto**, non solo sul log.  
Seri = un test rosso che resta rosso, prima del prossimo ADR sullo store.
