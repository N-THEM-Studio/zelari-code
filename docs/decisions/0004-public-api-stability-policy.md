# ADR-0004: Policy di stabilità API pubblica di `@zelari/core`

- **Stato:** ✅ Accettato
- **Data proposta:** 2026-07-02
- **Data accettazione:** 2026-07-02 (auto-accettata — i 9 subpath sono gia scritti e funzionanti in packages/core/package.json exports map)
- **Autore:** MiniMax-M3
- **Dipende da:** [ADR-0002](0002-publish-zelari-core-to-npm.md),
  [ADR-0003](0003-versioning-monorepo-policy.md)

## Contesto

Appena pubblichiamo `@zelari/core`, qualunque rename, signature
change, o tipo rimosso diventa un breaking change per consumer
esterni che non controlliamo (potenzialmente).

Dobbiamo decidere:
1. Quale sottoinsieme di `@zelari/core/*` è **API pubblica stabile**?
2. Come gestiamo le breaking changes durante `0.X.Y` (pre-1.0)?
3. Qual è il processo di deprecation?

## Decisione

### API pubblica stabile in v0.5.0

Esportiamo esplicitamente come stabile SOLO i barrel definiti, e **non**
i subpath interni:

| Subpath                    | Stato v0.5.0 | Note                                  |
|----------------------------|--------------|---------------------------------------|
| `@zelari/core`             | **stable**   | Root barrel (subset ristretto, vedi sotto) |
| `@zelari/core/harness`     | **stable**   | `AgentHarness`, provider-neutral loop |
| `@zelari/core/council`     | **stable**   | Council API, ruoli, promoteMember     |
| `@zelari/core/skills`      | **stable**   | Registry delle built-in skills        |
| `@zelari/core/events`      | **stable**   | `BrainEvent`, `EventBus`              |
| `@zelari/core/types`       | **stable**   | Solo i tipi pubblici (no `legacy.ts`) |
| `@zelari/core/harness/tools` | **stable** | `ToolRegistry`, tool types           |
| `@zelari/core/harness/tools/builtin/*` | **stable** | Le 6 tool built-in            |
| `@zelari/core/skills/builtin/*` | **stable** | Le 7 skill built-in              |

### Root barrel ristretto

Il file `packages/core/src/index.ts` espone SOLO:
- `AgentHarness`, `ProviderStream` (da harness)
- `Tool`, `ToolContext`, `ToolResult` (da tools)
- `EventBus`, `BrainEvent` (da events)
- `createCouncil`, `CouncilMember`, `MemberRole` (da council)
- `registerBuiltInSkills` (da skills)
- Tipi di `types/context` e `types/systemTypes`

**NON** espone da root:
- internals di AgentHarness (helpers privati)
- `legacy.ts` (tipi storici)
- mock/test utilities
- `councilDirectives` (configurazione interna)

### Tutto il resto è `@internal`

Qualsiasi export non elencato sopra è considerato **interno** e può
cambiare senza preavviso tra minor o patch, anche durante 0.5.x. Lo
marcamiamo con un commento JSDoc `@internal` in cima al file.

### Breaking changes in 0.X.Y

Durante la fase pre-1.0 (`0.5.x`, `0.6.x`, ecc.):

1. **Deprecation cycle:**
   - Deprecate una export via `/** @deprecated use X */` JSDoc.
   - Mantieni la export funzionante per **almeno 2 minor release**
     (es. deprecato in 0.5.0 → rimosso non prima di 0.7.0).
   - Log a `console.warn` la prima volta che il consumer importa il
     simbolo deprecato (in dev mode).

2. **Migrazione documentata:**
   - Ogni deprecation aggiunge una riga in `CHANGELOG.md` con
     sezione `### Deprecated` + link a snippet di migrazione.
   - Il nostro CLI stesso (unico consumer iniziale) viene migrato
     nella stessa release della deprecation.

3. **MAJOR bump** (1.0) solo quando:
   - L'API pubblica copre ≥ 90% dei casi d'uso reali (decisione
     soggettiva di Andrea).
   - Un audit ha confermato che nessun consumer esterno noto è
     impattato.
   - La coverage dei test del barrel supera l'80%.

### Convenzione JSDoc

```typescript
/**
 * Create a new agent loop bound to a provider stream.
 * @public
 * @since 0.5.0
 */
export function createHarness(...): AgentHarness { ... }

/**
 * @deprecated since 0.7.0 — use `createHarness` instead.
 *             Will be removed in 1.0.0.
 */
export function legacyHarness(...): AgentHarness { ... }

// internals — no JSDoc, name starts with underscore OK
function _internalHelper() {}
```

## Alternative considerate

- **Niente policy, semver "puro" come ogni package npm** — funziona,
  ma non aiuta i consumer a sapere cosa è stabile; il barrel è
  l'unica ancora, e i subpath profondi restano "zona grigia".
- **Tutto è stabile (no `@internal`)** — impossibile da mantenere,
  ogni refactor diventa breaking.
- **API freeze totale in 0.5 (zero cambiamenti fino a 1.0)** — blocca
  l'innovazione; il refactor non è ancora finito.

## Conseguenze

**Positive**
- Barrel esplicito dà al consumer un punto di ingresso chiaro.
- Ciclo di deprecation 2-release dà tempo ai consumer di migrare.
- `console.warn` solo in dev mode non impatta produzione.

**Negative / rischi**
- Barrel troppo ristretto = consumer frustrato che deve importare
  da molti subpath.
- Disciplina nel marcare `@internal` è facile da perdere.
- 2-release deprecation è tanto durante 0.X.Y (rilasciamo
  frequentemente); forse troppo.
- Serve tooling per generare `@since` automaticamente (TS API
  extractor, api-extractor) per evitare drift.

## TODO

- [ ] Andrea rivede la lista "API stabile v0.5.0" e aggiunge/toglie.
- [ ] Aggiungere JSDoc `@public`/`@internal`/`@deprecated` su
      tutti gli export dei barrel.
- [ ] Setup api-extractor per generare `packages/core/api-report.md`
      (fonte unica di verità per "cosa è pubblico").
- [ ] Discutere se il ciclo di deprecation va accorciato a 1 minor
      durante 0.X.Y (rilasci veloci).
