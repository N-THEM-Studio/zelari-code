# Dependency security triage — 2.0.0-alpha.7 (Exit-3, piano F12)

> Fotografia firmata richiesta dal documento di stato §15 prima di una RC:
> `alerts → triage → runtime vs dev-only → reachable vs non-reachable → upgrade / mitigate / documented accept`.

**Ambito:** root workspace `zelari-code@2.0.0-alpha.7` (CLI + `@zelari/core`; desktop/companion hanno manifest propri e Dependabot dedicato).
**Ambiente di rilevazione:** `npm audit` (npm 11.6.2, Node v24.13.0, Windows) su lockfile allineato.
**Pipeline alert continua:** `.github/dependabot.yml` (npm root `/`, npm `/packages/core`, npm `/apps/desktop`, cargo `/apps/desktop/src-tauri`, github-actions `/`; security updates raggruppate, cadence settimanale).

## Snapshot al rilevamento (BEFORE)

`npm audit`: **3 pacchetti vulnerabili (high), 0 critical** — tutti **indiretti**, tutti con fix disponibile non-forzato.

| Pacchetto | Versione | Severità | Advisory (GHSA) | Catena di dipendenza | Ship class |
|---|---|---|---|---|---|
| `nanoid` | 3.3.15 | high (2×) | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8 (CWE-835, loop infinito con size negativa/zero, CVSS 5.9) | `vitest → vite 5.4.21 → postcss 8.5.16 → nanoid` | **dev-only** |
| `postcss` | 8.5.16 | high | GHSA-r28c-9q8g-f849 (CWE-22, path traversal `sourceMappingURL` → disclosure `.map`, CVSS 7.5) + GHSA-fxqj-rqcc-2cmp (moderate, fix incompleto della precedente) | `vitest → vite 5.4.21 → postcss` | **dev-only** |
| `undici` | 7.28.0 | high | GHSA-4cwx-7wf7-3272 (CWE-200, cross-user disclosure via cache directives, CVSS 7.4) + 4 moderate: desync retry (GHSA-8xcm-r25x-g524), CRLF injection (GHSA-m8rv-5g2x-5cg5), cache-control whitespace (GHSA-jr45-8vmc-qm54), cookie injection (GHSA-v3r7-h72x-cjcm) — range unico `>=7.0.0 <7.29.0` | `jsdom 29.1.1 → undici` (devDep, ambiente test React/ink) | **dev-only** |

## Triage

### Runtime vs dev-only

Dipendenze **runtime** del pacchetto spedito (`zelari-code` `dependencies`): `ink`, `ink-text-input`, `react`, `typescript`, `zod` — **zero alert** su di esse e sulla loro subtree.
Tutti e tre i pacchetti vulnerabili vivono in catene **dev-only** (vitest/vite/postcss/nanoid per il test runner; jsdom/undici per l'ambiente di test DOM).

### Reachability nel prodotto

`scripts/bundle-cli.mjs` bundleizza solo `src/cli/main.ts` con external `react`/`ink`/`ws`/`typescript`/`playwright`: nessuno dei tre pacchetti è importato dal codice prodotto CLI/core, quindi **nessuno entra nel bundle né nel pacchetto npm** pubblicato. L'esposizione pratica è limitata alla macchina di sviluppo/CI (es. `undici` in jsdom esegue solo durante i test; `postcss`/`nanoid` girano solo dentro vitest/vite).

### Azione

Tutti i fix erano bump transitivi **semver-compatibili** → applicati con `npm audit fix` (senza `--force`):

| Pacchetto | Before → After | Esito |
|---|---|---|
| `nanoid` | 3.3.15 → **3.3.18** | ✅ upgraded |
| `postcss` | 8.5.16 → **8.5.26** | ✅ upgraded |
| `undici` | 7.28.0 → **7.29.0** | ✅ upgraded |

**AFTER: `found 0 vulnerabilities`.** Nessun `documented accept` residuo per il root workspace a questa versione.

## Finding di processo (chiuso in questo task)

`node_modules` locale era **stale** rispetto a `package.json`/lockfile: vitest installato 2.1.9 contro `^4.1.9` dichiarato (bump mai reinstallato localmente). Conseguenze: i run locali giravano su vitest 2 mentre la CI (`npm ci`) avrebbe usato vitest 4, e **52 file di test in `tests/unit/` erano invisibili ai run locali** (la suite locale mostrava 2901 test; quella reale è 3451).

Il resync di `npm audit fix` ha ripristinato la parità. Verifica post-resync su vitest 4.1.9:

- suite completa → **341 file / 3451 test pass** (2 aggiustamenti di timeout cold-start resi necessari dal carico parallelo maggiore: `tests/unit/cli-toolDisplay.test.ts` primo-importatore react+ink → 30s; `src/cli/headlessE2eSession.test.ts` catena kraken → 90s, in isolamento il file gira in ~11s)
- `tsc --noEmit` → exit 0
- `npm audit` → 0 vulnerabilities

**Regola per la RC:** ogni bump di devDependency majeur (vitest/jsdom) va verificato con un run completo post-install (`npm ci && npm test`) prima del commit del lockfile — il drift silenzioso è il rischio reale, non i singoli advisory dev-only.

## Firma

- Prodotto: `zelari-code@2.0.0-alpha.7` / `@zelari/core@2.0.0-alpha.7`
- Strumento: `npm audit` (npm 11.6.2, Node v24.13.0)
- Stato post-azione: 0 vulnerabilities (root workspace), suite 3451/3451 verde su vitest 4.1.9
- Commit di riferimento: questo documento viene committato insieme al lockfile aggiornato (task F12, piano Alpha.8/Exit-3)
- Prossima revisione: a ogni nuova alert Dependabot (flow settimanale) e obbligatoriamente al gate RC
