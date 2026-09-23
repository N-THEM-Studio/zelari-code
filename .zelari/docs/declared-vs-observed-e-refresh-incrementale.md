# Declared vs Observed & Refresh Incrementale (t56–t63)

> Status: **implementato** (t56–t63, 2026-09). Questo documento persistentesce il design della serie dopo che la write in fase PLAN era bloccata dalla jail MCP.

## Problema

Il piano (`.zelari/plan.json`) dichiarava **cosa** un task avrebbe toccato (`fileRefs` solo in `tags` + body md) ma nulla verificava **cosa** era stato toccato davvero. Un task completato i cui file dichiarati venivano modificati da una sessione successiva restava "done" per sempre: nessun segnale, né nella CLI né nel Desktop. In parallelo, il pannello Project del Desktop ricaricava `plan.json` solo su switch workspace, focus finestra o fine run: le mutazioni out-of-band (CLI council a finestra sfocata) restavano invisibili fino al ritorno dell'utente.

## Serie t56–t63

| Task | Deliberazione | Implementazione |
|---|---|---|
| t56 | Modello task: `files` (globs root-relativi, cap 32×260), `completedAt` set-once, `flags: reopened\|stale\|overlap` | `src/cli/workspace/planStore.ts` (`normalizePlanTaskFiles`), `src/cli/tools/planTaskTools.ts` (Zod + alias council `fileRefs`), `src/cli/workspace/stubs.ts` (copia `fileRefs`→`files`), `PlanFrontmatter.files` |
| t57 | Seam post-result in-process in core: `ToolRegistry.setToolResultListener(fn\|null)` — sync, fail-open, niente protocollo JSON hooks (ADR 0022 intatto) | `packages/core/src/core/tools/registry.ts` + fix early-return truncate che saltava il Post hook sui success string |
| t58 | TaskTouchGuard: write mutating su glob di un task `completed` dopo la sua `completedAt` → flag `reopened` + radio `task_reopened` (1/task/sessione, regola cross-session `sessionStartedAt > completedAt`) | `src/cli/workspace/taskTouchGuard.ts`, wiring unico in `createBuiltinToolRegistry` (TUI+headless) |
| t59 | Staleness advisory: commit successivi al `completedAt` sui pathspec dichiarati (soglia 24h, `ZELARI_TASK_STALE_HOURS`) → flag `stale` + radio `task_stale`, sweep fire-and-forget a session start | `src/cli/workspace/taskStaleness.ts`, `gitLogSince` in `src/cli/gitOps.ts` |
| t60 | Overlap advisory: globs intersecanti con task `in_progress` su create/update → flag `overlap` + radio `task_overlap`, **mai blocca** | `src/cli/workspace/taskOverlap.ts` (glob∩glob via vocabolario `matchTaskFiles`) |
| t61 | `ReadProjectTextDto.mtimeMs` + `readProjectTextIfChanged` + cache firma nei poller (WorkbenchLiveTail, KrakenGraphVisualizer, PlanReviewPanel, workspacePlan) — stessa reference array → bail-out React | `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/agentClient.ts` + 4 componenti |
| t62 | Badge Desktop: `BrainTaskPayload.flags`/`notes`; il task completed risorge nel panel solo con `reopened`/`stale` (badge ⚠︎/⧗); `overlap` advisory non resuscita | `packages/core/src/shared/events.ts`, `planTaskTools.toTaskPayload`, `workspacePlan.brainTaskToLive`, `LiveTasksPanel.tsx` |
| t63 | Watcher backend su `.zelari/plan.json` → evento Tauri `plan-changed` → App.tsx ricarica i project task; copre le mutazioni out-of-band a finestra sfocata | comando `watch_plan_changes` (thread std-only, dedup per workspace canonico, poll firma mtime+size 1200ms, baseline senza emit, payload = cwd originale), listener fail-open in `App.tsx` |

## Regole chiave

- **Advisory-only ovunque** (ADR 0023): flag e radio segnalano, mai bloccano il tool result.
- **Fail-open**: guard/staleness/watcher non possono rompere un turno; ogni errore è silenzioso o logged.
- **Vocabolario glob condiviso** (`matchTaskFiles`): path esatto, subtree `dir`/`dir/...`, suffisso `*.ext`; esclusioni `.zelari/node_modules/dist/build`. Stessa semantica per reopened, stale, overlap.
- **completedAt set-once**: la prima transizione a completed vince; reopen + ri-completamento non lo toccano.
- **Cache/indici derivati futuri** in `~/.zelari-code/cache/<repoHash>/` (getZelariHome, `src/cli/companion/config.ts`), MAI in `.zelari/` — il repo resta dichiarativo + append-only.
- **NON estendere l'SSE companion per il Desktop**: il canale phone/PWA remoto per-run (Bearer) non ha alcun EventSource in `apps/`; il refresh Desktop passa dall'evento Tauri interno.

## Contratto evento `plan-changed` (t63)

- Emit: solo dal watcher backend, solo su cambio firma osservato dopo la baseline; payload `{cwd}` con il cwd **originale** passato dal frontend (non il canonico `\\?\` di Windows).
- Frontend: `App.tsx` arma il watcher per l'activeCwd e ricarica `workspaceTasksByCwd[cwd]` sull'evento; il focus guard resta come fallback.
