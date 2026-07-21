
- **Stato:** ✅ Accettato (implementato)
- **Data proposta:** 2026-07-20
- **Autore:** Zelari Code (fase PLAN)
- **Ispirazione:** Loop Engineering (rari/@0xwhrrari, giu 2026) — la terza
  frontiera del loop: *"runs while you sleep"* (trigger su cron/evento, non su
  umano); From Loop Engineering to Graph Engineering (Carlos
  Perez/@IntuitMachine, lug 2026).
- **Dipende da:** entry-point headless già completo —
  `runHeadlessZelari` (`src/cli/runHeadless.ts:758`) + dispatch CLI
  (`src/cli/main.ts:205` `pickRootComponent`, flag `--mode zelari`).

## Contesto

La missione Zelari ha oggi **tre trigger, tutti manuali**:

| Trigger | Dove | Tipo |
|---|---|---|
| `/zelari` | slash command (TUI) | manuale, interattivo |
| `--mode zelari` | `main.ts:327` flag CLI | manuale, batch |
| Shift+Tab | TUI toggle | manuale, interattivo |

L'entry point per girare **senza umano** esiste già ed è completo:

```
zelari-code --headless --mode zelari --task "fix the failing test in auth.ts"
```

avvia `runHeadlessZelari` → `runZelariMission` (`zelariMission.ts:200`) senza
montare la TUI. Quindi **il loop è già automatabile**: manca solo lo *strato di
trigger* sopra di esso (chi lo lancia, quando, e come evitare sovrapposizioni).

Loop Engineering (rari) è esplicito: il salto da "tool" a "teammate" è il loop
**event-driven** — attivato da cron, da una PR aperta, da un test rosso, da un
file cambiato — non da un Enter umano. Oggi l'unico modo di avviare un loop in
background è una shell ad-hoc: nessun supporto nativo per scheduling, dedup,
lock, o persistenza del trigger.

## Decisione

Aggiungere uno **strato di trigger opzionale** sopra `runHeadlessZelari`,
**senza toccare il loop di missione**. Il loop resta passivo: qualcuno deve
pur chiamarlo. Quello che aggiungiamo è *chi lo chiama*.

Si scelgono **due trigger concreti** (ordinate per valore/effort) e si
documentano gli altri come future-work:

### Trigger 1 — Cron di sistema + flag `--once` + lockfile (ZERO nuove dipendenze)

Non si embedda uno scheduler dentro il CLI (richiederebbe un daemon always-on +
una nuova dip pesante tipo `node-cron`). Si sfrutta invece il cron già presente
su ogni OS (crontab / launchd / Task Scheduler) e si rende la missione
**sicura da invocare ripetutamente**:

- **Flag `--once`**: garantisce che una missione girata da cron esegua un
  singolo ciclo e termini (evita loop infiniti se qualcuno omette il phase
  cap). Si mappa sui parametri esistenti (`ZELARI_MISSION_MAX_ITER=1`), ma con
  semantica esplicita "trigger run".
- **Lockfile `.zelari/trigger.lock`**: prima di avviare, `runHeadlessZelari`
  controlla il lock; se presente e vivo (PID check), esce con code `0` e logga
  `skip: another mission is running`. Rilascia il lock all'uscita (incluso
  `SIGINT`/`uncaughtException`).
- **Documento + script di esempio** (`docs/triggers.md` +
  `scripts/zelari-cron-example.sh`): riga crontab pronta che lancia
  `zelari-code --headless --once --mode zelari --task "..."`.

Caso d'uso: *"ogni mattina alle 8, rigira i test e se rossi tenta il fix"*:

```cron
0 8 * * * cd /repo && zelari-code --headless --once --mode zelari \
  --task "run tests; if any fail, fix the top failing test and verify"
```

### Trigger 2 — Git hook (`pre-push` / CI su PR)

Uno script `scripts/zelari-git-hook.mjs` che, su un evento git, lancia una
missione headless con un task derivato dal contesto:

- **`pre-push`** (locale): `--task "review the diff about to be pushed for
  security/correctness"`, phase `plan` (solo design, nessuna scrittura).
- **CI on PR** (GitHub Actions): la missione gira in phase `plan` su un
  worktree pulito e commenta la PR con il synthesis di Minosse.

Il flusso: il hook costruisce il task (diff via `git diff`), invoca
`zelari-code --headless --once --mode council --phase plan --task "..."`, e
mostra il synthesis. Riutilizza `--once` + lockfile del Trigger 1.

### Future-work (non in questo ADR)

- **`--watch` (file-watch trigger)**: `fs.watch` ricorsivo su un pattern →
  rilancia missione. Utile ma introduce complessità di debounce/dedup; deferito.
- **Webhook trigger**: piccolo server HTTP (GitHub PR webhook → missione).
  Richiede un daemon sempre-on; in conflitto con la decisione "no daemon".
  Deferito finché non si introduce una modalità `zelari-code serve`.

## Consequenze

**Positive:**
- La missione diventa un teammate che lavora su evento, non solo su Enter.
- Integrazione naturale con CI/CD e cron — zero nuove dipendenze runtime
  (trigger 1 e 2 usano solo `child_process` + `fs`, già in stdlib).
- `--once` + lockfile rendono il loop **sicuro da cron** anche in presenza del
  budget cap (ADR-0013): doppia protezione contro run impazziti.

**Negative:**
- Rischio di **missione sovrapposta** sullo stesso repo (due trigger concorrenti
  → conflitto git su working tree). Mitigato dal lockfile (PID-checked), ma
  non risolto se l'utente gira su repo separati/clone.
- Il lockfile può diventare **stale** su crash forzato (`kill -9`). Mitigato
  con PID check: se il PID non è più vivo, il lock viene rubato con warning.

**Invarianti preservate:**
- Il loop di missione (`runZelariMission`) non cambia — resta passivo.
- Nessun daemon always-on introdotto nel CLI (coesiste con cron di sistema).
- Retrocompatibile: senza `--once`/lockfile, behavior identico a oggi.

## Alternative considerate

1. **Embeddare `node-cron` + daemon `zelari-code serve`.** Rifiutato: nuova
   dip pesante, un processo always-on per un CLI, e duplica ciò che il cron di
   sistema fa già meglio. Keep it simple: il CLI è un esecutore, non uno
   scheduler.
2. **GitHub Actions come unico trigger.** Rifiutato: troppo specifico (cloud),
   non copre scenari locali / self-hosted. Il trigger git-hook + cron è
   cloud-agnostic.
3. **Scheduler interno con `setTimeout` + parsing cron minimo.** Rifiutato per
   lo stesso motivo di (1): reimplementare cron è fragilissimo. Il cron di OS
   è battle-tested.

## Punti di integrazione concreti

| File | Modifica | Effort |
|---|---|---|
| `src/cli/main.ts:324-331` | aggiungere flag `--once` all'help + parsing | XS |
| `src/cli/headless.ts` (`parseHeadlessFlags`) | parse `--once` → `HeadlessOptions.once` | XS |
| `src/cli/runHeadless.ts:758` (`runHeadlessZelari`) | se `opts.once`: forza `MAX_ITER=1`; acquire/rilascia lockfile | S |
| nuovo `src/cli/triggerLock.ts` | `acquireLock(path) → bool`, `releaseLock`, PID check, `SIGINT` handler | S |
| `scripts/zelari-cron-example.sh` | esempio crontab | XS |
| `scripts/zelari-git-hook.mjs` | hook git (pre-push) | S |
| `docs/triggers.md` | guida trigger | S |

**Test di accettazione:**
- `--once` forza `MAX_ITER=1` anche se `ZELARI_MISSION_MAX_ITER=6` nell'env.
- Due invocazioni concorrenti → la seconda esce `code 0` con `skip:` log.
- `kill -9` + riesecuzione → il lock stale viene rubato via PID check.
