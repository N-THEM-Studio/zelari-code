# PREP-Design: classificatore argv deterministico (zero LLM)

> **Stato: BOZZA in vault design (`.zelari/docs/`)** — ipotesi di design, NON prodotto.
> Task durevole collegato: "Classificatore argv deterministico condiviso" in `.zelari/plan.json`.

## Goal
Una funzione pura condivisa che classifica un comando in tier di safety **senza LLM**, riusata da blocklist / destructive / resourceClaims invece di tre insiemi di regex indipendenti su stringhe grezze.

## Modello di riferimento (già in repo)
`packages/core/src/memory/relevantWhen.ts` — regex + template, funzione pura, zero LLM.
È lo stesso pattern dei memory triggers (matching situazionale deterministico), applicato ai comandi.

## Stato attuale (verificato 2026-09-21)
- `bash` spawna `shell -c` senza introspezione (`packages/core/src/core/tools/builtin/shell.ts` ~121-141).
- `exec_process` ha `program + args[]` strutturati ma li ri-giunge in stringa per le regex.
- Blocklist: 13 regex, primo match. Destructive: 9 regex (`src/cli/safety/destructiveCommands.ts`), primo match.
- Unico tokenizer vero: `src/cli/safety/resourceClaims.ts` ~134-209 — dichiaratamente *"BEST-EFFORT, deliberately not a shell parser"*.

## Design

### Input/Output
```ts
type ArgvTier = 'safe' | 'review' | 'destructive' | 'blocked';
classifyArgv(program: string, args: readonly string[]): { tier: ArgvTier; reasons: string[] }
```
Pura, sincrona, senza I/O. Per `bash -c "raw string"`: fallback al tokenizer best-effort su stringa (come oggi), MAI un parser shell completo.

### Estensione tokenizer
Estendere il tokenizer esistente in `resourceClaims.ts` (condividerlo, non duplicarlo): split rispettando quote semplici, escape backslash di base, operatori `&&` / `;` / `|` come separatori di segmento. Ogni segmento viene classificato da solo; il verdetto finale è il max per severità.

### Regole flag-aware (esempi, da raffinare in implementazione)
- `rm` → review; `rm -r|-rf` con target fuori workspace → destructive
- `git push` → review; `--force` / `--force-with-lease` senza upstream esplicito → destructive
- `npm publish` / `npm unpublish` → destructive
- pattern `curl … | sh` → blocked
- `mv`/`cp` con target fuori workspace → review
- allowlist read-only notevoli (`ls`, `cat`, `git status|diff|log`) → safe (fast path, zero regex)

### Wiring (3 punti)
1. `shell.ts` builtin: `classifyArgv` sulla command string tokenizzata.
2. Claim extraction (`resourceClaims` / gate permessi): il tier alimenta il default `ask` nei layer.
3. Blocklist/destructive regex esistenti: declassate a fallback di compatibilità (non rimosse nella prima slice).

## Out of scope
Parser shell completo; nuove dipendenze (convenzione repo: std lib); qualsiasi chiamata LLM; modifica della semantica di `intersectEffects`.

## Acceptance
- [ ] ≥30 test tabellari (flag, path dentro/fuori workspace, pipe grezze, quote).
- [ ] Determinismo: stesso input → stesso output (property test con seed fisso, se praticabile senza nuove dep).
- [ ] Wiring nei 3 punti sopra; regex legacy come fallback con test di non-regressione.
- [ ] `npm run typecheck` exit 0 + suite `src/cli/safety` verde.
