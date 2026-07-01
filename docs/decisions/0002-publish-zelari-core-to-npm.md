# ADR-0002: Pubblicazione di `@zelari/core` su npm

- **Stato:** Proposto
- **Data:** 2026-07-02
- **Autore:** MiniMax-M3 (proposta) / Andrea (decisione)
- **Sostituisce:** —
- **Dipende da:** [ADR-0001](0001-monorepo-for-zelari-core.md)

## Contesto

Il refactor v0.5.0 ha estratto `AgentHarness`, `ToolRegistry`, il council
multi-agente, le skills built-in e la tipologia condivisa in un package
`@zelari/core` interno (via npm workspaces). Il package esiste ma non è
ancora pubblicato: nessun consumatore esterno può `npm install
@zelari/core`.

`zelari-code` (CLI) è oggi l'unico consumer, ma il valore del refactor
sta nella **pubblicabilità**: se il core è consumabile da altri frontend
(una futura GUI in Tauri, integrazioni in VS Code, agenti in altri
tool), la base utenti del core si moltiplica senza sforzo di
re-implementazione.

## Decisione

**Pubblichiamo `@zelari/core` su npm registry pubblico sotto lo scope
`@zelari/`, versione iniziale `0.5.0` (allineata alla release del
CLI). Accesso: nessun token personale dell'Andrea nel repo — uso di
**npm Trusted Publishing via GitHub Actions** (OIDC, senza secret
store manuale).

### Dettagli operativi

1. **Registry:** npmjs.org pubblico (no scope privato a pagamento).
2. **Autenticazione CI:** npm Trusted Publishing — leghiamo il package
   npm all'azione GitHub `N-THEM-Studio/zelari-code/.github/workflows/release.yml`
   tramite `id-token: write` + configurazione `npm-publish` trust su
   npmjs.org. **Nessun `NPM_TOKEN` secret** salvato in GitHub.
3. **Visibility:** package pubblico subito (lo scopo è adozione, non
   monetizzazione).
4. **License:** `SEE LICENSE IN LICENSE` (consistente con il repo —
   verifica con Andrea se va cambiata per il package pubblicato).
5. **Repository field:** punta a `github.com/N-THEM-Studio/zelari-code`
   con `directory: packages/core`.

### Workflow release

```
git tag v0.5.0 → CI → build packages/core → npm publish --workspace packages/core --tag latest
```

Il workflow fallisce se:
- typecheck o test falliscono
- agy audit agy restituisce CRIT/HIGH
- esiste già una versione uguale su npm (impossibile per design)

## Alternative considerate

- **Repo separato (`N-THEM-Studio/zelari-core`)** — scartato per ADR-0001:
  singolo team, versioning accoppiato nella fase iniziale, doppio
  overhead di release management non giustificato.
- **GitHub Packages (`@N-THEM-Studio/core`)** — scartato: visibilità
  inferiore su `npm search`, npm CLI non lo dà gratis nel flusso
  mentale utente.
- **Privato a pagamento** — scartato: lo scopo è adozione.
- **Solo CLI monolitico, niente package** — scartato: vanifica il
  refactor già fatto.

## Conseguenze

**Positive**
- `@zelari/core` diventa riusabile da terze parti (TS tool, altri CLI,
  integrazioni).
- npm Trusted Publishing rimuove il rischio di `NPM_TOKEN` leak.
- Onboarding nuovi contributor semplificato (npm standard).

**Negative / rischi**
- Pubblicare un package vincola a una **API stability promise**
  (vedi ADR-0004).
- Bug in `@zelari/core` vengono ora vissuti anche da terze parti
  ignari del CLI.
- License va chiarita prima del publish (decisione di Andrea).

## TODO

- [ ] Andrea decide: license del package (riusa `SEE LICENSE IN LICENSE` o
      passa a MIT/Apache-2.0 per attrattiva esterna?)
- [ ] Configurare npm Trusted Publishing (post-merge di questo ADR).
- [ ] Workflow `.github/workflows/release.yml` con publish OIDC.
- [ ] `packages/core/README.md` con esempi d'uso consumatore esterno.
- [ ] `packages/core/CHANGELOG.md` con storia releases (a partire da v0.5.0).
