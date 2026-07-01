# ADR-0003: Schema di versionamento per monorepo zelari-code

- **Stato:** Proposto
- **Data:** 2026-07-02
- **Autore:** MiniMax-M3 (proposta) / Andrea (decisione)
- **Dipende da:** [ADR-0001](0001-monorepo-for-zelari-core.md),
  [ADR-0002](0002-publish-zelari-core-to-npm.md)

## Contesto

Con il monorepo abbiamo due package distinti:

| Package           | Path            | Chi lo consuma                     |
|-------------------|-----------------|------------------------------------|
| `zelari-code`     | root            | Utenti finali (CLI)                |
| `@zelari/core`    | packages/core   | `zelari-code` + (futuro) terze parti |

Serve una policy: quando bumpa uno, l'altro segue? Versioning
indipendente (= due cicli di release, due CHANGELOG) o accoppiato
(un solo tag git, versione uguale)?

## Decisione

**Versioning accoppiato nella fase v0.5.x, indipendente da v0.6+.**

- v0.5.0 → CLI e core pubblicati entrambi come `0.5.0`, stesso tag
  git `v0.5.0`.
- v0.5.1 → entrambi come `0.5.1`, stesso tag `v0.5.1`.
- Da v0.6.0 in poi: il core pubblica quando ha breaking change o fix
  significativo, il CLI solo quando serve. Tag distinti:
  - `v0.6.0/core` → solo `@zelari/core@0.6.0`
  - `v0.6.0/cli` → solo `zelari-code@0.6.0`
  - `v0.6.0` → entrambi (release congiunta)

### Schema versioning semantico

- `MAJOR` (X.0.0) → breaking change API pubblica del core o cambio UX
  radicale del CLI.
- `MINOR` (0.X.0) → nuova funzionalità, backward-compat.
- `PATCH` (0.0.X) → bug fix, backward-compat.

Pre-1.0 (siamo a `0.X.Y`): ogni MINOR può contenere breaking
changes documentati nel CHANGELOG. Da 1.0 in poi: semver stretto,
MAJOR riservato ai breaking.

### Pragmatismo nel periodo `0.5.x`

Perché accoppiato all'inizio:
- Single team, single release window, niente overhead.
- Tag unico è banale: `git tag v0.5.0 && git push --tags → CI fa
  tutto`.
- Cambiare in indipendente in v0.6 è un'operazione locale (tag scheme
  + workflow branching), non costa nulla.

## Alternative considerate

- **Indipendente da subito** — raddoppia l'overhead di release (due
  PRs, due changelog, due publish) per una flessibilità che non
  usiamo ancora.
- **Monolitico forever (CLI = versione del core)** — funziona finché
  il core non ha vita propria; dopo l'estrazione in @zelari/core
  sarebbe incoerente.
- **CalVer (YY.MM.PATCH)** — attraente ma rompe la mentalità
  semantica del team; in letteratura open-source npm è dominato da
  semver.
- **Changesets-style (vendore un changeset per release)** —
  interessante per scaling a 5+ package; overkill per 2 package.

## Conseguenze

**Positive**
- v0.5.x ship semplice, prevedibile.
- Migration path chiaro: da 0.6 ognuno va per i fatti suoi.
- Un solo CHANGELOG (`/CHANGELOG.md`) per ora, con sezioni per
  package. Split in due quando serve.

**Negative / rischi**
- Versioning accoppiato è anti-pattern per npm a lungo andare
  (consumer del core non vuole riscaricare patch del CLI).
- Dovremo ricordarci di splittare a 0.6, altrimenti diventa
  debito culturale.

## TODO

- [ ] Andrea conferma: si parte accoppiato, si splitta a 0.6?
- [ ] Setup CI matrix in `.github/workflows/release.yml`:
      detection automatico di quale package è cambiato nel diff
      tra tag.
- [ ] `CHANGELOG.md` con sezioni `## @zelari/core` e `## zelari-code`.
