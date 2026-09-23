# Piano — Redesign completo Vista Impostazioni (Zelari Desktop)

> Stato: DRAFT (ipotesi di design, non ancora implementata)
> Target: `apps/desktop` (UI React + minor fix Rust/CLI)
> Fonte audit: esplorazioni 2026-03 su `components/SettingsView.tsx` (1437 righe), `agentClient.ts`, `src-tauri/src/lib.rs`, `App.css`, `App.tsx`.

---

## 1. Diagnosi — perché oggi è confusionaria

### 1.1 Architettura informativa (IA)
- 6 tab con confini illogici:
  - **Provider** mescola: provider+modello, verifier custom, OAuth, API key, endpoint.
  - **Defaults** mescola: default nuove chat (mode/phase), execution profile, 6 flag di verifica/sperimentali, model routing Kraken.
  - **System** contiene il tema (impostazione più usata) sepolta in fondo.
- Ordine enum `SettingsTab` ≠ ordine array `TABS` (righe 26–43).

### 1.2 Modello di salvataggio incoerente (il problema #1 di UX)
- Alcune azioni salvano subito con proprio bottone (OAuth, API key, endpoint, verifier).
- Altre richiedono il **Save globale del footer** (provider, model, mode/phase, tutti i prefs).
- L'utente non sa mai cosa salva "Save" (l'hint dice "Save applies provider, model & defaults").
- Nessun indicatore di dirty-state; Save disabilitato solo se `!provider`.

### 1.3 Cablaggio — difetti accertati (da non rompere / da correggere)
- **D1 (by design, da preservare)**: prefs Desktop (profile, gates, kraken routing, delegation) viaggiano SOLO via `onSave` → localStorage `zelari-desktop-prefs-v2` → passati come args a `run_task`. NON esistono flag CLI equivalenti. Un redesign che rimuove `onSave` senza sostituirlo **perde questi dati**.
- **D2**: `generate_skill_from_url` restituisce un draft ma non c'è ponte verso il form di creazione skill (l'utente copia a mano).
- **D3**: `--thinking` salvabile solo per il provider attivo.
- **D7**: messaggio d'errore fuorviante in `set_app_config` (elenca tutti i flag anche quando ne basta uno) — `lib.rs:1151` + `src/cli/desktopConfig.ts:236`.
- **W-varie**: `customModel.trim() || model` ripetuto in 3 punti; `formatExpiry` con magic number 90 e senza supporto giorni; `onStatus` duplicato 4 volte; boilerplate async (`setSaving/setError/…/finally`) ripetuto ~9 volte (~150 righe).

### 1.4 CSS
- Colori hardcoded nella nav (`#ffffff`, `rgba(40,40,46,…)` ecc.) invece di token → light theme parziale.
- Selettori orfani: `.field-inline` (2865), `.settings-panel` (3483).
- Definizioni duplicate: `.settings-view` (2618+3213), `.settings-nav-item.active .settings-tab-icon` (3315+3459).
- Scala spaziature incoerente (padding laterale main 28px vs card 20px; gap 4/10/12/14/16/20).
- `--spring` mai usato nei controlli form; radius card 16px fuori scala (12/18/22).

---

## 2. Nuova Architettura Informativa

**Principio: una sezione = uno scopo mentale. Ogni controllo salva da sé (autosave) con feedback immediato. Nessun bottone Save globale.**

### 2.1 Le 6 sezioni (nuovo ordine nav)

| # | Sezione (EN nell'UI, coerente col resto dell'app) | Contenuto | Persistenza |
|---|---|---|---|
| 1 | **General** | Theme toggle (in cima!), Default mode/phase nuove chat, Execution profile | localStorage (tema: come oggi via `onThemeChange`) |
| 2 | **Models & Providers** | Griglia card provider → pannello dettaglio: Model select, Custom model id, Base URL; **AuthCard**: OAuth (con stepper Anthropic) + API key | `setAppConfig` / `setApiKey` / OAuth → CLI (`provider.json`, `keys.json`) |
| 3 | **Agents** | Delegation policy; Model routing Kraken (lead read-only + explore/general/verify/planner); **Verification card**: verifier inherit/custom + strictDone, missionStrict, verifyPack, verifierReview, bonAlpha, gauntletLoop | prefs localStorage (routing/gates) + `setAppConfig` (verifier) |
| 4 | **Extensions** | MCP + Skills (componenti esistenti re-skin, contatori nel titolo) | `mcp.json` / `skills/` via CLI |
| 5 | **Connections** | SSH targets + Companion server (QR) | `ssh-targets.json` / companion token via CLI |
| 6 | **System** | Versions (Desktop/CLI + stato), Updates (CLI npm + Desktop Tauri), Paths (+ Open config folder), Shortcuts | mix read-only + update commands |

### 2.2 Interazione chiave
- **Autosave ovunque**: ogni controllo invoca la sua azione al commit (change per select/toggle; blur/Enter per input testo). Busy-state per-controllo (spinner inline), niente blocchi globali.
- **Toast** al posto del banner footer: host dentro SettingsShell, bottom-right, success 2.5s / errore 6s con azione "Copy details".
- **Griglia provider**: card con nome, StatusPill (Signed in · OAuth, expires in… / API key set / Not configured), modello attivo. Click = diventa provider attivo (autosave, stessa semantica dell'attuale select). Card attiva evidenziata con `--accent`.
- **AuthCard** per provider selezionato: se OAuth supported → blocco OAuth con stato/scadenza e azioni Sign in / Refresh / Sign out; Anthropic usa stepper inline (1 Open browser → 2 Paste code → 3 Complete). Sempre disponibile blocco API key (mostra `masked` dopo il salvataggio).
- **Endpoint e Custom model** mostrati come campi secondari ("Advanced") nel pannello dettaglio.
- **Esc** chiude le impostazioni (onBack); **Ctrl/Cmd+,** apre le impostazioni dalla chat (listener in App.tsx).

### 2.3 Microcopy
- Lingua UI resta **inglese** (coerente col resto dell'app: TitleBar, toolbar, composer).
- Ogni sezione apre con una riga di spiegazione ("Which AI provider and model new chats use").
- I tooltip `SettingHelp` restano, riorganizzati per riga.

---

## 3. Design system (CSS)

### 3.1 Nuove fondamenta
- File CSS dedicato `apps/desktop/src/components/settings/settings.css` (importato da SettingsShell) — il blocco settings in `App.css` viene rimosso.
- Tutto a token: nav `--surface`/`--text-secondary`/`--hover-tint`/`--accent-soft`; card `--glass-fill-a` + `--border-subtle`; zero colori hardcoded.
- Scala spaziature 4/8/12/16/20/24; allineamento padding (main 24px, card 20px, header 20px).
- Radius: view `--radius-lg` 22, card 16, inner `--radius-sm` 12.
- Transizioni `var(--spring)` su hover/active di nav item, toggle, select focus.
- Light theme completo (nessun override ad-hoc: i token fanno il lavoro).

### 3.2 Primitive condivise (eliminano le duplicazioni)
- `SettingsCard` (titolo + descrizione + contenuto + slot azioni)
- `SettingsRow` — grid `label | controllo | hint` allineata (sostituisce .field sparsi)
- `Toggle` — switch custom ( sostituisce checkbox native)
- `SelectInput` / `TextInput` (stile unificato, freccia SVG già esistente)
- `StatusPill` (ok/warn/neutral)
- `Toast` host + `useToasts`
- `useSettingAction(fn)` — wrapper async (busy/error/success-toast) che rimpiazza i 9 boilerplate
- `resolveModelId(customModel, model)` helper unico
- `formatExpiry` corretto (min<90 → minuti, poi ore, poi giorni)

---

## 4. Piano file

### Nuovi (`apps/desktop/src/components/settings/`)
| File | ~LOC | Scopo |
|---|---|---|
| `settings.css` | ~300 | blocco stile token-based |
| `primitives.tsx` | ~280 | Card, Row, Toggle, Input, Select, StatusPill, Toast |
| `useSettingAction.ts` | ~60 | wrapper azioni async |
| `modelUtils.ts` | ~40 | resolveModelId + formatExpiry |
| `SettingsShell.tsx` | ~200 | layout, nav (ordinata, icone esistenti), switch sezione, toast, Esc |
| `GeneralSection.tsx` | ~150 | tema, mode/phase, profile |
| `ProviderSection.tsx` | ~260 | griglia provider + modello/endpoint |
| `AuthCard.tsx` | ~260 | OAuth + API key (+ stepper Anthropic) |
| `AgentsSection.tsx` | ~240 | routing Kraken + delegation + verification card |
| `ExtensionsSection.tsx` | ~60 | wrapper Mcp/Skills re-skin |
| `ConnectionsSection.tsx` | ~50 | wrapper SSH/Companion re-skin |
| `SystemSection.tsx` | ~220 | versions + updates + paths + shortcuts |

Tutti ≤300 LOC (convenzione repo).

### Modificati
- `App.tsx` — blocco `view === "settings"`: monta `SettingsShell` con nuove props: `config, cli, prefs, theme, workdir, onBack, onRefresh, onThemeChange, onDefaultsChange(mode,phase), onPrefsChange(partial)`. Le callback granulari sostituiscono `onSave` (che viene eliminato). Aggiunge listener Ctrl/Cmd+, .
- `desktopPrefs.ts` — helper `patchPrefs(partial)` (merge + `saveDesktopPrefs` + ritorno nuovo oggetto).
- `McpSection`, `SkillsSection`, `SshSection`, `CompanionServeSection`, `UpdateSection`, `CliUpdateSection` — solo restyle header/classi; **props e logica invariate** (W8: SkillsSection riceve draft precompilato da `generateSkillFromUrl` → prefill form create).
- `src-tauri/src/lib.rs:1151` + `src/cli/desktopConfig.ts:236` — messaggio D7 corretto (nomina solo i flag mancanti/invalidi).

### Eliminati
- `components/SettingsView.tsx` (1437 righe)
- Da `App.css`: selettori settings (≈ righe 3194–4100 pertinenti) → sostituiti da `settings.css`; rimossi orfani `.field-inline`, `.settings-panel` e i duplicati.

### Migrazione
- localStorage `zelari-desktop-settings-tab`: mappa old→new (`provider→models`, `defaults→agents`, `system→system`, `extensions→extensions`, `connections→connections`, `updates→system`); valore sconosciuto → prima sezione.
- `DesktopPrefs` shape invariato → nessuna migrazione dati.

---

## 5. Fasi di implementazione

| Fase | Contenuto | Acceptance |
|---|---|---|
| **F1 Fondazioni** | `settings.css` + `primitives.tsx` + `useSettingAction` + `modelUtils` | I componenti compilano; storybook-less smoke: render primitives in SettingsShell vuota |
| **F2 Sezioni core** | General, Provider (+AuthCard) | Cambio provider/modello autosalva in `provider.json`; OAuth grok/chatgpt/anthropic end-to-end; API key masked |
| **F3 Agents** | AgentsSection (routing + verification) | Prefs persistono in localStorage e sopravvivono a restart app; verifier custom/clear scrive `provider.json` |
| **F4 Wrapper** | Extensions/Connections/System re-skin + W8 draft prefill | MCP add/remove, SSH test, Companion start/stop QR funzionano con nuova pelle |
| **F5 Switch & cleanup** | App.tsx monta SettingsShell, nuove props, Ctrl+, ; elimina vecchia SettingsView + CSS morto | Vecchio file assente dal tree; grep senza riferimenti orfani; build Vite ok |
| **F6 Fix & QA** | D7 (lib.rs+desktopConfig), formatExpiry, QA manuale completa | Checklist QA sotto verde |

### Checklist QA manuale (`npm run desktop:dev`)
1. Theme dark/light persiste; Esc torna alla chat; Ctrl+, apre settings.
2. Switch provider → toast ok → `--print-config` riflette; modello cambia nella toolbar dopo refresh.
3. Grok OAuth sign-in/refresh/sign-out; Anthropic stepper 3 passi; API key save → masked.
4. Endpoint save/clear su provider custom.
5. Verifier custom → save → clear → inherit.
6. Toggles Agents → restart app → valori invariati (`localStorage zelari-desktop-prefs-v2`).
7. MCP install/toggle/remove (user+project scope); skill create da URL → form precompilato → save.
8. SSH add/test/remove; pubkey print; Companion start → QR → stop.
9. Updates: check CLI (npm) + check Desktop; paths reveal apre la cartella.
10. Light theme: nav, card, select, toggle senza colori rotti.

---

## 6. Rischi e mitigazioni
- **R1 Perdita prefs (D1)**: la F5 sostituisce `onSave` con `onPrefsChange` granulare già cablato in F3 — test esplicito al punto 6 della QA.
- **R2 OAuth regressione**: AuthCard mantiene le stesse chiamate agentClient (`loginOAuth/refreshOAuth/logoutOAuth`) — nessuna modifica a Rust/CLI per OAuth.
- **R3 Scope creep**: i componenti figli esistenti NON vengono riscritti, solo re-skin. W8/D7 sono gli unici fix funzionali fuori dalla UI.
- **R4 Autosalvataggio involontario**: select/toggle commit-on-change è voluto; input testo commit solo su blur/Enter.

## 7. Out of scope (backlog)
- Ricerca nelle impostazioni; i18n IT; flag `--thinking` per provider non attivi (D3); persistenza prefs su CLI; redesign interno di Mcp/Skills form.
