
- **Stato**: accepted
- **Data**: 2026-08-18
- **Governance**: prerequisite slice del piano "Kraken Verified Selection" (Fase 0/1), standard Kraken only — nessuna integrazione Graph
- **Release**: prossima minor

## Context

Il piano Verified Selection (multi-candidate exploration in PLAN/BUILD) richiede che il tool `task` possa spawnare tentacoli explore in fase PLAN. Oggi tre primitive lo impediscono o lo indeboliscono:

1. `createBuiltinToolRegistry` registra `task` solo con `!options.planMode` (`enableTask`), quindi PLAN non può parallelizzare ricerca.
2. `planMode` e `readOnly` sono accoppiati nella stessa variabile derivata: separare il task richiedeva attenzione a non aprire mutatori.
3. Il task tool standard non propaga al tentacolo né il provider/model risolto dal turno (i tentacoli ricadevano sul default persistito di `provider.json`, divergendo dalla selezione utente — problema già corretto solo nel percorso kraken-graph) né il cancellation signal del turno (`runTentacle` supporta `opts.signal` ma `execute` non lo passava).

## Decision

1. **Plan-safe explore task**: il registro in `planMode` registra comunque `task`, ma con `TaskToolPolicy.allowedAgents: ['explore']`. La policy è applicata su tre livelli: enum zod ristretto (i provider conformi non possono emettere `general`/`verify`), gate esplicito in `execute` PRIMA del consumo dello spawn budget, suffisso `RESTRICTED` nella description visibile al modello. Opt-out: `planExploreTask: false` ripristina il comportamento pre-ADR (nessun `task` in PLAN). Il profilo `explore` resta read-only, quindi PLAN non acquisisce reach di scrittura/esecuzione.
2. **Ancoraggio provider/model**: `CreateRegistryOptions` accetta `subAgentProvider`/`subAgentModel`, inoltrati a `createKrakenSubAgentContextFactory` (che già supportava gli override per il percorso graph). La TUI (`useChatTurn`) passa il provider/model risolto del turno quando esiste; headless (`runHeadlessSingle`) passa il provider/model risolto del run. Chi non li passa mantiene il comportamento precedente (fallback persistito).
3. **Propagazione cancellation**: `execute` passa `ctx.signal` a `runTentacle`, che già lo inoltra a `runSubAgent` (unwind del generatore: il tentacolo si ferma prima della prossima tool call e non continua a scrivere dopo la cancellazione del parent).
4. **Invarianti di scope (Fase 0)**: feature target = solo Kraken standard; il comportamento del Graph non cambia (graph/fanout call-site non toccati); PLAN resta project read-only; i tentacoli candidate (futuri) saranno explore-only; in v1 il numero massimo di implementazioni candidate è zero; il verifier di default sarà esattamente il modello parent.

## Consequences

- PLAN può spawnare solo `explore`; `general`/`verify` sono rifiutati con errore chiaro senza consumare budget di spawn.
- BUILD (profile full, non plan) è invariato: stessi tool, stessa policy illimitata, stesso comportamento pre-ADR.
- I registri esplicitamente `readOnly` e i sub-profili (`explore`/`verify`/`general`) non registrano `task` (anti-ricorsione): invariato.
- `inspect_command` e i mutatori restano legati alla sola variabile derivata `readOnly` (che continua a includere `planMode`): la separazione riguarda unicamente il tool `task`.
- La selezione TUI/Desktop ora governa anche i tentacoli del task standard (prima: solo il parent), allineando il percorso standard a ciò che il graph path già faceva.
- Test: `src/cli/tools/taskTool.planSafety.test.ts` copre gating del registro, policy explore-only, enum ristretto, propagazione signal e regressioni BUILD/readOnly/sub-profile.

## Alternatives considered

- **Registrare il task in PLAN senza policy** (affidarsi al solo profilo explore del chiamante): respinto — il modello parent potrebbe emettere `agent=general` e il tentacolo general scriverebbe fuori dal contratto plan.
- **Gate solo a livello di prompt**: respinto — policy revocabile dal modello; l'invariante deve stare nel runtime.
- **Decouplare completamente `readOnly` da `planMode`**: rinviato — avrebbe toccato mutators/bash/inspect_command/world-model/ssh/browser insieme; non necessario per la Fase 1 e fuori dal principio del diff minimo.
