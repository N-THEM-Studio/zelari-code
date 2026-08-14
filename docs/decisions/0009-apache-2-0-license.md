# ADR-0009: Licenza Apache-2.0 per l'intero monorepo

- **Status:** ✅ Accettato
- **Date:** 2026-08-13
- **Deciders:** Andrea (sessione di governance sui principi primi)
- **Related:** ADR-0008 (monorepo MIT, sostituito), ADR-0002 (core MIT), ADR-0010 (principi primi)

## Contesto

ADR-0008 portò l'intero monorepo a MIT (2026-07-15). Durante la sessione di
governance sui principi primi (ADR-0010) è emersa la tensione tra la secrecy
policy ("product IP is proprietary and confidential") e un repository
interamente pubblico: la policy protegge l'esperienza in-session (refusal del
modello), non può proteggere il codice, che è già tutto pubblico.

Si è deciso di:

- riformulare la secrecy policy come **"runtime aperto, esperienza protetta"**;
- passare l'intero prodotto da MIT ad **Apache-2.0**, per aggiungere la patent
  grant esplicita e le norme trademark, più adatte a un prodotto esposto
  commercialmente e a un ecosistema di contributor.

## Decisione

1. **Tutto il monorepo** (CLI `zelari-code`, `@zelari/core`, Desktop
   `apps/desktop`, Companion Android) è rilasciato sotto **Apache License 2.0**
   (SPDX `Apache-2.0`).
2. `LICENSE` sostituito con il testo canonico Apache-2.0; campi `license`
   aggiornati in `package.json` (root, `packages/core`, `apps/desktop`) e
   nel lockfile root; README, docs e CONTRIBUTING allineati.
3. Copyright holder: **Anathema Studio** — https://anathema-studio.com/.
4. Le attribuzioni di pattern di terze parti (OpenMausBot, diff, ecc.) restano
   intatte.
5. La secrecy policy resta attiva come protezione dell'**esperienza in-session**
   (non rivendicazione di proprietà sul codice): wording aggiornato senza
   indebolire le hard rules (refusal, scrub, marker invariati).

## Conseguenze

- Contributor: i contributi sono sotto Apache-2.0 (CONTRIBUTING aggiornato).
- Redistribution: obblighi di attribution/NOTICE e patent grant; i consumatori
  devono includere la licenza.
- ADR-0008 passa a **Sostituito** (resta come storico dual-license → MIT).
- Futuro: valutare un file `NOTICE` per attribuzioni rilevanti.

