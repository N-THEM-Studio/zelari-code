# ADR-0036 — Evolution Engine: separazione proposer/giudice

- **Stato:** ✅ Accettato (v0: documentazione + gate meccanico; runtime opt-in in fasi successive)
- **Data proposta:** 2026-09-04
- **Autore:** Zelari Code (fase BUILD, su verifica dei suggerimenti utente)
- **Dipende da:** `tools/eval/evolvePropose.ts`, `tools/eval/evolveDecide.ts`,
  `tools/eval/evolveValidate.ts` (engine di proposta già esistente, zero
  auto-mutazione), `scripts/verify-principles.mjs` (gate P1–P6),
  [ADR-0019](./0019-observation-integrity-p1-clause.md),
  [ADR-0023](./0023-deterministic-verification-completion.md),
  [PRINCIPLES.md](../../PRINCIPLES.md) (invariante P1).

## Contesto

Il repo ha già tutti i pezzi di un ciclo evolutivo, ma slegati: `skill-stats` e
`council-feedback`, `/promote-member`, retention gate con manifest hash,
checkpoint/rollback, e — cosa spesso sottovalutata — una pipeline
`evolve:propose`/`evolve:decide`/`evolve:validate` in `tools/eval/` che già
implementa un loop **propose → decide (umano) → validate** con store append-only
e divieto esplicito di auto-mutazione.

La proposta esterna di un "Evolution Engine" è quindi giusta nella direzione ma
sottovaluta l'esistente: non serve costruire il motore, serve **chiudere il loop
attorno a quello che c'è** — e prima di tutto fissare una costituzione che
impedisca al motore di corrompere il proprio giudice.

Il rischio strutturale: qualunque meccanismo che ottimizza contro le metriche
impara le metriche (Goodhart). Se il ciclo evolutivo potesse toccare ciò che
decide sicurezza (P2) o misura la fitness (P1), quei principi diventerebbero
promesse nel prompt — esattamente ciò che P2 vieta.

## Decisione

**Evolve il "genoma governabile", mai il "giudice".** La separazione dei poteri
è meccanicamente enforced da `JUDGE_PATHS` in `scripts/verify-principles.mjs`
(check `judge`, hard in CI):

1. **Genoma** (ciò che può evolvere, con conferma umana per ogni salto di scope
   oltre la sessione): `SKILL.md` (built-in e utente), prompt dei ruoli del
   council e tool budget per ruolo, policy di routing per classe di task,
   template `scope[]`/`acceptance[]` dei tentacoli, euristiche di
   recall/consolidazione della memoria, **proposte** di nuovi anchor eval.
2. **Giudice** (fuori dal genoma per costituzione): `ToolRegistry.invoke` e il
   choke-point dei lifecycle hooks, sandbox e shell blocklist, folder trust e
   permission policy (`src/cli/safety/`), honesty lint e tier ranking
   (`packages/core/src/council/verification/`), anchor eval Tier-0
   (`eval/anchors/`), il gate runner deterministico (`tools/eval/runGate.ts`),
   il retention gate (`.github/workflows/eval-retention-gate.yml`), e questo
   stesso gate (`scripts/verify-principles.mjs`).

Regole operative:

- **Il motore che propone non è il motore che misura. Nessun artefatto può
  promuovere se stesso.** Un giudizio LLM vale al massimo come tier `claimed`
  (evidence ladder): può proporre, non può promuovere. L'autorità di PASS resta
  ai gate deterministici (anchor, tier ranking, CompletionPolicy — ADR-0023).
- **Riuso, non rebuild:** il loop è `evolvePropose` → `evolveDecide` (decisione
  umana, evidenza fail-closed per `applied`) → `evolveValidate`. Nessun nuovo
  canale di promozione automatica.
- **Default off:** in v0 `ZELARI_EVOLUTION=0`; `shadow` (osserva e propone, non
  promuove) è opt-in esplicito, non default — coerente con i default strict del
  repo (ADR-0025/0027).
- **Migrazioni di scope**: `session → project → user` richiedono conferma umana
  (P3); ogni artefatto promosso porta lineage in frontmatter (hash genoma,
  parent, manifest, `promotedBy`).
- **Fitness deterministica:** pass rate sugli anchor con tier ≥ tool, costo e
  latenza normalizzati per classe di task, tasso di `/steer --interrupt` e
  rollback come proxy di P3. Mai LLM-as-judge come fonte primaria.
- **CI:** `scripts/touches-judge.mjs` elenca i file del giudice toccati da un
  diff; le PR che li modificano vengono etichettate `touches-judge` e
  richiedono scrutinio rafforzato.
- **Dogfooding:** missioni zelari sul repo stesso producono solo PR con ADR
  allegato e report di audit campionario (automatizza il ⬜ P1 del roadmap in
  PRINCIPLES.md senza rimuovere il gate umano); il diff non può toccare i
  judge path.

## Conseguenze

- **Positive:** P1 e P2 restano meccanici anche con un motore evolutivo attivo;
  anti-Goodhart diventa invariante verificata in CI, non buona volontà; il
  valore esistente in `tools/eval/` viene capitalizzato invece che duplicato.
- **Negative:** ogni estensione del genoma richiede un aggiornamento esplicito
  di questo ADR + `JUDGE_PATHS`; la fitness deterministica è più costosa da
  calcolare di un LLM-as-judge (accettato).
- **Neutral:** `JUDGE_PATHS` è un elenco vivo: il check fallisce se un path
  sparisce, per impedire che la lista marcisca in silenzio.

## Alternative considerate

1. **Auto-promozione con soglie di fitness** — respinta: viola P1/P2 (il
   proposer diventerebbe anche measurer) e crea il vettore Goodhart più grave.
2. **Evolution Engine greenfield separato** — respinta: duplica
   propose/decide/validate già presenti in `tools/eval/`.
3. **Solo documentazione, nessun gate meccanico** — respinta: senza check in CI
   la separazione sarebbe una promessa nel prompt (P2 vieta proprio questo).
