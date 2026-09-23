# Piano operativo — ROI steal da `unreallabsai/unreal-agent`

**Stato:** IPOTESI DI DESIGN (PLAN phase). Nessun file di prodotto toccato. Ogni landing point va verificato on-disk in BUILD prima di implementare.
**Fonte analisi:** https://github.com/unreallabsai/unreal-agent (ricognizione 2026-09-22).
**Obiettivo:** importare i meccanismi dove unreal-agent è più forte di noi, ignorando dove siamo già avanti.

## Contesto fonte (sintesi)

Harness agente minimalista in Go 1.27, async-first ed event-sourced: un binario singolo (`unreal-agent-runner`) che esegue un task in container sandbox, streamma la session log JSONL su stdout ed esce. Solo 3 tool (Bash, ViewImage, SkillUse), 5 provider LLM, eval su Terminal-Bench 4.0 con traiettorie in formato ATIF. Codice piccolo ma profondo: interfacce swappabili ovunque, fuzz test in CI, smoke Docker, CI su 2 OS.

**Punti forti da rubare:** robustezza dell'event sourcing (fuzz "log matches execution"), gestione output enormi (head+tail + pointer a file), anti-stallo (tool heartbeat), standard aperti (ATIF), idempotenza input (inbox con dedup), esecuzione remota con piano anti-tamper, fork sessioni, fan-out tool call asincroni.

**Dove NON rubare nulla** (lui non li ha o siamo già avanti): skill system, memoria, verification engine, permessi/safety, multi-agent (council/Kraken), UI/TUI, session log event-sourced come concetto (ce l'abbiamo già: ADR-0016/0021/0024 — rubiamo solo i *test di proprietà* sopra).

## Mappa decisionale

| # | Meccanismo | Priorità | Costo | Tipo |
|---|---|---|---|---|
| A1 | Fuzz/property test "log ≡ execution" | alta | basso | quick win |
| A2 | Truncation head+tail + full output su disco | alta | basso | quick win |
| A3 | Heartbeat main loop per tool call lunghi | alta | basso | quick win |
| A4 | Export traiettorie ATIF | media | basso | quick win |
| A5 | Input idempotenti (ID stabili + dedup) | media | basso | quick win |
| B6 | RemoteJob con piano anti-tamper | alta | medio | slice |
| B7 | Fork sessioni da turn boundary | media | medio | slice |
| B8 | Tool call asincroni + placeholder "still running" | alta | medio-alto | slice + ADR |
| C  | Preamble prompt "fan-out tool call" | alta | gratis | prompt design |

---

## WP-A — Quick win

### A1 — Fuzz/property test "log-replay ≡ execution" sulla spine
- **Fonte:** `cmd/internal/agentrunner/*_fuzz_test.go` + `.github/workflows/ci.yml`. Due fuzzer generano sequenze di eventi casuali e verificano che il log riconstruisca esattamente l'esecuzione reale.
- **Cosa rubare:** la proprietà *replay(serialize(execuzione)) == esecuzione* come test property-based con seed fissi, non il codice Go.
- **Atterraggio (da verificare on-disk):** spine sessioni in `packages/core/src/core/session/` (`replay.ts`, `deriveMessages`, writer con lock + `seq` monotono, `SCHEMA_VERSION`). Coerente col determinism-audit già avviato (`.zelari/docs/2026-09-19-m2.3-audit-determinismo-trailing.md`).
- **Verifica preliminare BUILD:** localizzare i test esistenti della spine e lo style (vitest); confermare che non esista già un property harness; **niente nuove dipendenze** (zero heavy deps): generatore pseudo-casuale seed-izzato home-made.
- **Acceptance:**
  1. Test proprietà: su sequenze di eventi generate con seed fisso e conformi allo schema `SCHEMA_VERSION`, `replay(serialize(sessione))` produce le stesse `deriveMessages` della sessione originaria.
  2. Deterministico: stesso seed ⇒ stesso risultato su run ripetute.
  3. Verde in `npm run test`; nessuna nuova dipendenza runtime.
- **Rischi:** generatori troppo irrealistici ⇒ falsi positivi. Mitigazione: generare solo envelope conformi allo schema, mai payload malformati (quelli coprono un altro asse: tolerant replay).

### A2 — Truncation head+tail con puntatore a file per output shell lunghi
- **Fonte:** `harness/operation/output.go`: ~metà head + ~metà tail, marker `...N bytes truncated; complete output in <path>`, full output scritto su disco **prima** del troncamento.
- **Cosa rubare:** la politica di troncamento (mai solo il tail, mai perdere il full output) + marker machine-readable.
- **Atterraggio (da verificare on-disk):** layer osservazioni (`observationStore` / observation budget) e tool bash del CLI. Attenzione alla pipeline budget canonica (ADR-0032): il troncamento deve avvenire in **un solo punto**, non essere applicato due volte dal budget pipeline.
- **Acceptance:**
  1. Sopra soglia N byte: l'osservazione recapitata al modello è head+tail+marker con il path del file completo; sotto soglia: invariata.
  2. Il full output è sempre recuperabile da disco per ispezione/eval.
  3. Test unitario sul formatter (soglia, marker, path); nessuna doppia compressione col budget pipeline.
- **Rischi:** interazione con context projector/budget: verificare dove avviene oggi la compressione delle osservazioni e accentrare la logica.

### A3 — Heartbeat del main loop per tool call lunghi
- **Fonte:** `tool-heartbeat-interval`: se ci sono solo tool call in esecuzione e non accade nulla per N minuti, l'harness "sveglia" il modello con la lista dei call ancora in corso.
- **Cosa rubare:** il meccanismo anti-stallo *anche fuori dai tentacoli*: estendere l'heartbeat già presente (`tentacleHeartbeat.ts`) al loop principale ai long-running tool call.
- **Atterraggio (da verificare on-disk):** `tentacleHeartbeat.ts` + loop agente principale / gestione tool call lunghi (tema già caro: "wall cap no longer kills active turns").
- **Acceptance:**
  1. Se un tool call supera la soglia, viene emesso un evento heartbeat con i call in corso (max 1 evento per soglia per call — throttling anti-spam).
  2. Soglia configurabile via env/pref; disabilitabile.
  3. Nessuna interferenza/doppio-sveglio con l'heartbeat tentacoli.
- **Rischi:** spam di turni ⇒ token sprecati; il throttling è parte dell'acceptance.

### A4 — Export traiettorie in formato ATIF
- **Fonte:** traiettorie in formato ATIF (Agent Trajectory Interchange Format) usato per gli eval su Terminal-Bench 4.0.
- **Cosa rubare:** l'export in uno standard aperto per confrontare traiettorie cross-agente.
- **Atterraggio (da verificare on-disk):** `exportSession.ts` come emittente; `tools/eval/runCompetitiveBench.ts` come primo consumatore (è già advisory: coerente col vincolo JudgeService non autorevole).
- **Acceptance:**
  1. Export ATIF di una sessione reale valido rispetto allo schema pubblico del formato (versionato: campo `atifVersion`, best-effort dato che lo schema è in evoluzione).
  2. Round-trip verificato su sessione reale; nessuna dipendenza runtime nuova (validatore dev-only solo se strettamente necessario).
- **Rischi:** schema in evoluzione ⇒ trattare l'export come superficie non stabile, documentato come tale.

### A5 — Input idempotenti (ID stabili + dedup persistente)
- **Fonte:** `harness/inbox/`: ogni input ha un UUID; il re-submit viene dedupato anche dopo un crash (inbox persistente).
- **Cosa rubare:** il contratto *ID stabile + dedup persistente* per gli ingressi remoti.
- **Atterraggio (da verificare on-disk):** superfici input remote — `serve-harness`, `askUserBridge`, companion Android (`apps/companion-android`): le riconnessioni mobili duplicano le richieste.
- **Acceptance:**
  1. Ogni input in ingresso porta uno ID stabile fornito dal client (o generato una volta e persistito dal client).
  2. Re-submit dello stesso ID non produce due turni/richieste; ritorno idempotente (stesso esito).
  3. Dedup che sopravvive al restart dove esiste già persistenza; test con doppio submit + simulazione reconnect.
- **Rischi:** dedup in-memory ⇒ duplicati post-crash. Verificare quale store usano `serve-harness` e `askUserBridge` e persistere lì.

---

## WP-B — Slice medie

### B6 — RemoteJob con piano anti-tamper
- **Fonte:** `harness/operation/remote_job_handler.go`: `RemoteJobPlan{Type, Version, Data}` inviato a un handler remoto che **non può** modificare tipo/versione/max-output del piano.
- **Cosa rubare:** il pattern "il piano è firmato dal chiamante, l'endpoint esegue e basta".
- **Atterraggio:** esecuzione remota via SSH (target `prod-vps`, già configurato con allowlist di comandi) e futura sandbox dei tentacoli.
- **Acceptance:**
  1. Piano serializzato con vincolo su tipo|versione|max-output verificato prima dell'esecuzione; mutazione ⇒ rifiuto con errore strutturato.
  2. Test del rifiuto (piano mutato ⇒ non eseguito).
- **Rischi:** non estendere l'allowlist SSH per farci spazio: il piano deve girare dentro i comandi già consentiti o con una allowlist dedicata esplicita.

### B7 — Fork delle sessioni come primitiva di primo livello
- **Fonte:** `Store.Fork`: branching da un qualunque *turn boundary* — storia ereditata, stato transiente azzerato.
- **Cosa rubare:** il fork come operazione di store, non come copia grezza di file.
- **Atterraggio:** spine sessioni (`packages/core/src/core/session/`) + gemello filesystem: worktree Kraken (`ZELARI_KRAKEN_WORKTREE=1`, `.zelari/worktrees/`) — "prova due approcci dallo stesso punto".
- **Acceptance:**
  1. Fork da un turn boundary ⇒ sessione figlia con `seq`/lineage coerenti col contratto spine v1 (ADR-0021 "lineage").
  2. Replay della figlia indipendente dalla madre; export separato.
- **Rischi:** ownership lock della spine (single-writer): il fork deve rispettare il lock e non creare secondi writer.

### B8 — Tool call asincroni con placeholder "still running"
- **Fonte:** `harness/contextbuilder/builder.go`: il modello può emettere altri tool call indipendenti mentre uno è in esecuzione; nel contesto compare un placeholder "still running" che viene sostituito dal risultato in un turno successivo.
- **Cosa rubare:** il fan-out reale in un turno **senza rompere il contratto message-ordering dei provider** (i messaggi del tool risultante arrivano ai boundary naturali, coerente col nostro "re-inject at natural boundaries").
- **Atterraggio:** loop agente principale + contract provider. Abbiamo già `observe_batch` (read-only batching): questo estende il pattern al tool call ordinario.
- **Acceptance:**
  1. Due tool call indipendenti girano in parallelo nello stesso turno; placeholder visibile nel contesto; risultato che rimpiazza il placeholder senza violare l'ordering richiesto dal provider.
  2. Compatibilità verificata su almeno il provider primario + fallback.
- **Rischi:** è la più invasiva (tocca il cuore del loop): **ADR dedicata obbligatoria prima del codice**. Non aggredire questo item prima di A1–A5.

---

## WP-C — Prompt design (costo zero)

- **Fonte:** il preamble di unreal-agent insegna esplicitamente al modello a fare fan-out ("i tool call sono asincroni e non si bloccano a vicenda, emettine più indipendenti quando le operazioni sono indipendenti").
- **Atterraggio:** prompt di sistema/task — `src/cli/tools/taskPrompts.ts` (e affini, da verificare on-disk). Adattare al nostro runtime, non copiare il testo.
- **Acceptance:** diff solo su testo prompt; eval/golden esistenti verdi (`npm run eval:gate` dove applicabile); nessun cambio di codice.
- **Nota:** da eseguire **dopo** A3/B8 o in forma conservativa (il fan-out va dichiarato solo dove il runtime lo supporta davvero).

---

## Sequenza consigliata

1. **A1 + A2 + A5** — indipendenti, costo basso, eseguibili in parallelo.
2. **C** — indipendente, gratis (forma conservativa se B8 non è pronto).
3. **A3** — richiede lettura di `tentacleHeartbeat.ts` + loop principale.
4. **A4** — indipendente, bassa priorità.
5. **B6 → B7 → B8** — in quest'ordine; B8 ultimo e solo con ADR dedicata.

## Fuori scope (decisione registrata)

- **Nessun porting Go→TS di sorgenti** di unreal-agent: rubiamo *meccanismi* (idee ri-implementate), non codice. Verificare la licenza del repo prima di copiare qualsiasi testo letterale.
- UI/TUI, permission engine, memoria, skill system, verification engine: **non toccati** (non fanno parte di questo piano).
- Nessuna modifica alla spine come contratto (ADR-0016/0021/0024 restano valide): A1/A2/B7 si innestano *sopra* il contratto esistente.

## Verifiche trasversali per ogni task

1. Prima di implementare: `list_files`/`grep_content` sui landing point dichiarati (qui sono ipotesi basate sulla ricognizione, non path confermati on-disk).
2. Dopo l'implementazione: `npm run test` + `npm run typecheck` (o verify tentacle) — nessun task è "done" senza evidenza su disco.
3. Rispetto convenzioni: una tool definition per file, zod sugli argomenti, zero nuove dipendenze pesanti, moduli ≤ 300 LOC, commit atomici singoli.

## Task collegati (.zelari/plan.json)

| Task | Voce | Priorità |
|---|---|---|
| t165 | A1 fuzz/property spine | high |
| t166 | A2 truncation head+tail | high |
| t167 | A3 heartbeat main loop | high |
| t168 | A4 export ATIF | medium |
| t169 | A5 input idempotenti | medium |
| t170 | B6 RemoteJob anti-tamper | high |
| t171 | B7 fork sessioni | medium |
| t172 | B8 tool call asincroni (ADR prima) | high |
| t173 | C preamble fan-out prompt | medium |
