# ADR-0029: Memoria cognitiva condivisa native-first

- **Status**: accepted
- **Date**: 2026-08-23
- **Deciders**: Zelari Code council, maintainer

## Contesto

La memoria JSONL di Zelari conserva semplici chunk e permette recall lessicale
tra slice, ma non rappresenta tipo, provenienza strutturata, relazioni,
supersessioni o revisioni. Council, Kraken e missioni hanno bisogno dello stesso
substrato locale senza dipendere da un daemon o da MCP.

La memoria non deve confondersi con:

- `.zelari/state/`, stato verificato e ripristinabile dell'esecuzione;
- `.zelari/sessions/`, log event-sourced e fonte della cronologia;
- `AGENTS.MD`, guida stabile, curata e leggibile dagli umani.

## Decisione

1. `@zelari/core/memory` espone due livelli additivi: `MemoryService` contiene
   policy e retrieval; `CognitiveMemoryBackend` contiene persistenza e query.
   Il contratto `MemoryBackend` V1 resta disponibile tramite adapter.
2. Il primo backend V2 vive nella CLI e usa SQLite sotto
   `.zelari/memory/memory.db`. `node:sqlite` gira esclusivamente in un worker;
   WAL, busy timeout, transazioni brevi e retry limitati consentono più
   processi senza bloccare l'event loop dell'agente.
3. L'envelope di dominio v1 contiene nodi tipizzati, archi con vocabolario
   chiuso e versioni append-only. Lo schema SQLite è migrato forward-only; v2
   aggiunge visibilità/accesso e indice embedding. Prima della migrazione viene
   creato un backup sotto lock. Un runtime non apre in scrittura uno schema
   futuro e non esegue downgrade silenziosi.
4. Il recall è locale e deterministico: FTS/lessicale, filtri strutturati,
   ranking configurabile, espansione del grafo, dedupe e budget caratteri
   rigido. Il semantic recall è un'estensione iniettata e opzionale: model ID e
   content hash impediscono vettori stale, mentre ogni errore ricade su FTS.
5. Ogni scrittura attraverso `MemoryService` passa da normalizzazione,
   validazione di scope, limiti di payload e secret scanner. Per default la
   memoria è isolata al path canonico del progetto.
6. Council, AgentHarness, Kraken, headless e missioni consumano la stessa API.
   Le verifiche creano relazioni `validated_by`/`invalidated_by`; una relazione
   `supersedes` rende obsoleto il nodo precedente conservandone la storia.
7. Il rollout è esplicito (`ZELARI_MEMORY_V2=1` o backend `sqlite`). Il backend
   JSONL resta il default compatibile; l'import V2 è idempotente e non elimina
   `log.jsonl`.
8. L'adapter MCP chiama `MemoryService`, non SQL. Rimane esterno, opt-in,
   sottoposto a folder trust, scope esatto, ownership, secret scan e rate limit.
9. Desktop usa un bridge CLI JSON di sola lettura e presenta ricerca, dettaglio,
   provenance, relazioni e storia senza duplicare semantica o persistenza.

## Alternative considerate

- **MCP come trasporto interno**: respinto; aggiungerebbe disponibilità,
  trasporto e trust a ogni turno nativo.
- **Solo JSONL esteso**: respinto per transazioni, FTS, relazioni, revisioni e
  concorrenza multi-processo.
- **Embedding obbligatori**: respinto; la memoria deve restare leggibile e utile
  offline anche senza indice semantico.
- **Sovrascritture distruttive**: respinte; decisioni e confidenza devono essere
  ricostruibili temporalmente.

## Conseguenze

- Node 24 è il requisito runtime del backend SQLite nativo.
- Il database è un artefatto locale del progetto e può essere ispezionato,
  esportato, retratto o eliminato esplicitamente da `/memory`.
- I fallimenti di recall/write sono fail-open salvo
  `ZELARI_MEMORY_STRICT=1`; non cambiano l'esito di un turno o di un grafo.
- Semantic retrieval, adapter MCP e Desktop explorer sono estensioni
  post-MVP opzionali e non condizionano il contratto o la disponibilità nativa.
