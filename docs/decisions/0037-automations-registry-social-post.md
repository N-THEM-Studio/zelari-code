# ADR-0037 — Automations Registry e `social_post` (browser-first per X e Facebook)

- **Status:** Accepted (2026-09-16)
- **Baseline:** v2.46.2 — Automations = singolo job Gardener OS-scheduled (propose-only)
- **Collegamenti:** estende ADR-0014 (niente scheduler embedded); rispetta P1 (unknown ≠ success) e ADR-0023 (evidence contract, `unknown ≠ pass`)
- **Piano di verifica contro il codice:** `.zelari/docs/2026-09-16-automations-social-posting-verifica-e-piano.md` (Rev 2)

## Context

Oggi Settings → Automations (Desktop) è una card singola hardcoded su **Gardener**: nomi OS costanti (`schtasks /TN ZelariGardener`, LaunchAgent `com.zelari.gardener`, tag crontab `# ZelariGardener`), launcher `.zelari/gardener-task.*`, runtime propose-only via `--headless --once --phase plan`. Non esiste registry, né tipi di job, né approvazioni, né canali social (verificato sul tree v2.46.2: zero riferimenti a facebook/x/social nel codice).

Esigenza: **N automazioni tipizzate** schedulate via OS, di cui una famiglia `social_post` — draft → approve umana → publish → permalink come evidence — funzionante anche a Desktop chiuso.

**Decisione utente esplicita (Andrea / Anathema Studio, 2026-09-16):** per X e Facebook si usa **automazione browser, non API ufficiali** — login manuale una-tantum su profilo persistente, poi click automatizzati. Motivazione: niente onboarding dev-app, niente tier a pagamento, controllo totale sul flusso. Rischio ToS/ban accettato e documentato qui; gli adapter API restano in **backlog** dietro lo stesso seam `ChannelAdapter`, se un giorno servisse la via compliance.

## Decision

1. **Registry su disco** (fonte di verità per CLI e Desktop):
   ```text
   .zelari/automations/
     index.json                 # { version: 1, automations: [{ id, enabled }] }
     <id>.json                  # AutomationSpec
     <id>.launcher.cmd|.sh      # launcher generato (per OS scheduler)
     runs/<id>/<runId>.json     # AutomationRun (evidence)
   ```
   Id: `/^[a-z0-9][a-z0-9-]{1,39}$/`; `gardener` è **id riservato** (non eliminabile). Migrazione: prefs Gardener esistenti → `AutomationSpec` con `id: 'gardener'`, `kind: 'gardener'` (back-compat, mai sovrascritta se già presente).

2. **OS scheduler only** (ADR-0014 invariato: nessun cron/daemon in-process). Entry **per-id**:
   - Windows: `schtasks /TN ZelariAutomation:<id>`
   - macOS: LaunchAgent `com.zelari.automation.<id>`
   - Linux: riga crontab taggata `# ZelariAutomation:<id>`
   - **Back-compat Gardener:** per `id=gardener` si continuano a usare i nomi legacy (`ZelariGardener`, `com.zelari.gardener`, `# ZelariGardener`) per non orfanare installazioni esistenti.

3. **Runtime invariato nella filosofia:** OS → launcher → `zelari-code --headless --once --automation <id>`, dispatch per `kind`:
   - `gardener` → flusso esistente (propose-only), nessun comportamento nuovo;
   - `social_post` → `SocialPostRunner` (da F2): draft → persist → se `requireApproval` (default **true**) si ferma in `awaiting_approval`; senza approve entro TTL → **exit 4**, nessun publish.

4. **Canali via seam `ChannelAdapter`** (`validateConfig` / `publish` → `{ postId, url }`). Adapter v1:
   - **browser** per `x` e `facebook` (primari, decisione utente);
   - **website** webhook HTTPS firmato HMAC (unico con secret nel vault `~/.zelari-code/channels/`);
   - API Graph/X API v2: **backlog**, stesso seam.

5. **Browser adapters — contratto operativo:**
   - Profili persistenti dedicati `~/.zelari-code/browser-profiles/<channel>/` via Playwright `launchPersistentContext` (sessione/cookie fuori dal repo, il prodotto non vede mai credenziali);
   - `zelari-code automation login <channel>`: apre browser **headed**, l'utente fa login+2FA una volta;
   - **Health check pre-run obbligatorio**: sessione scaduta → run `relogin_required`, **exit 4**, zero click e zero testo digitato;
   - Publish automatico con ritmo umano (delay randomizzati su typing e click);
   - **Selettori in JSON esterni editabili** (`~/.zelari-code/selectors/<channel>.json`) con catene di fallback; `zelari-code automation probe <channel>` diagnostica il passo rotto senza ricompilare;
   - Evidence: permalink estratto dal profilo dopo il publish (`/status/<id>`, `/posts/…`) + screenshot del post.

6. **P1 / evidence:** `completed` solo se **ogni** canale richiesto ha `ok: true` **e** `url` (o postId verificabile). Draft senza approve, publish non provato, relogin necessario → **exit 4** (unproven), mai success fantasma.

7. **Secrets:** mai in `.zelari/automations/*.json` committati; webhook secret in `~/.zelari-code/channels/`; le sessioni social vivono nei profile dir del browser (fuori repo). Le chiavi LLM esistenti non c'entrano e non si toccano.

8. **Fasi:** F0 contratto+migrazione → F1 registry + CLI `automation` + OS per-id (+ UI Desktop) → F2 draft+approve dry-run (exit 4 su TTL) → F3.1 session manager (login/health/probe, `launchPersistentContext`) → F3.2 publish browser X → F3.3 publish browser Facebook + website webhook → F4 hardening (smoke offline, threat model, secret scan).

## Consequences

**Positive**
- Da 1 job hard-coded a N job tipizzati; Gardener migra, non si duplica.
- Browser-first elimina l'onboarding API per X/Facebook; l'utente mantiene il controllo del login.
- Selettori esterni + probe = rotture DOM riparabili senza release (anche dall'agent in sessione).
- Approve obbligatoria + permalink evidence: nessun post silenzioso, nessun success senza prova.

**Negative / rischi accettati**
- **ToS/ban:** X e Facebook vietano l'automazione fuori API; rischio contenuto ma non zero (volumi bassi, ritmo umano, approve umana). Documentato e accettato dal decision-maker.
- **Fragilità DOM:** selettori cambiano; mitigata da fallback chain + probe + JSON editabili.
- Superficie Settings cresce: Automations resta una sezione di Settings, non un prodotto a parte.

## Alternatives considerate

- **API-first (rev 1 del piano):** scartata su decisione utente 2026-09-16; resta in backlog dietro `ChannelAdapter`.
- **node-cron / scheduler embedded:** vietato da ADR-0014.
- **Unattended publish di default:** no — `requireApproval: true` di default; `yolo` solo opt-in esplicito e documentato.

## Metriche (primo tag "social")

- Post `completed` senza `url`: **0**
- Publish senza approve col default: **0**
- Daemon in-process: **0**
- Test dry-run/probe in CI: sì
