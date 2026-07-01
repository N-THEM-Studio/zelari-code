# ADR-0001: Monorepo con npm workspaces per `@zelari/core`

- **Stato:** ✅ Accettato
- **Data proposta:** 2026-07-01
- **Data accettazione:** 2026-07-01 (implicita, via commit `6ec90be`)
- **Autore:** MiniMax-M3 (proposta) / Andrea (decisione)

## Contesto

Prima della v0.5.0, `zelari-code` era un package monolitico. Il
codice "logicamente estraggibile" (AgentHarness, ToolRegistry,
council, skills, eventi) viveva in `src/main/core/` e `src/agents/`,
ma condivideva `package.json`, `tsconfig.json`, e dipendenze con il
CLI.

Il piano v0.5.0 (`docs/plans/2026-07-01-v0-5-0-roadmap.md`) proponeva
l'estrazione come prerequisito per la pubblicazione del core come
package `@zelari/core` riusabile da terzi.

## Decisione

**Usare un monorepo con npm workspaces**, layout:

```
zelari-code/
├── package.json          # "workspaces": ["packages/*"]
├── tsconfig.json         # root, esclude packages/*
├── packages/
│   └── core/             # @zelari/core
│       ├── package.json  # name, version, exports map
│       ├── tsconfig.json # composite: true
│       └── src/
│           ├── harness/      (AgentHarness, providerStream)
│           ├── council/      (councilApi, roles, promoteMember)
│           ├── skills/       (registry + built-in)
│           ├── events/       (BrainEvent, EventBus)
│           ├── types/        (context + systemTypes + legacy.ts)
│           └── index.ts      (root barrel)
├── src/cli/              # zelari-code CLI (consumer @zelari/core)
└── tests/                # test del CLI
```

### Motivazioni accettate

1. **Single team, single repo, single release.** Il core e il CLI
   evolvono in sync; forzarne la separazione ora aggiunge overhead
   senza valore.
2. **Workspace symlink nativo:** npm install crea
   `node_modules/@zelari/core → ../../packages/core`, zero magia.
3. **`tsc --build` con `composite: true`** permette incremental
   builds cross-package senza bundler intermedi (esbuild continua a
   bundlare il CLI finale).
4. **Migrazione a repo separato resta possibile** in futuro (è una
   refactor meccanica: `git subtree split` su `packages/core/` +
   nuovo repo).

### Cose che NON sono state decise qui

- Pubblicazione npm → ADR-0002
- Schema versioning → ADR-0003
- Stabilità API pubblica → ADR-0004
- Deprecation path legacy → ADR-0005

## Conseguenze

**Positive**
- Refactor fatto in un commit atomico (`6ec90be`), con rename
  detection al 100% via git.
- 692/692 test verdi dopo la migrazione.
- Zero downtime per gli utenti del CLI: nessun cambio di UX.
- Apre la strada a Fase 2 (wizard) senza dover rinominare ancora.

**Negative / rischi**
- `node_modules` più pesante (workspaces installa dipendenze sia
  per root che per `packages/core`, anche se sono uguali).
- Test count invariato (692 → 692), ma soglia "≥ 800" del piano
  v0.5.0 non centrata → da recuperare in Fase 2.

## TODO

- [x] Creare `packages/core/` con struttura barrel.
- [x] Reindirizzare import CLI a `@zelari/core/*`.
- [x] Aggiungere `workspaces` a root `package.json`.
- [x] Configurare `exports` map in `packages/core/package.json`.
- [ ] Pubblicare (dipende da ADR-0002).
