# Council reliable verification architecture (v0.9.x)

> **Goal:** ottenere output verificato e affidabile dal council su progetti **reali multi-file**, non solo sul caso mono-file TESTMCP. Il caso TESTMCP (index.html senza build) è il fixture di regressione minimo; serve anche un fixture multi-file con build.

## Problema

Il gate di verifica v0.8.0 assume "Lucifero implementa → poi lo si verifica" e usa check regex su misura (motion/CSS). Nella realtà:

1. In implementation mode il **primo specialista (Caronte) implementa** subito; ogni membro edita lo stesso file → caos multi-writer, violazioni che si accumulano tra i turni.
2. Il segnale di "done" viene dal **testo del modello**, non da una verità deterministica.
3. I check sono **specifici al dominio HTML/CSS** → non scalano ad altri linguaggi/progetti.
4. Il micro-gate è agganciato **solo alle write del chairman** → riporta le violazioni di Caronte tardi, ripetute, mislabeled come `[error]`, e senza correggerle. `luciferWriteCount === 0` → falso `DEGRADED_RUN`.

## Principio

**La verità deterministica la dà il progetto, non il modello.** Su un progetto reale il segnale affidabile è il suo stesso build system (`tsc`/`test`/`lint`/`build`) eseguito sul diff — non un regex custom. Effettività a scala = **un solo implementer** + **verifica scoped sul diff** + **loop di fix limitato**.

## Architettura target

```
DESIGN (council 6 = ampiezza)     → plan.json + nfr-spec (artefatti)
      ↓
IMPLEMENT (UN solo implementer)    → Lucifero scrive; specialisti READ-ONLY (advisor)
      ↓
GATE deterministico (ground truth):
   1. projectSmoke: typecheck/test/build       ← PRIMARIO, scala a qualsiasi progetto
   2. domain-check (motion/NFR regex)           ← opzionale: solo se nfr-spec lo chiede o non c'è build
      ↓ FAIL → inietta l'output GREZZO del fallimento → turno di fix mirato (≤2–3) → ri-gate
      ↓ PASS
VERIFIED = gate PASS (non il testo della sintesi). readyToCommit guidato dal gate.
```

Unità di lavoro su progetti grandi = **il plan-task** (fasi/task che Nettuno produce), non "tutto in un turno": diff piccoli, gate veloce, fix loop trattabile.

## Increment (ordine di merge)

### Increment 1 — Specialisti read-only, Lucifero unico implementer  ← QUESTO PR
**File:** `packages/core/src/council/modeBanners.ts`, `packages/core/src/agents/councilApi.ts`, `tests/unit/`.
- `councilModeBanner(runMode, { isImplementer })`: banner advisor ("analizza/pianifica, NON scrivere file") vs implementer ("sei tu che implementi").
- `restrictImplementationWrites(toolNames, { runMode, isImplementer })`: rimuove `write_file`/`edit_file` dai non-implementer in implementation mode (gli specialisti ereditano write via skill — va filtrato sul risultato di `computeAgentTools`).
- Applica il filtro agli specialisti; il chairman mantiene i write.
- Effetto collaterale: `luciferWriteCount` torna reale → **elimina il falso DEGRADED_RUN** senza toccare la detection.

### Increment 2 — Gate primario = projectSmoke, domain-check opzionale
- Elevare `runProjectSmoke` (già in `src/cli/workspace/projectSmoke.ts`) a check principale post-implementazione; i check regex diventano attivi solo se `nfr-spec` li richiede o non c'è build.
- `readyToCommit`/`verified` derivano dal PASS del gate, non dal claim.

### Increment 3 — De-noise del micro-gate
- Emissione warning UNA volta, `severity:'warn'` (non `console.warn` + evento `error`), deduplicata; niente ri-scan a ogni write.

### Increment 4 — Fix loop col fallimento grezzo
- Su gate FAIL, inietta l'output vero (tsc/test/violazioni) in un turno di fix mirato dell'implementer; riusa `applyRetryIfMissing`; cap 2–3.

### Increment 5 — createNfrSpec schema + fixture multi-file
- Dare a `createNfrSpec` un parameter schema reale (oggi `parameters: []` → skippato).
- Aggiungere un fixture di regressione multi-file con `package.json` + build, oltre a TESTMCP.

## Verifica end-to-end
- `npm run typecheck` + `npx vitest run` verdi.
- Test nuovi: banner per ruolo, `restrictImplementationWrites`, e (increment successivi) smoke-as-primary, dedup warning, fix loop.
- Replay TESTMCP: nessun falso DEGRADED quando Lucifero implementa; su un fixture con build, il gate riflette il PASS/FAIL reale del build.
