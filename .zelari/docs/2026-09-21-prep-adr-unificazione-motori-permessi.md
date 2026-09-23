# PREP-ADR: Unificazione dei motori permessi (bozza pre-implementazione)

> **Stato: BOZZA in vault design (`.zelari/docs/`)** — ipotesi di design, NON prodotto.
> Da promuovere a `docs/decisions/0037-unified-permission-engine.md` via `/council` **prima** di scrivere codice.
> Origine: audit esterno 2026-09-21 + esplorazioni verificate sul tree (v. `.zelari/world/hypothesis.md`).
> Task durevole collegato: "Unificazione motori permessi (ADR prima del codice)" in `.zelari/plan.json`.

## Contesto (verificato sul tree, 2026-09-21)

| | Motore A (WS1/t133) | Motore B (v2.12) |
|---|---|---|
| Entry | `src/cli/safety/permissionGate.ts` (~392 LOC) | `src/cli/safety/policyEngine.ts` (~586 LOC) |
| Supporto | `permissionPolicy.ts`, `permissionRules.ts` | `policyLayers.ts`, `policyLoadMode.ts`, `resourceClaims.ts` |
| Config utente | `.zelari/permissions.json` | `.zelari/policy.json` |
| Sintassi path | `pathPrefix` | glob `match` |
| Fail-mode config malformata | degrada a `ask`, run continua | strict (default headless/CI) → exit 2 |
| Eventi spine | `permission.denied` (via decisionEmit) | **NESSUNO** (solo log `[policy] rule` in toolRegistry) |
| Superficie utente | `/permissions add`, session rules | scoping per-agent, global floor |

Composizione attuale: **restrict-only** (`intersectEffects`, `toolRegistry.ts` ~1367) → non esiste oggi una falla in cui qualcosa di vietato passa. Il rischio reale è: divergenza semantica tra i due engine, UX confusa (due file, due sintassi), osservabilità parziale (i deny di B non finiscono sulla spine).

## Decisione proposta (opzione A — raccomandata)

`policyEngine` (B) diventa l'unico motore; `permissionGate` degrada ad **adapter di migrazione**:

1. **Layer di compat**: lettura `.zelari/permissions.json` → traduzione `pathPrefix`→glob → regole B native; warning di deprecation, finestra 2 minor.
2. **Eventi spine da punto unico**: `permission.denied` emesso solo dal punto di decisione finale (mai dal layer di compat, mai doppi).
3. **Fail-mode unificato**: config utente malformata → degrado a `ask` + warning; exit 2 riservato a policy strict esplicita (headless/CI, documentata).
4. **Una sola sintassi documentata** in `docs/GUIDA.md` + `docs/TOOLS.md`; `MIGRATION.md` documenta la traduzione.

### Alternative scartate
- **B assorbe A senza compat**: rompe gli utenti WS1 esistenti — respinta.
- **A assorbe B**: perde scoping per-agent e global floor; B è più espressivo e più recente — respinta.
- **Solo documentazione dei due motori**: non risolve osservabilità né divergenza — respinta.

## Conseguenze / rischi
- Migrazione config utente (medio) → mitigata da adapter + warning + finestra deprecation.
- Regressione deny-path (alto impatto) → mitigata da matrice test condivisa: stesso comando → stessa decisione, sia con sintassi A tradotta sia B nativa, per tutta la finestra.
- Sforzo stimato: **800–1200 LOC + test**; tocca `toolRegistry.ts` (dispatch caldo) → fare in slice separati con verify dopo ogni slice.

## Dipendenze
- Task "Denial ledger derive-only" va fatto PRIMA (la lettura denials diventa spine-only e non deve dipendere dal motore).

## Acceptance (gate di implementazione)
- [ ] Un solo punto nel tree emette `permission.denied` (grep univoco).
- [ ] Matrice test comando→esito identica tra sintassi A tradotta e B nativa.
- [ ] `.zelari/permissions.json` deprecato ma ancora onorato via adapter (test di traduzione).
- [ ] `npm run typecheck` exit 0 + suite `src/cli/safety` verde.
- [ ] ADR accettato in `docs/decisions/0037-*` + `MIGRATION.md` aggiornata.
