# Automations: Social Posting — Verifica del documento + Piano operativo

**Data:** 2026-09-16 · **Baseline verificata:** v2.46.2 (root, @zelari/core, @zelari/desktop, tauri.conf.json)
**Documento verificato:** `zelari-automations-social-posting.md` (root repo)
**Natura:** UNVERIFIED DESIGN HYPOTHESIS → questo file promuove a piano con evidenza file:riga. Nessun codice è stato toccato.

---

## 1. Esito verifica — documento vs codice reale

| # | Claim del documento | Verdetto | Evidenza (file:riga) |
|---|---|---|---|
| 1 | Baseline v2.46.2 | ✅ CONFERMATO | `package.json`, `packages/core/package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json:4` |
| 2 | Automations = card singola Gardener | ✅ CONFERMATO | `apps/desktop/src/components/AutomationsSection.tsx:90` (unico `SettingsCard`, title="Gardener"); tab `SettingsShell.tsx:51,248` |
| 3 | Prefs enable/interval/maxCost | ✅ CONFERMATO | `desktopPrefs.ts:64-68` (`gardenerEnabled`, `gardenerIntervalMin` ∈ [5,1440], `gardenerMaxCostUsd` ∈ [0.5,20]); UI toggle/select/input `AutomationsSection.tsx:98-138` (opzioni interval fisse [10,15,30,60,120] `:30`) |
| 4 | IPC `manage_automation` register/remove | ✅ CONFERMATO (+`status`) | handler `automations.rs:716`, dispatch `:729` (register/remove/status); registrato `lib.rs:3849`. **È l'unico** comando IPC automations (FE `agentClient.ts:664-674`) |
| 5 | OS: schtasks/launchd/crontab | ✅ CONFERMATO | Win: `schtasks /Create /TN ZelariGardener /SC MINUTE /MO N /TR …gardener-task.cmd` (`automations.rs:400-403`, `TASK_NAME:68`); macOS: LaunchAgent `com.zelari.gardener`, `StartInterval` in secondi (`:80,228,512`); Linux: riga crontab tag `# ZelariGardener` (`CRON_TAG:74`, `strip_tagged:189`) |
| 6 | Runtime `zelari-code --headless --once` | ✅ CONFERMATO (via catena launcher) | OS task → launcher generato `.zelari/gardener-task.cmd|.sh` (`automations.rs:98,101,127,150`) → `scripts/zelari-gardener.sh:331` → `zelari-code --headless --once --mode zelari --phase plan --output plain` |
| 7 | Gardener propose-only `--phase plan` | ✅ CONFERMATO | `scripts/zelari-gardener.sh:20-21,331`; semantica `src/cli/phase.ts:4,40-46` (`PLAN_ALLOWED_WRITE_TOOLS`) |
| 8 | Exit `0\|1\|4` (4 = unproven) | ⚠️ PARZIALE | Mappa reale **0\|1\|2\|3\|4**: 4 = `STRICT_DONE_EXIT_CODE` (`src/cli/kraken/verificationBridge.ts:631`), termine nel codice è **"unverified"** (flag `--allow-unverified`); 2 = policy-load (`policyLoadMode.ts:42`); 3 = agent/council error (`runHeadless.ts:665,1022`). "unproven" non esiste nel codice |
| 9 | Budget maxCostUsd per run | ✅ CONFERMATO (via env, non flag) | `gardener.sh:31` `ZELARI_MISSION_MAX_COST` (default 2.00); `zelariMission.ts:225` `resolveMaxCost` + cap cumulativo `.zelari/mission-state.json`. Nessun `--max-cost` CLI |
| 10 | Non esiste `--automation <id>` né subcomando `automation` | ✅ CONFERMATO | grep su 507 file `src/cli` = 2 match prosaici; `parseHeadlessFlags` (`headless.ts:304-626`) senza ramo. **Pitfall:** flag ignoti silenziosamente droppati; validazione `--headless` richiede `--task` (`headless.ts:591-593`) → da rilassare |
| 11 | ADR-0014 vieta scheduler/daemon in-process | ✅ CONFERMATO | `docs/decisions/0014-mission-triggers-event-driven.md` (Accepted+implemented): "We do not embed a scheduler…"; alternativa node-cron esplicitamente rejected. ADR-0015 `serve` = host opt-in, non scheduling |
| 12 | Nessun codice social/channel pre-esistente | ✅ CONFERMATO | grep facebook/twitter/social_post/ChannelAdapter su 1281 file ts + 58 tools = **0 match** |
| 13 | Regola release "max 1 minor / 48h" | ✅ CONFERMATO | `CONTRIBUTING.md:100` |
| 14 | (gap repo, non del doc) GUIDA.md sezione Automations | ❌ ASSENTE | TOC `docs/GUIDA.md:10-33`: nessuna sezione; solo `--once` documentato (`:367`). Il gardener Desktop 2.42/2.46 non è nella user guide |

**Giudizio complessivo: il documento è fedele al codice.** Due precisazioni da correggere nel testo (exit codes; termine "unverified") e una lacuna del repo (GUIDA) da colmare in fase, non nel contratto.

## 2. Correzioni da applicare al documento

1. `exitCode: 0|1|4` → `0|1|2|3|4` con semantica: 0 ok · 1 usage/chiavi · 2 policy-load · 3 agent/council error · 4 strict-unverified (draft senza approve → 4, coerente col documento).
2. "unproven" → "unverified" (coerenza col codice esistente).
3. §4 as-is "Credenziali: Solo OAuth LLM" → precisare: oggi **nessuno storage sicuro esiste** (nessun keyring/stronghold in `Cargo.toml`; `keys.json` plaintext chmod 0600, `keyStore.ts:172`) → la scelta vault è una decisione F0, non un dettaglio.
4. §8 "Crontab collision" → oggi tag/nome **costanti singole** (`ZelariGardener`, `com.zelari.gardener`, `# ZelariGardener`): il multi-job richiede naming per-id, esattamente come propone il doc (`ZelariAutomation:<id>`).

## 3. Asset riutilizzabili scoperti (non previsti dal documento)

| Asset | Dove | Riuso |
|---|---|---|
| Seam draft→approve→execute | `--plan-only` + `--run-plan <id>` (`headless.ts:561-575`; `runHeadless.ts:514-585`) | Pattern per approval flow social |
| Lock per-run con stale-steal PID | `.zelari/trigger.lock` (`src/cli/triggerLock.ts:46-97`) | Lock per-automation `<id>.lock` |
| Mission state machine + resume | `zelariMission.ts:35-41,429`, `mission-state.json` | Pattern durable run/`AutomationRun` |
| Permission broker MCP | `ZELARI_PERM_SOCKET` (`runHeadless.ts:141-168`, `mcp/permissionBroker.ts`) | Approve tool-level per publish di rete |
| Browser già presente (base F3b) | `browser_check` (`src/cli/browser/driver.ts:141-256`, `tools.ts:70-105`), Playwright lazy-dep + install one-click (`plugins/registry.ts`; Desktop `lib.rs:3140`) | Fondamenta adapter browser; **manca** profilo persistente (`launchPersistentContext` = 0 match) e sessione multi-step (tool single-shot 60s) |
| Cua Driver MCP preset | `mcpPresets.ts:24-40` | Non riusabile unattended (guida la sessione desktop reale) — escluso dal piano |

## 4. Decisioni chiave (da ratificare in F0)

- **D1 — Browser use (richiesta esplicita di Andrea):** entra come **famiglia di adapter di seconda classe, opt-in**, non primaria. API-first per Facebook Page (Graph API, gratuita) e website (webhook). X: API v2 se c'è dev app (free tier = scrittura mensile limitata, ordine delle centinaia di post — **da verificare alla registrazione**, ricerca web offline in fase di verifica); in assenza di tier API → adapter browser. Post via browser **mai** unattended senza approve. ⇒ emendare §3 del documento: il freeze "browser non primario" resta, il browser diventa adapter consentito.
- **D2 — Vault v1:** `~/.zelari-code/channels/<channel>.json` mode 0600, coerente con `keys.json` attuale. La cifratura con passphrase è security theater per run OS-scheduled (la passphrase dovrebbe comunque risiedere su disco). F4: keychain OS opzionale via Tauri (`keyring-rs`) quando Desktop presente + threat model documentato.
- **D3 — Windows cron:** schtasks non ha cron5 nativo → **v1 interval-only su Windows**; `cron5` solo macOS/Linux (crontab / launchd `StartCalendarInterval`). La UI espone la disponibilità per piattaforma.
- **D4 — Naming OS multi-job:** `ZelariAutomation-<id>` (schtasks /TN), `com.zelari.automation.<id>` (launchd label), `# ZelariAutomation:<id>` (crontab tag). Migrazione del task Gardener esistente.
- **D5 — Approve flow:** run → draft persistito → `status=awaiting_approval` + exit 4 → resolve via CLI `zelari-code automation approve <runId> --allow|--deny|--edit=-` **o** IPC `resolve_automation_approval` (Desktop). Il resolve **lancia subito la publish** (non attende il trigger successivo). TTL default 24h → `skipped`, mai post silenzioso.

## 5. Fasi (struttura del documento confermata + B-track)

### F0 — Contratto (2–3 gg)
- ADR-0037 *Automations registry + social_post + channel adapter seams* (incl. emendamento D1 browser) — **Accepted prima del codice grande**.
- Migrazione prefs Gardener → `AutomationSpec` id=`gardener` (prefs localStorage `desktopPrefs.ts:64-68` → record job; back-compat lettura).
- Decisioni D1–D5 ratificate; correzioni §2 applicate al documento.

### F1 — Registry + OS multi-job (1–2 sett) — cuore infrastruttura
- `AutomationSpec` + `.zelari/automations/index.json` + `<id>.json` + `runs/<id>/<runId>.json`.
- IPC: `list_automations` / `upsert_automation` / `delete_automation` / `manage_automation_schedule` per-id (naming D4; punto d'innesto `automations.rs` costanti `:68,74,80` + launcher `:98,101,127,150`).
- Launcher generico `.zelari/automations/<id>.task.cmd|.sh` → `zelari-code --headless --once --automation <id>` (innesto parsing: `headless.ts:304-626` + rilasso validazione `:591-593`; dispatch `runHeadless.ts:1252-1276`).
- Budget per-spec → env `ZELARI_MISSION_MAX_COST` iniettata dal launcher (pattern esistente `gardener.sh:31`).
- UI lista (Gardener migrato) in `AutomationsSection.tsx` + client `agentClient.ts:644-674`.
- Test: due job registrati non collidono (TN/label/tag per-id); migrazione task Gardener legacy.
- Anticipare sezione GUIDA "Automations" base.
- **Exit F1:** N job schedulabili; zero social.

### F2 — Social draft + approve (1–2 sett)
- `SocialPostRunner` draft-only; adapters in **dry-run** (nessun network publish, fake url pinata dai test).
- Pending approvals: card in Automations + badge Settings; CLI `automation approve` (D5).
- Exit 4 su TTL scaduto senza approve; lock per-id (pattern `triggerLock.ts`).
- **Exit F2:** draft visibile → approve → run `completed` in dry-run con evidence finta.

### F3a — Publish API (1–2 sett)
- Ordine: website webhook (HMAC) → Facebook Page Graph (Page token long-lived, `pages_manage_posts`) → X API v2 (se dev app disponibile, altrimenti rimanda a F3b).
- Vault v1 (D2) + `manage_channel_credential` IPC (store/delete/test).
- Evidence: permalink obbligatorio per `completed`; verify via GET opzionale.
- Rate limit `maxPostsPerDay` + budget.

### F3b — Publish browser (1–2 sett, parallelizzabile con F3a) — **nuova, richiesta utente**
- Driver browser v2 in `src/cli/browser/`: `launchPersistentContext` + `userDataDir = ~/.zelari-code/browser-profiles/<channel>`; sessione multi-step (composer: goto → fill → attach → publish) — file ≤300 LOC ciascuno, rispetto convenzioni.
- Bootstrap login **headed** interattivo: `zelari-code automation login <channel>` (o finestra Desktop); mai login unattended con credenziali salvate.
- Evidence: permalink + screenshot salvato in `runs/<id>/`.
- `requireApproval` **sempre true** di default sui run browser; niente evasion anti-bot attive (headless chromium onesto); rischio ban documentato nel threat model.
- **Exit F3b:** un post di prova via browser (o API se disponibile) con permalink in `AutomationRun` e exit 0.

### F4 — Hardening
- Smoke e2e offline (fake adapter); `tokens: null` vietati sui run; secret scan in verify.
- Threat model: token leak, approve fatigue, ban/ToS browser path.
- Keychain OS opzionale (D2 fase 2).
- Non espandere canali finché F3 verde.

## 6. Definition of Done (invariata dal documento + variante browser)

> Da Settings → Automations creo un job `social_post` su X o Facebook Page, lo schedulo via OS, ricevo un draft, lo approvo, vedo il permalink come evidence in Automations. Senza approve non pubblica (exit 4). Gardener resta un job del registry. Nessun daemon nel processo Zelari. Il path browser è opt-in, approvato di default, con evidence permalink+screenshot.

## 7. Metriche (dal documento + aggiunta browser)

| Metrica | Target |
|---|---|
| Job registry N≥2 (gardener + 1 social) | sì |
| Post senza `url` marcati completed | **0** |
| Publish senza approve con default | **0** |
| Publish browser senza approve | **0** |
| Test dry-run adapter in CI | sì |
| Daemon in-process | **0** |

## 8. Rischi aggiuntivi (rispetto al documento)

| Rischio | Mitigazione |
|---|---|
| Anti-bot/ban su X/FB via browser headless | Profilo persistente, login umano headed, rate bassi, approve obbligatorio, threat model F4; API-first dove possibile |
| Login 2FA / sessione scaduta a run time | Run fallisce exit 4 con stato `relogin_required`; mai retry automatico con credenziali |
| Selettori composer cambiano | Adapter isolati per canale + snapshot test sui flussi; dry-run in CI |
| Limiti X API free tier non verificati (ricerca web offline) | Verifica alla registrazione dev app in F3a; fallback F3b |
| Windows senza cron5 | D3: interval-only v1 su Windows, documentato in UI |

## 9. Governance release (confermata)

- F1 → minor `2.47 Automations registry`; F2–F3 → minor `2.48 social_post`; max 1 minor/48h (`CONTRIBUTING.md:100`); patch solo P0 (token leak, post doppio, lock rotto).

---

# Rev 2 — 2026-09-16: pivot BROWSER-FIRST (decisione Andrea)

**Supera:** D1 (browser "seconda classe"), F3a/F3b del rev 1, e il non-obiettivo "browser non primario" della scheda (§3). **Invariati:** F0/F1/F2, seam `ChannelAdapter`, exit `0|1|2|3|4`, `requireApproval=true` default, evidence = permalink, ADR-0014 (nessun daemon).

## R1. Decisione

- **X e Facebook: nessuna API.** Publish via browser automatizzato su **profilo persistente** loggato manualmente dall'utente (una volta sola).
- **Website: resta webhook/HTTP** (sito proprio, nessun ToS di terzi, nessun login).
- Adapter API (Graph / X v2) → **backlog** dietro lo stesso seam `ChannelAdapter`: aggiungibili in futuro senza refactor.
- Conseguenza vault: per X/FB **non servono token da salvare** (la sessione vive nel profilo browser) → il vault D2 resta solo per il segreto HMAC del webhook website.

## R2. Flusso login manuale → publish automatico

1. `zelari-code automation login x|facebook` apre Chrome **headed reale** (`channel:'chrome'`, fallback Chromium del plugin) con `userDataDir = ~/.zelari-code/browser-profiles/<channel>/`.
2. L'utente fa login (+2FA) e chiude la finestra: cookie/sessione persistono nel profilo. **Il prodotto non vede né salva password.**
3. **Health check pre-run obbligatorio**: naviga home/profilo e verifica il marker logged-in. Se assente → stato `relogin_required`, exit 4, **zero caratteri digitati** (mai postare alla cieca).
4. Run approvato → nuovo contesto sullo stesso profilo: composer → typing con delay umano (30–80 ms/char) → media via `setInputFiles` → click Post.
5. **Evidence = permalink verificato via DOM**: post-publish si naviga profilo/pagina, si cerca il post per match sul testo del draft approvato, si estrae l'URL (`…/status/<id>` su X, `/posts/…` su FB Page) + screenshot in `runs/<id>/`. Nessun `completed` senza permalink (P1).

## R3. Componenti (nuovo modulo, file ≤300 LOC)

```text
src/cli/channels/browser/
  session.ts      launchPersistentContext + lock per profilo (user-data-dir = single-owner)
  health.ts       probe logged-in per canale
  probe.ts        diagnostica selettori: quale step è rotto (aggiornabile anche dall'agent)
  selectors/x.json        step → [catena fallback: data-testid, aria-role, text]
  selectors/facebook.json
  x.ts, facebook.ts       adapter ChannelAdapter via DOM
```

CLI aggiuntive: `automation login <channel>` · `automation health <channel>` · `automation probe <channel>`.
Base riutilizzata: loader plugin Playwright esistente (`plugins/registry.ts:215`, gate `ZELARI_BROWSER`; install Chromium `plugins/installer.ts:83-103`) — il gap confermato oggi è il profilo persistente (`launchPersistentContext`/`userDataDir` = 0 match su 755 file TS) e la sessione multi-step (`browser_check` è single-shot).

## R4. Selettori e fragilità

- X: `data-testid` stabili (`SideNav_NewTweet_Button`, `tweetButton`) come prima scelta; aria-role come fallback.
- Facebook Page: niente testid stabili → aria-role (dialog "Create a post", textbox, button "Post").
- Registry JSON con fallback chains per step: quando il DOM cambia, `automation probe <channel>` individua lo step rotto e il JSON si aggiorna **senza ricompilare** (lavoro anche per l'agent stesso in sessione).

## R5. Avvio: headless vs headed

- **Login: sempre headed** (interazione umana).
- **Run manuale** (`automation run --id x --once`): headed visibile — l'utente vede cosa fa il browser.
- **Run schedulato OS**: `headless: 'new'`; se challenge/captcha rilevato → `needs_attention`, exit 4, **nessun retry loop**.
- Postura stealth-lite onesta: Chrome reale + profilo caldo + pacing umano riducono l'attrito; **non promettiamo invisibilità** né attiviamo arms-race anti-detection.

## R6. Rischi aggiornati (browser-first)

| Rischio | Postura |
|---|---|
| Sospensione account (ToS: automazione fuori API vietata) | decisione esplicita dell'utente sul proprio account; mitigazioni: volumi bassi (`maxPostsPerDay`), pacing umano, `requireApproval=true` **sempre** sui run browser, profilo dedicato senza credenziali salvate dal prodotto |
| Selector rot (DOM cambia) | registry JSON + fallback chains + `probe`; fix senza rebuild |
| Sessione scaduta a run time | health check pre-run → `relogin_required` exit 4 + notifica Desktop; mai retry con credenziali |
| Challenge/captcha in headless | `needs_attention` exit 4; ripubblica dopo intervento umano |
| Concorrenza sul profilo | lock per user-data-dir + lock run per-id già pianificati (pattern `triggerLock.ts`) |

## R7. Fasi aggiornate

- **F0**: ADR-0037 ratifica il pivot browser-first (questa rev ne è la bozza) + migrazione Gardener → spec. Invariato.
- **F1**: registry multi-job. Invariato (è kind/channel-agnostic).
- **F2**: draft → approve → dry-run, exit 4 su TTL. Invariato.
- **F3.1** BrowserSessionManager + `login`/`health`/`probe` + lock profilo (2–3 gg)
- **F3.2** X adapter browser end-to-end: draft → approve → post → permalink (3–5 gg)
- **F3.3** Facebook Page adapter browser (3–5 gg) + website webhook HTTP con HMAC (1 gg)
- **F4** hardening: smoke offline su DOM fixture, secret scan, threat model (ban, hijack del profilo, approve fatigue).
- **Backlog** (ex F3a): adapter API Graph/X v2 dietro lo stesso seam, come fallback a lungo termine.

## R8. Metriche aggiuntive browser-first

| Metrica | Target |
|---|---|
| Post browser senza permalink verificato marcati completed | **0** |
| Publish browser senza approve (default) | **0** |
| Run con health check fallito che hanno digitato testo | **0** |
| Password/2FA mai toccate dal prodotto | **0 storage** |
