# Scheda progetto — Automations: Social Posting

**Prodotto:** Zelari Code (Desktop + headless)  
**Baseline codice:** v2.46.2 (Automations = Gardener OS-scheduled)  
**Superficie da estendere:** Settings → **Automations** (`AutomationsSection`, IPC `manage_automation`)  
**Non fare:** un secondo prodotto “Social”, un daemon cron in-process, un tab chat separato.

---

## 1. Problema

Andrea (Anathema Studio) vuole programmare e pubblicare contenuti su **Facebook / X / sito** (e canali simili) con lo stesso spirito delle routine di un assistant desktop: trigger → lavoro → risultato verificabile, anche a Desktop chiuso.

Oggi Automations **non** è un registry di job. È una card sola:

- job fisso **Gardener** (propose-only, `--phase plan`)
- prefs: enable / interval / max cost
- Register/Remove verso OS (`schtasks` / `launchd` / crontab)
- runtime = `zelari-code --headless --once …`

Serve passare da **un job hard-coded** a **N automazioni tipizzate**, di cui una famiglia è `social_post`, senza violare ADR-0014 (niente scheduler embedded) e senza tradire P1 (unknown ≠ success).

---

## 2. Obiettivo (una riga)

> Estendere Settings → Automations in un registry di job OS-scheduled, con tipo `social_post`: draft generato → approve umana → publish sui canali → evidence = permalink.

---

## 3. Non-obiettivi (freeze esplicito)

- Embeddare `node-cron` / daemon sempre acceso (vietato da ADR-0014).
- Postare in unattended senza approve di default (`yolo` solo opt-in esplicito e documentato).
- Scraping/browser login come path primario (fragile + ToS). Preferire API ufficiali / MCP.
- Nuovo personaggio council / BoN / vision tool “per i post”.
- Far diventare Automations il prodotto: resta Settings, Gardener resta il primo job built-in.

---

## 4. As-is → to-be

| | Oggi (2.46.2) | Target |
|---|---|---|
| Modello | 1 job (Gardener) | N job (`AutomationSpec`) |
| UI | Card Gardener | Lista + create/edit + stato |
| Trigger | Interval minuti OS | cron-like / interval / manual run-once |
| Azione | Hard-coded gardener script | `kind`: `gardener` \| `social_post` \| (futuro) |
| Approve | N/A (plan-only) | Draft hold → Allow once / Deny / Edit |
| Evidence | Piano testo | `postedUrl` + `channelPostId` + timestamp |
| Credenziali | Solo OAuth LLM | Channel credentials vault (Desktop keychain / OS) |
| Runtime | OS → launcher → headless | Invariato: OS → launcher → `zelari-code --once --automation <id>` |

---

## 5. Design proposto

### 5.1 Data model

File progetto (gitignored secrets, committed specs opzionali):

```text
.zelari/automations/
  index.json                 # lista id + enabled
  <id>.json                  # AutomationSpec
  runs/<id>/<runId>.json     # AutomationRun (evidence)
```

Credenziali **mai** nel repo:

```text
~/.zelari-code/channels/     # o keychain OS via Tauri
  facebook.json.enc
  x.json.enc
  webhooks.json.enc
```

#### `AutomationSpec` (bozza)

```ts
type AutomationSpec = {
  id: string
  name: string
  enabled: boolean
  kind: 'gardener' | 'social_post'
  schedule: {
    // OS materializzato: intervalMin (compat Gardener) OPPURE cron5
    intervalMin?: number   // 5–1440
    cron?: string          // "0 9 * * 1-5" (timezone = locale utente)
    timezone: string       // default Europe/Rome
  }
  budget: { maxCostUsd: number }
  // kind-specific:
  gardener?: { /* existing */ }
  social_post?: SocialPostSpec
}

type SocialPostSpec = {
  channels: Array<'facebook' | 'x' | 'website' | string>
  topicOrBrief: string              // brief umano o path a .md
  tone?: string
  media?: { paths: string[]; alt?: string[] }
  requireApproval: boolean          // default true
  maxPostsPerDay?: number
  utm?: Record<string, string>
  website?: { endpoint: string; method?: 'POST'; bodyTemplate?: string }
}
```

#### `AutomationRun` (evidence)

```ts
type AutomationRun = {
  runId: string
  automationId: string
  startedAt: string
  finishedAt?: string
  status: 'drafting' | 'awaiting_approval' | 'publishing' | 'completed' | 'failed' | 'skipped'
  draft?: { text: string; media?: string[]; warnings?: string[] }
  approvals?: Array<{ at: string; decision: 'allow' | 'deny' | 'edit'; editedText?: string }>
  posts?: Array<{
    channel: string
    ok: boolean
    postId?: string
    url?: string          // permalink = evidence ammissibile
    error?: string
  }>
  costUsd?: number
  exitCode: 0 | 1 | 4     // 4 = unproven (draft senza publish / approve mancante)
}
```

**Regola P1:** `completed` solo se ogni canale richiesto ha `ok: true` **e** `url` (o `postId` verificabile via API get). Altrimenti `failed` o exit **4**.

### 5.2 Runtime (allineato ad ADR-0014)

```text
OS scheduler (schtasks | launchd | crontab)
        │
        ▼
.zelari/automations/<id>.launcher.sh|.cmd
        │
        ▼
zelari-code --headless --once --automation <id>
        │
        ├─ kind=gardener → script esistente (invariato)
        └─ kind=social_post → SocialPostRunner
                │
                ├─ 1. Draft (LLM, network ask/deny secondo policy)
                ├─ 2. Persist draft su AutomationRun
                ├─ 3. Se requireApproval: NOTIFY Desktop / write pending
                │         └─ senza approve entro TTL → exit 4 (non postare)
                ├─ 4. Publish via ChannelAdapter
                └─ 5. Write evidence (url/postId) → exit 0|1|4
```

**Desktop chiuso + requireApproval=true:** il run si ferma in `awaiting_approval`. La publish avviene al prossimo unlock dell’utente (IPC `resolve_automation_approval`) o via CLI `zelari-code automation approve <runId> --allow`. Nessun post silenzioso.

**Unattended publish:** solo se `requireApproval: false` **e** policy network allow per quel channel tool **e** budget. Default prodotto: **false**.

### 5.3 Channel adapters (seams, non god-module)

```text
packages/core o src/cli/channels/
  types.ts              ChannelAdapter
  facebook.ts           Graph API (Pages)
  x.ts                  X API v2
  website.ts            webhook/CMS HTTP
  registry.ts
```

Interfaccia minima:

```ts
interface ChannelAdapter {
  id: string
  validateConfig(): Promise<void>
  publish(input: {
    text: string
    media?: { path: string; alt?: string }[]
  }): Promise<{ postId: string; url: string }>
  // opzionale: verify(postId) per evidence ladder
}
```

Auth:

| Canale | Path consigliato (v1) |
|---|---|
| Facebook Page | Meta Graph API, Page token (long-lived), scope `pages_manage_posts` |
| X | OAuth 2.0 PKCE / API key+secret secondo tier account |
| Website | HTTPS webhook firmato (HMAC) o endpoint CMS (Ghost/WP/App) |

**v1 non include:** Instagram Reels, LinkedIn, TikTok (stesso registry, adapter dopo).

### 5.4 UI — Settings → Automations

Estendere `AutomationsSection`, non una nuova shell.

1. **Lista job** — Gardener (built-in) + user automations  
2. **Create** — wizard: nome, kind, schedule, channels, brief, requireApproval  
3. **Riga job** — Enabled, Next run, Last status chip (ok / awaiting / failed / unproven), Register/Remove OS  
4. **Pending approvals** — card in Automations (e badge Settings) con draft + Allow / Edit / Deny  
5. **Run detail** — permalinks cliccabili (= evidence)

IPC da aggiungere (accanto a `manage_automation`):

- `list_automations` / `upsert_automation` / `delete_automation`
- `manage_automation_schedule` (register/remove/status per id)
- `list_pending_approvals` / `resolve_automation_approval`
- `manage_channel_credential` (store/delete/test)

### 5.5 CLI (parità headless)

```bash
zelari-code automation list
zelari-code automation upsert --file spec.json
zelari-code automation register --id <id>     # materializza OS entry
zelari-code automation remove --id <id>
zelari-code automation run --id <id> --once   # manuale
zelari-code automation approve <runId> --allow|--deny|--edit=-
zelari-code automation runs --id <id>
```

Gardener diventa `kind: gardener` con id riservato `gardener` (migrazione prefs esistenti → spec).

### 5.6 Permissions / safety

| Controllo | Postura |
|---|---|
| Default `requireApproval` | **true** |
| Network per publish | tool/channel dedicato; ask in TUI; headless senza approve path → **deny** salvo allow esplicito sul channel |
| Budget | `maxCostUsd` per run (come Gardener) |
| Rate limit | `maxPostsPerDay` + lock `.zelari/automations/<id>.lock` |
| Secrets | fuori repo; mai in spine come plaintext |
| Evidence | permalink obbligatorio per `completed` |
| Fail | adapter error → `failed` exit 1; draft senza approve → exit **4** |
| Hook fail-closed | invariato in autonomous |

Allineamento al positioning Zelari: **non dichiarare “postato” senza URL**.

---

## 6. Fasi di delivery

### F0 — Contratto (2–3 giorni)

- ADR-00xx *Automations registry + social_post* (Accepted prima del codice grande)
- Migrazione modello: Gardener prefs → `AutomationSpec` id=`gardener`
- Freeze: niente nuovo adapter oltre facebook/x/website stub

### F1 — Registry + OS multi-job (1–2 settimane) ← cuore infrastruttura

- `AutomationSpec` + index su disco
- IPC list/upsert/delete + schedule register/remove **per id**
- UI lista (Gardener migrato)
- Launcher generico `--automation <id>`
- Test: register due job non si pestano i tag crontab (`# ZelariAutomation:<id>`)

**Exit F1:** N gardener-like jobs schedulabili; zero social ancora.

### F2 — Social draft + approve (1–2 settimane)

- `SocialPostRunner` draft-only
- Pending approvals UI + CLI approve
- Exit 4 se TTL scaduto senza approve
- Channel adapters in **dry-run** (no network publish, fake url in test)

**Exit F2:** si vede un draft, si approva, si ottiene run `completed` in dry-run con evidence finta pinata dai test.

### F3 — Publish reale (1–2 settimane)

- Facebook Page adapter + X adapter + website webhook
- Credential vault Desktop
- Evidence reale (GET verify opzionale)
- Rate limits + budget
- GUIDA: Settings → Automations + social

**Exit F3:** un post X o Facebook di prova con permalink in `AutomationRun` e exit 0.

### F4 — Hardening

- Smoke e2e offline (fake adapter)
- `tokens: null` vietato sui run
- Docs threat model (token leak, approve fatigue)
- Non espandere canali finché F3 verde

---

## 7. Definition of Done

> Da Settings → Automations posso creare un job `social_post` su X o Facebook Page, schedularlo via OS, ricevere un draft, approvarlo, e vedere in Automations il permalink come evidence. Senza approve non pubblica (exit 4). Gardener resta un job del registry. Nessun daemon cron nel processo Zelari.

---

## 8. Rischi

| Rischio | Mitigazione |
|---|---|
| ToS / API Meta-X cambiano | Adapter isolati; dry-run obbligatorio in CI |
| Approve fatigue → yolo | Default requireApproval; yolo richiede flag + warning UI |
| Token in repo | Vault path + secret scan in verify |
| Crontab collision multi-job | Tag univoco `# ZelariAutomation:<id>` |
| Scope creep (Reels, LinkedIn…) | Solo 3 adapter in v1 |
| Conflitto con spine-era / P0 aperti | Questa è **surface**. Non apre S1. Schedularla dopo o in parallelo stretto a F1-only se S1 è in corso |

---

## 9. Metriche

| Metrica | Target primo tag “social” |
|---|---|
| Job registry N≥2 (gardener + 1 social) | sì |
| Post senza `url` marcati completed | **0** |
| Publish senza approve con default | **0** |
| Test dry-run adapter in CI | sì |
| Daemon in-process | **0** |

---

## 10. Governance release

- **Una minor** per F1 (es. `2.47 Automations registry`)
- **Una minor** per F2–F3 (es. `2.48 social_post`)
- Rispettare **max 1 minor / 48h** (regola già scritta: non violarla)
- Patch solo P0 (token leak, post doppio, lock rotto)

---

## 11. Checklist PR

- [ ] Estende AutomationsSection / IPC esistenti, non nuovo prodotto
- [ ] OS scheduler only (ADR-0014)
- [ ] `completed` ⇒ permalink/postId evidence
- [ ] Default requireApproval = true
- [ ] Secrets fuori da `.zelari/automations/*.json` committed
- [ ] Gardener migrato, non duplicato
- [ ] Test: dry-run + crontab tag isolation + exit 4 senza approve

---

## 12. Sintesi

```text
Oggi:     1 card → Gardener → OS → plan-only
Domani:   registry → (gardener | social_post) → OS → --once
Social:   draft → approve → publish → permalink = proof
Mai:      cron embedded, post silenzioso di default, success senza URL
```

Fedeli a Zelari: **il post non è done finché non c’è il link.**  
Seri: **F1 registry prima degli adapter**, non il contrario.
