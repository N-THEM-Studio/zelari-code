# HANDOFF — Kraken super-agent (WIP su main)

> Snapshot post-push del lavoro **Kraken** (rename `agent` → `kraken` + tentacoli).
> Non è una release versionata: `package.json` resta **1.25.0**; le note vivono in `CHANGELOG` → `[Unreleased]`.

## Cosa è incluso in questo push

### Identity / mode
- Mode canonico **`kraken`** (alias legacy `agent` / `single` ancora accettati).
- Cycle TUI: `kraken` → `council` → `zelari` (`shift+tab` / `/mode`).
- Label mission build: **`build@kraken`** (env legacy `ZELARI_BUILD_VIA_AGENT` invariata).
- Prompt pack: `KRAKEN_IDENTITY_MODULE` + `KRAKEN_LEAD_PLAYBOOK_MODULE` in headless / mission slice.
- Desktop / StatusBar / overlay: label **kraken** al posto di agent.

### Tentacoli (`task`)
- Contratti opzionali `scope[]` + `acceptance[]` sullo schema `task`.
- Cap spawn per turno parent: `ZELARI_KRAKEN_MAX_TASK_SPAWNS` (default 6); `resetTaskSpawnCount()` a inizio turno.
- **K5 model routing**: `src/cli/tools/krakenModel.ts` + wiring lazy in `toolRegistry` / sub-agent context.
- **K8 radio**: `src/cli/tools/krakenRadio.ts` → `.zelari/radio/<session>.jsonl`; slash **`/kraken`** → `formatKrakenRadioStatus`.
- **K7 worktree (parziale)**: crea worktree per `general` se `ZELARI_KRAKEN_WORKTREE=1`, footer path, cleanup se non `KEEP`.
- **K4 verify-hint**: footer dopo `task` general.
- Test: `tests/unit/cli-kraken-slice2.test.ts` (+ aggiornamenti mode/task/headless/prompt).

### Docs
- `CHANGELOG.md` `[Unreleased]`, `README.md` headless/mode, `docs/GUIDA.md` sezione Kraken + tabella mode.

## Cosa manca (gap espliciti)

| ID | Gap | Stato codice | Note |
|----|-----|--------------|------|
| **G1** | **Live tentacle UI (K10)** | `src/cli/tools/krakenLive.ts` **presente ma non importato** da `taskTool` / StatusBar / Desktop | Nessun chip “tentacles running/done” in TUI o Desktop. Cablare `krakenTentacleStart/End` in `taskTool` + props StatusBar + event SSE/Desktop se serve. |
| **G2** | **Worktree auto-merge** | `isKrakenWorktreeAutoMergeEnabled` / merge helpers in `krakenWorktree.ts` **non usati** da `taskTool` | Oggi: worktree → run → cleanup (o KEEP). **Nessun merge** delle modifiche nel tree parent. Con worktree ON senza KEEP le edit del tentacolo possono sparire al cleanup. Priorità alta se si promuove WORKTREE=1. |
| **G3** | **Progress radio mid-run** | Solo eventi `spawn` / `done` / `error` / `verify_hint` | Niente `progress` periodico dal sub-harness. |
| **G4** | **Auto-pick cheap model async** | Heuristic + discovery in `krakenModel.ts` | Verificare path async discovery end-to-end in UI reale; unit test coprono sync/env. |
| **G5** | **Release bump** | Ancora **1.25.0** | Prima di npm publish: bump (es. 1.26.0), spostare Unreleased → sezione data, `npm run build` + test full. |
| **G6** | **P0 plan v0.10 safety** | Fuori scope Kraken | Lifecycle hooks su AgentHarness, folder trust `/trust`, `inspect` unificato — restano backlog `.zelari/plan.json`. |
| **G7** | **Script temp** | `scripts/_kraken_slice3.py`, `scripts/_fix-kraken-docs.py` | Utility one-shot; non parte del prodotto. Escluse dal commit feature se non servono. |

## File nuovi (feature)

- `src/cli/tools/krakenModel.ts`
- `src/cli/tools/krakenRadio.ts`
- `src/cli/tools/krakenWorktree.ts`
- `src/cli/tools/krakenLive.ts` ← **dead code finché G1**
- `tests/unit/cli-kraken-slice2.test.ts`
- `HANDOFF-kraken.md` (questo file)

## Come verificare

```bash
npm run pretest
npx vitest run tests/unit/cli-kraken-slice2.test.ts tests/unit/cli-mode.test.ts tests/unit/cli-taskTool.test.ts
npm run typecheck
# smoke rename
node bin/zelari-code.js --help   # --mode kraken|council|zelari
```

## Prossimi passi consigliati (ordine)

1. **G2** — in `taskTool`, se worktree + success + auto-merge: `mergeKrakenWorktree` (o API equivalente) prima del cleanup; test con repo git temp.
2. **G1** — cablare `krakenLive` in `taskTool` + StatusBar (minimo CLI); Desktop dopo.
3. **G5** — release 1.26.0 quando G2 è verde (o documentare WORKTREE come experimental senza merge).
4. Riprendere P0 safety (hooks / trust / inspect) dal plan v0.10.

## Non committare

- `Screenshot *.png`, `logozelaricode.png`, `index.html.tmp` (artifact locali)
- `.zelari/radio/`, worktrees di test
