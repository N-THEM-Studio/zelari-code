# ADR-0005: Deprecation dei path sorgente legacy

- **Stato:** ✅ Accettato
- **Data proposta:** 2026-07-02
- **Data accettazione:** 2026-07-02 (auto-accettata — i path vecchi non esistono piu nel tree post `6ec90be`, e grep ha confermato 0 import residui da src/main/core in src/cli/)
- **Autore:** MiniMax-M3
- **Dipende da:** [ADR-0001](0001-monorepo-for-zelari-core.md),
  [ADR-0004](0004-public-api-stability-policy.md)

## Contesto

Prima del refactor v0.5.0, il codice del core viveva in percorsi
interni al CLI:

```
src/main/core/      (AgentHarness, ToolRegistry, ecc.)
src/agents/         (council, roles, skills built-in)
src/shared/         (events)
src/types/          (context, knowledge, systemTypes)
```

Dopo il refactor, questi path sono stati spostati (via `git mv`) in
`packages/core/src/` e rinominati secondo la nuova struttura:

```
packages/core/src/harness/      (ex src/main/core/)
packages/core/src/council/      (ex src/agents/councilApi.ts ecc.)
packages/core/src/skills/       (ex src/agents/skills/)
packages/core/src/events/       (ex src/shared/)
packages/core/src/types/        (ex src/types/, con legacy.ts)
```

I file `src/main/` e `src/agents/` e `src/shared/` e `src/types/` NON
esistono più nel tree, ma la **conoscenza di quei path è ancora
diffusa** in:
- Tutorial / blog post / Discord
- Snippet di codice in risposte LLM passate
- Issue GitHub
- IDE autocomplete history (alcuni utenti usano "Open recent" per
  navigare)

Serve una **politica esplicita** per dire alla community:
1. Quei path sono morti, non tornano.
2. Le nuove posizioni sono in `@zelari/core/...`.
3. Se trovi riferimenti a `src/main/core/` → apri issue.

## Decisione

### Niente `src/legacy-compat/` shim

**NON** creiamo file `src/main/core/X.ts` che fanno `export * from
'@zelari/core/X'`. Motivi:
- Aggiunge path interni che confondono chi legge il tree.
- Il barrel di `@zelari/core` è già il punto di ingresso canonico;
  duplicare l'esposizione crea due fonti di verità.
- Il nostro stesso CLI consuma solo `@zelari/core/*` dal refactor
  in poi (verificato: `git grep "from.*src/main/core" src/cli/` →
  0 risultati).

### Comunicazione esplicita

Aggiungiamo:
1. **README.md** del repo: sezione "Migration from pre-v0.5.0 paths"
   con tabella `vecchio → nuovo`.
2. **packages/core/README.md**: in cima "If you're upgrading from
   zelari-code ≤ 0.4.x, see [MIGRATION.md](../../MIGRATION.md)".
3. **Commenti git blame** non servono (il `git mv` ha preservato la
   storia).
4. **Issue template** per bug reports: campo "Did you import from a
   legacy path? (old: src/main/core/, src/agents/, src/shared/,
   src/types/)".

### Mappa di migrazione

Stampata in `MIGRATION.md` (file nuovo, linkato da README):

| Vecchio path                          | Nuovo subpath @zelari/core             |
|---------------------------------------|---------------------------------------|
| `src/main/core/AgentHarness`          | `@zelari/core/harness`                |
| `src/main/core/providerStream`        | `@zelari/core/harness`                |
| `src/main/core/sessionJsonl`          | `@zelari/core/harness`                |
| `src/main/core/tools`                 | `@zelari/core/harness/tools`          |
| `src/main/core/tools/builtin/*`       | `@zelari/core/harness/tools/builtin/*`|
| `src/agents/councilApi`               | `@zelari/core/council`                |
| `src/agents/roles`                    | `@zelari/core/council`                |
| `src/agents/promoteMember`            | `@zelari/core/council`                |
| `src/agents/skills`                   | `@zelari/core/skills`                 |
| `src/agents/skills/builtin/*`         | `@zelari/core/skills/builtin/*`       |
| `src/agents/systemPromptBuilder`      | `@zelari/core/council` (interno)      |
| `src/agents/toolSchemas`              | `@zelari/core/harness/tools`          |
| `src/agents/tools`                    | `@zelari/core/harness/tools`          |
| `src/shared/eventBus`                 | `@zelari/core/events`                 |
| `src/shared/events`                   | `@zelari/core/events`                 |
| `src/types/context`                   | `@zelari/core/types`                  |
| `src/types/knowledge`                 | `@zelari/core/types` (interno)        |
| `src/types/systemTypes`               | `@zelari/core/types`                  |

### Direzione per la community

Quando qualcuno apre una issue / PR con un path legacy:
- Risposta template: "Quei path sono stati rimossi in v0.5.0. Vedi
  [MIGRATION.md]. Nessun supporto per path legacy perché il barrel
  `packages/core/src/index.ts` è già la fonte canonica."

## Alternative considerate

- **`src/legacy-compat/` shim** — scartato per i motivi sopra
  (doppia fonte di verità).
- **Git tag sui path vecchi pre-0.5.0** — esiste già
  implicitamente tramite git history; non serve tag esplicito.
- **Hard redirect nei tools (esbuild plugin)** — eccessivo, e rompe
  il flusso "import X from Y" del consumer.

## Conseguenze

**Positive**
- Zero ambiguità: un solo path per ogni concetto.
- Niente codice morto da mantenere.
- Documentazione esplicita aiuta chi migra.

**Negative / rischi**
- Utenti con codice esistente su path vecchi devono migrare
  manualmente (sforzo unico).
- Link / snippet di LLM pre-v0.5 restano obsoleti online — serve
  pazienza.

## TODO

- [x] Andrea conferma: no shim, no re-export aliasing (implicitly
      confirmed via "Procedi" instruction in commit 217db8d).
- [x] Scrivere `MIGRATION.md` con la tabella sopra + esempi di
      before/after (delivered in v0.5.0 release commit).
- [x] Aggiornare `README.md` con link a MIGRATION.md (added callout
      in the "Install" section).
- [x] Aggiungere `MIGRATION.md` come file creato in v0.5.0
      (incluso nel CHANGELOG).
- [ ] Issue template per bug reports (deferred — can be added in a
      follow-up release; v0.5.0 ships without it because the
      changelog already documents the migration path).
