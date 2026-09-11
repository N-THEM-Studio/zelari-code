# Handoff — experimental/cursor-learn

WIP del furto Cursor Projects (auto-learn / coordinatore persistente / gardening).
**Non mergiare su `main`.** Branch di lavoro per continuare da un’altra macchina.
Nessuna PR: la CI GitHub parte su `pull_request` e su `push` a `main`.

Flag: `ZELARI_PROMOTE_OPS_KNOWLEDGE` **default-off**. Nessun dump in `AGENTS.MD`.
Niente cloud-fleet, niente auto-merge.

## Su disco in questo branch

### Fase 1 — Auto-learn
- `src/cli/memory/opsKnowledge.ts` + `.test.ts` — `procedure` da strict PASS (`deterministic-engine`, tier `command-output`/`fs-observation`, `seq` definito). Dedup `(command, digest, criterionId)`.
- Wiring: `src/cli/headless/runOneTurn.ts` (`writeProofSafe`) e `src/cli/hooks/useChatTurn.ts`.
- `src/cli/memory/promotion.ts` — `meetsPromoteThreshold` (`importance ≥ 0.7` e `confidence ≥ 0.8`, oppure `metadata.verified` / edge `validated_by`). Reject `reason: 'below-threshold'`.
- `src/cli/kraken/executor.ts` — dopo `consolidate()`, `formatPromoteNotice` via radio. **Nessuna** write su `AGENTS.MD`.
- `src/cli/memory/repeatFailure.ts` — fingerprint `sha256(cmd\\0exit\\digest)`; 2° fail identico → candidato `constraint`.

### Fase 2 — Coordinatore persistente (parziale)
- Desktop: `RunTaskArgs.resumeMission` (`apps/desktop/src/types.ts`) → Rust `resume_mission` (`apps/desktop/src-tauri/src/lib.rs`) → turn field `resumeMission`.
- `agentClient.runTask` passa l’intero `RunTaskArgs` a Tauri: **non** serve un campo extra nel client.
- Live Tasks pill + Riprendi: `LiveTasksPanel.tsx`, `missionState.ts`, `missionStateIo.ts`.
- Auto-resume follow-up: `App.tsx` `send()` se `mode === 'zelari'` e missione non-`success` e c’è già un messaggio user (primo prompt escluso). Helper: `shouldAutoResumeMission` / `autoResumeHint` in `missionState.ts`.

### Fase 3 — Gardening
- `scripts/zelari-gardener.sh` — trigger: test rossi / HEAD ≠ `.zelari/gardener.last-sha` / task aperti in `plan.json`. Azione: `--once --mode zelari --phase plan`.
- `docs/triggers.md` — sezione gardener.
- Git hook: `ZELARI_HOOK_PHASE` default **già** `plan` (`scripts/zelari-git-hook.mjs`). `build` resta opt-in.

## Mancante — riprendere da qui

### 2.3 TUI `/resume-mission` (non fatto)
- Dispatcher in `src/cli/slashHandlers/` (non esiste ancora uno slash missione).
- Stesso contratto di `--resume-mission` / `resumeZelariMission` in `src/cli/zelariMission.ts`.
- Help in `src/cli/main.ts` e `docs/GUIDA.md`.

### 2.4 resto
- `autoResumeHint` esiste ma **non** è cablato sotto l’input composer Desktop (hint visibile tipo “Confermi l’avvio?”).
- `apps/desktop/src/liveTasks/missionState.test.ts` scritto, **non** ritestato in CI.

### 1.4 / 4 / 5 / 6 — fuori v1 di questo branch
- 1.4 playbook `.zelari/how-we-test.md` dalle `procedure` verificate.
- Fase 4 migration runner (`brief.kind = 'migration'`).
- Fase 5 evidence pack UI (Workbench / Live Tasks).
- Fase 6 daemon/VPS — **non fare** (ADR-0014).

## Come verificare (sull’altra macchina)

```bash
git fetch origin experimental/cursor-learn
git checkout experimental/cursor-learn

npx vitest run src/cli/memory/opsKnowledge.test.ts src/cli/memory/promotion.test.ts tests/unit/cli-memoryCommands.test.ts
npx vitest run apps/desktop/src/liveTasks/missionState.test.ts
# LiveTasksPanel: 8 test (se il path del file di test esiste nel tree Desktop)
```

Ops-knowledge non scrive finché `ZELARI_PROMOTE_OPS_KNOWLEDGE` non è `1`/`true`/`on`.

## Non committare
- File spazzatura `{if(!ok)fails.push(what)` (artefatto vuoto in root) — lasciato untracked.
