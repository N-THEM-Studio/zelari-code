# ADR-0007: Independent pre-release audit (agy) as workflow gate

- **Status:** ✅ Accettato
- **Date:** 2026-07-02
- **Deciders:** Andrea, Hermes
- **Related:** ADR-0006 (Lucifero chairman), zelari-code v0.6.0

## Context

v0.6.0 di zelari-code ha rilasciato il chairman reale della council (Lucifero) con 759/759 test verdi, typecheck pulito, build OK. Tuttavia un audit indipendente di 6 minuti con `agy` (Gemini 3.5 Flash, file `/tmp/audit-v060-prompt.md`) ha trovato **4 bug runtime** che i test non coprivano:

| # | Sev | Sintomo |
|---|---|---|
| 1 | HIGH | Il `catch` del chairman sovrascrive `fullText` → fallback `[Chairman synthesis failed: ...]` non rende MAI |
| 2 | HIGH | `openaiCompatibleProvider` usa `config.signal` invece di `params.signal` → `cancel()` non abortisce HTTP |
| 3 | HIGH | `openaiCompatibleProvider` usa `config.model` invece di `params.model` → `agentModels` config rotto silenziosamente |
| 4 | HIGH | Specialist/oracle loop non rilevano `error` event → `errored=false` su fallimento rete |

Tutti bug reali, tutti verificati uno per uno prima del fix (riproducibili con test mirati). Tutti fixati in v0.6.0 → 761/761 test.

## Decision

**Trattare l'audit agy come workflow gate obbligatorio prima di "done" su release non-triviali** di zelari-code (e applicabile a qualsiasi progetto).

Cosa questo significa in pratica:

1. **Quando serve l'audit:**
   - ✅ Release con nuovo behavior (Lucifero chairman, wizard, monorepo, ...)
   - ✅ Refactor di >500 LOC (god-module split, hook extraction, ...)
   - ✅ Nuova abstraction layer (council, headless, AgentHarness, ...)
   - ❌ Skip per: bug fix triviale (1 riga), pure docs, dependency bump

2. **Processo (6 step):**
   1. Scrivere prompt strutturato in `/tmp/audit-<release>-prompt.md` (working dir, branch+sha, contesto, aree da audire, formato atteso, time budget)
   2. Spawn agy in background: `agy --print --print-timeout 30m --dangerously-skip-permissions --add-dir <project> --model "Gemini 3.5 Flash (Medium)" < /tmp/prompt.md > /tmp/log 2>&1`
   3. Monitorare `wc -l /tmp/log` ogni 30-60s per 3 minuti (vedi antigravity-cli pitfall #23: agy può stallare in plan-stage)
   4. Se agy sta producendo → attendere
   5. Se agy stalla o fallisce → fallback manuale (read_file + search_files, 5-10 min)
   6. Triage finding: CRITICAL+HIGH fix + regression test, MEDIUM fix o defer motivato, LOW defer a backlog

3. **Triage discipline (vedi `references/pre-release-audit-pattern.md`):**
   - Verificare ogni finding: riprodurre, controllare git blame, cercare guard mancanti, false positive patterns
   - Non accettare finding alla cieca (l'agy può avere hallucinations o misread del codice)
   - Per ogni fix: scrivere regression test PRIMA, applicare fix, verificare che test passi + tutto verde
   - Commit message strutturato: `fix(vX.Y.Z): independent audit (agy) found N runtime bugs`

4. **Tooling:**
   - `agy` CLI (Google Antigravity, modello Gemini 3.5 Flash) — preferito
   - Fallback: `claude-code` con Sonnet/Opus (più lento, ma profondità)
   - Output: log su `/tmp/agy-audit-<release>.log`

## Alternative valutate

### A) Nessun audit, solo test (status quo pre-v0.6.0)
- ✅ Veloce, niente overhead
- ❌ I 4 HIGH trovati dall'audit sarebbero shippati in produzione silenziosamente
- ❌ Bug 1 (catch overwrite) → fallback chairman INUTILE (mai rende)
- ❌ Bug 2 (signal) → HTTP request leaks in caso di cancel (risorse sprecate)
- ❌ Bug 3 (model override) → `agentModels` config INUTILE (utenti pagano per modello che non viene usato)
- ❌ Bug 4 (errored=false) → metriche cost corrotte (utenti non vedono mai i fallimenti)
- **Rifiutata**: il costo del bug in produzione >> overhead dell'audit

### B) Audit solo per release major (x.0.0)
- ✅ Meno overhead
- ❌ 4 HIGH tutti su 0.6.0 (minor release di feature)
- ❌ Avrebbe richiesto 6 mesi di attesa per scoprirli
- **Rifiutata**: i bug non aspettano le release major

### C) Pair review con umano (Andrea fa review manuale)
- ✅ Massimo controllo
- ❌ Tempo: ~1h per review esaustiva di un chairman loop da 110 righe + dintorni
- ❌ Non scalabile (rilasci frequenti)
- ❌ Stessi blind spot (gli umani leggono il codice con il modello mentale dell'autore)
- **Rifiutata** come sostituto, **adottata** come complemento (agy + sanity check umano sui HIGH)

## Consequences

### Positive

- **Cattura bug che sfuggono ai test.** 4 HIGH su v0.6.0 che 759 test verdi non avevano trovato. Pattern osservato: bug si nascondono in branch non esercitati dai test (qui: catch path del chairman, signal abort, error event in provider stream).
- **Disciplina di verifica.** Costringe l'agent a verificare ogni finding con riproduzione + git blame, evitando fix affrettati.
- **Documentazione di edge case.** I commenti `// v0.6.0 audit HIGH-N` rimangono nel codice come annotazione storica per futuri contributor.
- **Confidence boost.** Release con audit agy + tutti i test verdi ha un livello di fiducia diverso da release senza audit.

### Negative

- **Overhead 6-10 min per release.** Spawn agy + monitoring + triage + fix + regression test.
- **Rischio agy hallucination.** Trovato 1 caso: finding 3 si è rivelato reale ma l'analisi di agy sul perché era imprecisa. Mitigato dalla verifica manuale.
- **Audit può stallare.** Pitfall #23 documenta: agy può bloccarsi in plan-stage per 5+ minuti prima di abortire. Serve monitoring + fallback manuale.
- **Costo modello.** Gemini 3.5 Flash è economico, ma se l'audit diventa prassi, accumula.

### Neutral

- **Non sostituisce i test.** L'audit trova bug, i test prevengono regressioni. Entrambi servono.
- **Non sostituisce la review umana.** L'audit è un filtro, non un gate finale. Per release critiche (monorepo publish, breaking change), serve ancora review umana esplicita.

## Related

- Skill `antigravity-cli` (`~/.hermes/skills/autonomous-ai-agents/antigravity-cli/SKILL.md`)
- `references/pre-release-audit-pattern.md` — pattern completo con case study zelari-code v0.4.2
- `templates/two-pass-fix-prompt.md` — template per Pass 2 fix dopo audit
- zelari-code v0.4.2 case study: 5 bug trovati in 30 min su release con 679/679 verdi

## Update log

- 2026-07-02: v0.6.0 → 4 HIGH trovati e fixati, workflow gate adottato ufficialmente
