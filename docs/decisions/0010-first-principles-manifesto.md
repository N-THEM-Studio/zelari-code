# ADR-0010: Manifesto dei principi primi (PRINCIPLES.md)

- **Status:** ✅ Accettato
- **Date:** 2026-08-13
- **Deciders:** Andrea (sessione di governance)
- **Related:** ADR-0009 (licenza Apache-2.0), ADR-0007 (audit pre-release), ADR-0004 (stabilità API)

## Contesto

I principi del progetto erano sparsi tra `AGENTS.MD` (conventions), ADR,
`.zelari/docs/` e policy runtime, senza criterio per distinguere *principio
primo* da *convenzione* né per dire cosa fosse meccanicamente garantito. La
sessione di governance ha applicato tre test (arbitra tradeoff / stabile tra
versioni / non derivabile) e prodotto un set canonico.

## Decisione

1. **`PRINCIPLES.md`** è il manifesto canonico; in caso di conflitto vince su
   `AGENTS.MD` e docs.
2. I sei principi primi: **P1 Verificabilità**, **P2 Determinismo del
   controllo**, **P3 Sovranità dell'utente**, **P4 Runtime aperto e riusabile**
   (Apache-2.0), **P5 Leggerezza**, **P6 Orchestrazione giusta per il lavoro**.
3. Decisioni specifiche della sessione:
   - Il principio identitario è l'**orchestrazione giusta per il lavoro** (P6):
     il default kraken non viola alcun principio; council e zelari sono istanze.
   - **Licenza Apache-2.0** su tutto il prodotto (ADR-0009); secrecy policy
     riformulata "runtime aperto, esperienza protetta".
   - **P5 è primo** con formulazione corretta: esenzione esplicita per
     l'interfaccia (Ink+React nella CLI, Tauri nel Desktop).
   - **P3 a domini condivisi**: obiettivi all'utente, mezzi pericolosi al
     sistema, trasparenza obbligatoria.
   - Le convenzioni precedenti (Zod per i tool args, ≤300 LOC, commit atomici,
     async-first, …) sono **derivazioni** di P1/P2/P5, elencate in
     `PRINCIPLES.md`.
4. Classificazione di garanzia per principio (deterministico / semi /
   aspirational) e roadmap: `scripts/verify-principles.mjs` + CI su
   `pull_request` per rendere P5 e le derivazioni gate meccanici.

## Conseguenze

- Le nuove decisioni vanno motivate contro i principi primi.
- "Zod / ≤300 LOC / no-heavy-deps" restano vincoli operativi ma **derivati**:
  violarli non viola un principio primo, salvo quando rompono P1/P2/P5.
- ADR-0008 sostituito da ADR-0009; docs e CHANGELOG aggiornati.

