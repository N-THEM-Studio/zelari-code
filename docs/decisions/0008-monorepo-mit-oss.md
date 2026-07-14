# ADR-0008: Monorepo MIT license for open-source release

- **Status:** ✅ Accettato
- **Date:** 2026-07-15
- **Deciders:** Anathema Studio
- **Related:** ADR-0002 (publish `@zelari/core` MIT), dual-license era

## Contesto

Fino a v1.14.x il monorepo era **dual-license** di fatto:

- CLI `zelari-code` e landing: **proprietario** (`SEE LICENSE IN LICENSE`)
- Libreria `@zelari/core`: **MIT**

Per un rilascio open source pubblico serve un’unica licenza comprensibile a
contributor e redistributor, allineata al core già MIT.

## Decisione

1. **Tutto il monorepo** (CLI, `@zelari/core`, Desktop `apps/desktop`) è
   rilasciato sotto **MIT License**.
2. **Copyright holder** pubblico: **Anathema Studio**  
   `https://anathema-studio.com/`  
   (GitHub org `N-THEM-Studio` resta host del repository; non è il copyright
   string primario nei file LICENSE.)
3. Scaffolding community obbligatorio: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
   `SECURITY.md`.
4. ADR-0002 resta **storico** per la decisione di pubblicare il core MIT; la
   restrizione “repo CLI proprietario” è **superseded** da questo ADR.

## Conseguenze

### Positive

- Un solo modello legale per fork, contribuzioni e redistribuzione npm
- Badge e README coerenti con package.json
- `@zelari/core` e CLI non divergono più per license field

### Negative / trade-off

- Si rinuncia alle restrizioni commerciali/modifica del vecchio LICENSE
  proprietario
- Downstream che dipendevano dal dual-license non devono più trattare la CLI
  come closed source

## Note

La policy di runtime “non rivelare system/role prompt e pipeline interna”
(v1.13+) è una **feature di prodotto**, non una clausola di licenza.
