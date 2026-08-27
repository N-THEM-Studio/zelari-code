# Zelari Desktop — Kraken Model Routing & Settings Tooltips

**Documento tecnico di implementazione**  
**Repository target:** `N-THEM-Studio/zelari-code`  
**Area:** `apps/desktop` + bridge Tauri  
**Baseline:** branch `main` verificato il 25 agosto 2026

---

## 1. Obiettivo

Aggiungere a **Zelari Desktop** una configurazione grafica chiara e persistente per scegliere modelli differenti per i principali ruoli interni di Kraken:

- **Explore tentacles**
- **General tentacles**
- **Verify tentacles**
- **Kraken Graph planner**

La modifica deve sfruttare capacità già presenti nel core Kraken, senza introdurre una nuova logica di routing lato agent.

Le variabili già supportate dal core sono:

```text
ZELARI_KRAKEN_EXPLORE_MODEL
ZELARI_KRAKEN_GENERAL_MODEL
ZELARI_KRAKEN_VERIFY_MODEL
ZELARI_KRAKEN_PLANNER_MODEL
```

Esiste inoltre:

```text
ZELARI_KRAKEN_SUB_MODEL
```

ma **non va esposto nella prima versione della UI**, perché è un fallback condiviso meno intuitivo rispetto agli override espliciti.

---

## 2. Principio di progettazione

La nuova UI deve rendere semplice questa configurazione:

```text
Kraken Lead
   │
   ├── Explore      → modello rapido/economico
   ├── General      → modello forte per coding
   ├── Verify       → modello affidabile per verifica
   └── Graph Planner→ modello rapido per planning strutturato
```

Il **Lead model** continua a essere controllato dal normale selettore modello della toolbar / Provider settings.

La nuova sezione non deve duplicare il selettore principale.

---

## 3. Distinzione fondamentale: Verify tentacle vs Advisory verifier

La Desktop possiede già una configurazione denominata, concettualmente, **Kraken — Verification model**.

Quella configurazione va mantenuta distinta dalla nuova voce **Verify tentacle model**.

### Verify tentacle

È il modello usato dai sub-agent Kraken di tipo `verify`.

Override core:

```text
ZELARI_KRAKEN_VERIFY_MODEL
```

Scopo:

- controllare modifiche;
- eseguire verifiche;
- analizzare test/build;
- restituire evidenza al parent Kraken.

### Advisory verifier

È invece un giudice LLM aggiuntivo e consultivo già previsto dalla Desktop.

Può avere una configurazione provider/modello separata e non deve essere confuso con il tentacolo `verify`.

### Regola UX

Usare sempre due etichette differenti:

```text
Verify tentacle model
Advisory verification model
```

Non usare semplicemente `Verification model` per entrambi.

---

# 4. Posizione nella UI

Aggiungere una nuova card in:

```text
Settings
└── Defaults
    └── Kraken — Model Routing
```

Non inserirla nella tab `Provider`, tranne il già esistente **Advisory verification model**.

Motivo:

- `Provider` gestisce il provider/modello principale e il verifier consultivo;
- `Defaults` gestisce comportamento ed execution profile;
- il model routing Kraken è una preferenza di esecuzione.

---

# 5. Mockup della nuova sezione

```text
┌─────────────────────────────────────────────────────┐
│ Kraken — Model Routing                              │
│                                                     │
│ Configure which model Kraken uses for each role.   │
│ Empty / inherit values fall back to Kraken defaults.│
│                                                     │
│ Lead model                                    ⓘ     │
│ Current toolbar model: <active model>                │
│                                                     │
│ Explore tentacles                             ⓘ     │
│ [ Inherit / Same as default                 ▼ ]     │
│                                                     │
│ General tentacles                             ⓘ     │
│ [ Inherit / Same as Kraken lead             ▼ ]     │
│                                                     │
│ Verify tentacles                              ⓘ     │
│ [ Inherit / Same as default                 ▼ ]     │
│                                                     │
│ Graph planner                                 ⓘ     │
│ [ Inherit / Same as Kraken lead             ▼ ]     │
│                                                     │
│ Advisory verifier                            ⓘ     │
│ Configured separately in Provider settings          │
└─────────────────────────────────────────────────────┘
```

---

# 6. Comportamento dei selector

Ogni selector deve contenere:

1. una voce **Inherit / Same as default**;
2. i modelli scoperti per il provider corrente;
3. opzionalmente una voce **Custom model…** per inserire manualmente un model id.

### Valore vuoto

Il valore persistito:

```ts
""
```

significa:

```text
nessun override Desktop
```

e quindi deve tradursi in assenza della relativa env var nel processo CLI.

### Modello non più disponibile

Se un modello salvato non compare più nella lista scoperta:

- non cancellare automaticamente il valore;
- mostrarlo come `Saved custom model`;
- permettere all'utente di cambiarlo;
- evitare silent fallback.

Esempio:

```text
General tentacles
[ old-model-id  (saved custom model) ▼ ]
```

---

# 7. Tooltip hover — requisiti UX

Ogni funzione della nuova sezione deve avere un'icona informativa, ad esempio:

```text
ⓘ
```

oppure un'icona SVG coerente con lo stile esistente.

Il tooltip deve apparire:

- al **mouse hover**;
- al **keyboard focus**;
- con `aria-describedby` o equivalente;
- senza richiedere click;
- senza bloccare il selector;
- chiudibile con `Escape`;
- leggibile anche in tema dark/light.

## Accessibilità minima

L'elemento trigger deve essere raggiungibile da tastiera:

```tsx
<button
  type="button"
  className="settings-help"
  aria-label="Help: Explore tentacles"
  aria-describedby="tooltip-kraken-explore"
>
  …
</button>
```

Non usare un tooltip disponibile esclusivamente con `:hover`.

---

# 8. Testo esatto consigliato per i tooltip

## 8.1 Lead model

**Titolo**

```text
Kraken Lead
```

**Tooltip**

```text
The main Kraken model. It coordinates the task, decides when to delegate
work to tentacles, evaluates their results, and produces the final response.
This model is selected from the main model control in the toolbar.
```

Versione breve:

```text
Main Kraken coordinator. Uses the model selected in the toolbar.
```

---

## 8.2 Explore tentacles

**Titolo**

```text
Explore tentacles
```

**Tooltip**

```text
Read-oriented Kraken sub-agents used to inspect the repository, locate
symbols, understand architecture and gather context. A fast, lower-cost
model is usually sufficient because Explore normally does not implement
the final code changes.
```

Versione breve:

```text
Repository exploration and codebase analysis. A fast model is usually enough.
```

---

## 8.3 General tentacles

**Titolo**

```text
General tentacles
```

**Tooltip**

```text
Code-writing Kraken sub-agents used for implementation tasks. They may edit
files and perform delegated coding work. Prefer a strong coding model when
the task is complex or the changes are high impact.
```

Versione breve:

```text
Implementation and code-writing sub-agents. Prefer a strong coding model.
```

---

## 8.4 Verify tentacles

**Titolo**

```text
Verify tentacles
```

**Tooltip**

```text
Kraken sub-agents dedicated to checking completed work. They can review
changes, inspect test/build results and look for regressions before the
parent agent considers the task complete. This is different from the
Advisory verification model.
```

Versione breve:

```text
Checks implementation, tests and regressions. Different from the Advisory verifier.
```

---

## 8.5 Graph planner

**Titolo**

```text
Graph planner
```

**Tooltip**

```text
Model used to plan Kraken Graph tasks as a dependency graph (DAG). It decides
how a large goal can be split into nodes and which work can run in parallel.
A fast non-reasoning or lower-latency model is often sufficient for this
structured planning step.
```

Versione breve:

```text
Plans the Kraken Graph DAG. A fast, low-latency model is usually sufficient.
```

---

## 8.6 Advisory verifier

**Titolo**

```text
Advisory verifier
```

**Tooltip**

```text
Optional LLM judge that provides an additional review of Kraken's result.
It is advisory and does not replace deterministic verification gates.
Its provider and model are configured separately in Provider settings.
```

Versione breve:

```text
Optional LLM judge. Configured separately under Provider settings.
```

---

## 8.7 Inherit / Same as default

Il tooltip sul valore `Inherit` deve spiegare esplicitamente che non viene impostato un override.

```text
No Desktop override is sent for this role. Kraken uses its normal model
selection and fallback rules.
```

Questo evita che l'utente interpreti `Inherit` come una copia statica del model id corrente.

---

# 9. Tooltip consigliati anche per le funzioni esistenti

Per coerenza, la stessa UX con icona `ⓘ` dovrebbe essere applicata alle funzioni avanzate già presenti in **Settings → Defaults**.

## Kraken strict gate

```text
Requires sufficient verification evidence before Kraken can mark a task as
complete. An unknown verification state is not treated as a pass.
```

## Mission strict gate

```text
Applies strict completion evidence rules to Zelari/Mission runs before the
mission can be considered complete.
```

## Native criteria pack

```text
Runs deterministic project checks such as typecheck, tests and build when
the project exposes the corresponding commands.
```

## Advisory verifier review

```text
Controls whether Zelari asks the configured advisory verification model for
an additional LLM review. This review does not replace deterministic gates.
```

## Best-of-N alpha

```text
Experimental test-time compute mode that generates and evaluates multiple
candidate solutions. It can increase quality on difficult tasks but also
increases latency and model usage.
```

## Gauntlet Loop

```text
Runs iterative builder-versus-critic rounds so the implementation can be
challenged and revised multiple times. Intended for difficult tasks and
higher verification effort.
```

## Execution profile

```text
Selects the capability profile used by the Desktop execution pipeline.
kraken/v1 is the normal Kraken profile; other profiles change the available
agent workflow and capabilities.
```

---

# 10. Tooltip component consigliato

Evitare di duplicare markup/CSS per ogni voce.

Creare un piccolo componente riutilizzabile, ad esempio:

```tsx
type SettingHelpProps = {
  id: string;
  label: string;
  children: React.ReactNode;
};

function SettingHelp({ id, label, children }: SettingHelpProps) {
  return (
    <span className="setting-help">
      <button
        type="button"
        className="setting-help-trigger"
        aria-label={`Help: ${label}`}
        aria-describedby={id}
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="setting-help-icon"
        >
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M8 7.2v4M8 4.6v.2"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <span
        id={id}
        role="tooltip"
        className="setting-help-tooltip"
      >
        {children}
      </span>
    </span>
  );
}
```

CSS indicativo:

```css
.setting-help {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.setting-help-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.65;
  cursor: help;
}

.setting-help-trigger:hover,
.setting-help-trigger:focus-visible {
  opacity: 1;
}

.setting-help-tooltip {
  position: absolute;
  z-index: 100;
  width: min(320px, 70vw);
  padding: 8px 10px;
  border-radius: 8px;

  opacity: 0;
  visibility: hidden;
  pointer-events: none;

  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
}

.setting-help:hover .setting-help-tooltip,
.setting-help:focus-within .setting-help-tooltip {
  opacity: 1;
  visibility: visible;
}
```

### Nota

Usare i token/colori già esistenti della Desktop invece di hardcodare colori nel CSS finale.

Se Zelari Desktop possiede già un componente Tooltip condiviso, riutilizzare quello al posto di introdurne uno nuovo.

---

# 11. Modifica `desktopPrefs.ts`

File:

```text
apps/desktop/src/desktopPrefs.ts
```

La struttura corrente persiste le execution prefs in `localStorage`.

Estendere `DesktopPrefs`:

```ts
export interface DesktopPrefs {
  profile: ExecutionProfile;
  strictDone: boolean;
  missionStrict: boolean;
  verifyPack: boolean;
  verifierReview: VerifierReviewPreference;
  bonAlpha: boolean;
  gauntletLoop: boolean;

  /** Kraken read-oriented exploration model override. Empty = inherit. */
  krakenExploreModel: string;

  /** Kraken code-writing general tentacle model override. Empty = inherit. */
  krakenGeneralModel: string;

  /** Kraken verify tentacle model override. Empty = inherit. */
  krakenVerifyModel: string;

  /** Kraken Graph planner model override. Empty = inherit. */
  krakenPlannerModel: string;
}
```

Aggiornare i default:

```ts
export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  profile: "kraken/v1",
  strictDone: false,
  missionStrict: true,
  verifyPack: false,
  verifierReview: null,
  bonAlpha: false,
  gauntletLoop: false,

  krakenExploreModel: "",
  krakenGeneralModel: "",
  krakenVerifyModel: "",
  krakenPlannerModel: "",
};
```

Aggiornare `normalizeDesktopPrefs()`:

```ts
krakenExploreModel:
  typeof r.krakenExploreModel === "string" ? r.krakenExploreModel : "",

krakenGeneralModel:
  typeof r.krakenGeneralModel === "string" ? r.krakenGeneralModel : "",

krakenVerifyModel:
  typeof r.krakenVerifyModel === "string" ? r.krakenVerifyModel : "",

krakenPlannerModel:
  typeof r.krakenPlannerModel === "string" ? r.krakenPlannerModel : "",
```

---

# 12. Compatibilità delle preferenze esistenti

L'attuale storage key è:

```text
zelari-desktop-prefs-v2
```

Non è necessario aumentare la versione della key se:

- i nuovi campi sono opzionali in lettura;
- `normalizeDesktopPrefs()` assegna `""` ai valori mancanti;
- le vecchie installazioni continuano a caricarsi correttamente.

Se invece si decide di cambiare semanticamente la struttura in modo incompatibile, introdurre `v3`.

Per questa modifica **non è necessario**.

---

# 13. Modifica `SettingsView.tsx`

File:

```text
apps/desktop/src/components/SettingsView.tsx
```

Aggiungere gli state:

```ts
const [krakenExploreModel, setKrakenExploreModel] =
  useState(prefs.krakenExploreModel);

const [krakenGeneralModel, setKrakenGeneralModel] =
  useState(prefs.krakenGeneralModel);

const [krakenVerifyModel, setKrakenVerifyModel] =
  useState(prefs.krakenVerifyModel);

const [krakenPlannerModel, setKrakenPlannerModel] =
  useState(prefs.krakenPlannerModel);
```

Sincronizzarli quando cambiano le props:

```ts
setKrakenExploreModel(prefs.krakenExploreModel);
setKrakenGeneralModel(prefs.krakenGeneralModel);
setKrakenVerifyModel(prefs.krakenVerifyModel);
setKrakenPlannerModel(prefs.krakenPlannerModel);
```

Includerli nel payload `prefs` di `onSave()`:

```ts
prefs: {
  profile,
  strictDone,
  missionStrict,
  verifyPack,
  verifierReview,
  bonAlpha,
  gauntletLoop,

  krakenExploreModel,
  krakenGeneralModel,
  krakenVerifyModel,
  krakenPlannerModel,
},
```

---

# 14. Componente selector riutilizzabile

Per evitare quattro implementazioni quasi identiche, creare un componente locale o condiviso:

```tsx
type KrakenModelSelectProps = {
  label: string;
  tooltipId: string;
  tooltip: string;
  value: string;
  models: string[];
  inheritLabel: string;
  onChange: (value: string) => void;
};

function KrakenModelSelect({
  label,
  tooltipId,
  tooltip,
  value,
  models,
  inheritLabel,
  onChange,
}: KrakenModelSelectProps) {
  return (
    <div className="settings-field">
      <div className="settings-field-label">
        <span>{label}</span>
        <SettingHelp id={tooltipId} label={label}>
          {tooltip}
        </SettingHelp>
      </div>

      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{inheritLabel}</option>

        {!models.includes(value) && value ? (
          <option value={value}>
            {value} — saved custom model
          </option>
        ) : null}

        {models.map((modelId) => (
          <option key={modelId} value={modelId}>
            {modelId}
          </option>
        ))}
      </select>
    </div>
  );
}
```

---

# 15. Semantica consigliata dei fallback

UI:

```text
Explore
Inherit / Kraken default
```

Backend:

```text
"" → non impostare ZELARI_KRAKEN_EXPLORE_MODEL
```

UI:

```text
General
Inherit / Kraken lead
```

Backend:

```text
"" → non impostare ZELARI_KRAKEN_GENERAL_MODEL
```

UI:

```text
Verify
Inherit / Kraken default
```

Backend:

```text
"" → non impostare ZELARI_KRAKEN_VERIFY_MODEL
```

UI:

```text
Graph planner
Inherit / Kraken lead
```

Backend:

```text
"" → non impostare ZELARI_KRAKEN_PLANNER_MODEL
```

La UI descrive il fallback per l'utente, ma il bridge non deve tentare di replicare la logica Kraken.

Il core rimane la source of truth per la risoluzione finale.

---

# 16. Modifica `types.ts`

File:

```text
apps/desktop/src/types.ts
```

Estendere `RunTaskArgs`:

```ts
/** Model override for Kraken read-only / exploration tentacles. */
krakenExploreModel?: string;

/** Model override for Kraken general code-writing tentacles. */
krakenGeneralModel?: string;

/** Model override for Kraken verify tentacles. */
krakenVerifyModel?: string;

/** Model override for Kraken Graph planning. */
krakenPlannerModel?: string;
```

Non è necessario aggiungere provider separati in questa feature.

---

# 17. Modifica `App.tsx`

File:

```text
apps/desktop/src/App.tsx
```

Nel payload passato a `runTask()` aggiungere:

```ts
krakenExploreModel: prefs.krakenExploreModel || undefined,
krakenGeneralModel: prefs.krakenGeneralModel || undefined,
krakenVerifyModel: prefs.krakenVerifyModel || undefined,
krakenPlannerModel: prefs.krakenPlannerModel || undefined,
```

Questo deve avvenire nello stesso punto in cui vengono già inoltrate:

```text
profile
strictDone
missionStrict
verifyPack
verifierReview
bonAlpha
gauntletLoop
```

---

# 18. `agentClient.ts`

File:

```text
apps/desktop/src/agentClient.ts
```

Se il client continua a inoltrare genericamente/spreadare `RunTaskArgs` nel comando Tauri:

```ts
invoke("run_task", ...)
```

non dovrebbe essere necessaria logica specifica.

Verificare soltanto che:

- nessuna whitelist rimuova i nuovi campi;
- i nomi arrivino camelCase al bridge Rust.

---

# 19. Modifica Tauri `RunTaskArgs`

File:

```text
apps/desktop/src-tauri/src/lib.rs
```

Aggiungere alla struct Rust:

```rust
#[serde(default)]
kraken_explore_model: Option<String>,

#[serde(default)]
kraken_general_model: Option<String>,

#[serde(default)]
kraken_verify_model: Option<String>,

#[serde(default)]
kraken_planner_model: Option<String>,
```

La struct usa:

```rust
#[serde(rename_all = "camelCase")]
```

quindi i mapping attesi sono:

```text
krakenExploreModel → kraken_explore_model
krakenGeneralModel → kraken_general_model
krakenVerifyModel  → kraken_verify_model
krakenPlannerModel → kraken_planner_model
```

---

# 20. Passaggio a `spawn_headless()`

Estrarre i nuovi valori da `args` nello stesso percorso delle altre execution prefs:

```rust
let kraken_explore_model = args.kraken_explore_model;
let kraken_general_model = args.kraken_general_model;
let kraken_verify_model = args.kraken_verify_model;
let kraken_planner_model = args.kraken_planner_model;
```

Passarli fino alla funzione che crea il processo:

```text
zelari-code --headless
```

---

# 21. Environment variables nel processo CLI

Aggiungere una helper:

```rust
fn set_optional_model_env(
    cmd: &mut Command,
    key: &str,
    value: Option<&str>,
) {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => {
            cmd.env(key, v);
        }
        None => {
            cmd.env_remove(key);
        }
    }
}
```

Applicazione:

```rust
set_optional_model_env(
    &mut cmd,
    "ZELARI_KRAKEN_EXPLORE_MODEL",
    kraken_explore_model.as_deref(),
);

set_optional_model_env(
    &mut cmd,
    "ZELARI_KRAKEN_GENERAL_MODEL",
    kraken_general_model.as_deref(),
);

set_optional_model_env(
    &mut cmd,
    "ZELARI_KRAKEN_VERIFY_MODEL",
    kraken_verify_model.as_deref(),
);

set_optional_model_env(
    &mut cmd,
    "ZELARI_KRAKEN_PLANNER_MODEL",
    kraken_planner_model.as_deref(),
);
```

---

# 22. Perché usare `env_remove()` quando il valore è vuoto

La Desktop deve essere autoritativa.

Caso:

1. l'utente avvia Zelari da una shell contenente:

```text
ZELARI_KRAKEN_GENERAL_MODEL=old-model
```

2. nella Desktop seleziona:

```text
General tentacles → Inherit
```

Se il bridge non rimuove esplicitamente la env, il processo figlio potrebbe continuare a ereditare:

```text
old-model
```

contraddicendo la UI.

Perciò:

```text
Desktop override valorizzato
→ cmd.env(...)

Desktop = Inherit
→ cmd.env_remove(...)
```

---

# 23. Provider routing: fuori scope

Questa feature deve configurare soltanto:

```text
*_MODEL
```

Non introdurre:

```text
ZELARI_KRAKEN_EXPLORE_PROVIDER
ZELARI_KRAKEN_GENERAL_PROVIDER
ZELARI_KRAKEN_VERIFY_PROVIDER
ZELARI_KRAKEN_PLANNER_PROVIDER
```

a meno che il core non aggiunga esplicitamente supporto per essi.

### Prima versione

Tutti i tentacoli operano nel normale runtime/provider compatibile con gli override modello previsti dal core.

### Feature futura separata

Il routing cross-provider potrebbe diventare:

```text
Explore → Provider A / Model X
General → Provider B / Model Y
Verify  → Provider C / Model Z
```

ma richiede modifiche al core e non va mescolato con questa patch Desktop.

---

# 24. Gestione del modello principale

Il nuovo pannello deve mostrare il Lead model in sola lettura:

```text
Lead model
Current toolbar model: <model>
```

con eventuale link/bottone:

```text
Change in Provider
```

oppure:

```text
Change from toolbar
```

Non creare un secondo selector per il Lead dentro `Kraken — Model Routing`.

---

# 25. Configurazione consigliata visualizzata nella UI

Facoltativamente la card può mostrare un piccolo hint non prescrittivo:

```text
Typical setup:
Explore → fast / low-cost
General → strongest coding model
Verify → reliable coding/review model
Planner → fast / low-latency
```

Non scegliere automaticamente modelli specifici.

Zelari non deve assumere che un determinato provider o model id sia sempre disponibile.

---

# 26. Test unitari — `desktop-prefs.test.ts`

File indicato dal codice corrente:

```text
tests/unit/desktop-prefs.test.ts
```

Aggiungere test per:

## Default

```ts
expect(DEFAULT_DESKTOP_PREFS.krakenExploreModel).toBe("");
expect(DEFAULT_DESKTOP_PREFS.krakenGeneralModel).toBe("");
expect(DEFAULT_DESKTOP_PREFS.krakenVerifyModel).toBe("");
expect(DEFAULT_DESKTOP_PREFS.krakenPlannerModel).toBe("");
```

## Normalizzazione legacy

Dato un vecchio blob senza i nuovi campi:

```ts
normalizeDesktopPrefs({
  profile: "kraken/v1",
  strictDone: true,
})
```

atteso:

```text
krakenExploreModel = ""
krakenGeneralModel = ""
krakenVerifyModel  = ""
krakenPlannerModel = ""
```

## Persistenza

Salvare:

```ts
{
  krakenExploreModel: "fast-model",
  krakenGeneralModel: "coding-model",
  krakenVerifyModel: "review-model",
  krakenPlannerModel: "planner-model",
}
```

e verificare round-trip corretto.

## Input invalidi

Per valori:

```ts
null
false
123
{}
```

il normalizer deve ritornare:

```text
""
```

---

# 27. Test UI

Aggiungere test, se l'attuale stack Desktop dispone di test componenti, per verificare:

- la card `Kraken — Model Routing` è visibile in `Defaults`;
- il valore `Inherit` corrisponde a `""`;
- i model id scoperti sono mostrati;
- un model id salvato ma non scoperto resta selezionabile;
- il save produce i quattro campi;
- ogni funzione possiede il relativo trigger tooltip;
- il tooltip appare su hover;
- il tooltip appare su keyboard focus;
- `aria-describedby` punta al tooltip corretto.

---

# 28. Test Rust / bridge

Aggiungere o estendere i test del command building per verificare:

```text
krakenExploreModel = "model-a"
→ ZELARI_KRAKEN_EXPLORE_MODEL=model-a
```

```text
krakenGeneralModel = "model-b"
→ ZELARI_KRAKEN_GENERAL_MODEL=model-b
```

```text
krakenVerifyModel = "model-c"
→ ZELARI_KRAKEN_VERIFY_MODEL=model-c
```

```text
krakenPlannerModel = "model-d"
→ ZELARI_KRAKEN_PLANNER_MODEL=model-d
```

E soprattutto:

```text
krakenGeneralModel = None / ""
→ ZELARI_KRAKEN_GENERAL_MODEL non presente
```

---

# 29. Acceptance criteria

La feature è completata quando:

- [ ] In `Settings → Defaults` esiste `Kraken — Model Routing`.
- [ ] L'utente può configurare Explore, General, Verify e Graph Planner.
- [ ] Il Lead model continua a essere selezionato dalla toolbar/provider principale.
- [ ] Le preferenze persistono dopo il riavvio della Desktop.
- [ ] Le vecchie preferenze `zelari-desktop-prefs-v2` continuano a essere valide.
- [ ] `Inherit` non salva un model id esplicito.
- [ ] Un valore `Inherit` rimuove l'eventuale env Kraken ereditata dal processo parent.
- [ ] Explore imposta `ZELARI_KRAKEN_EXPLORE_MODEL`.
- [ ] General imposta `ZELARI_KRAKEN_GENERAL_MODEL`.
- [ ] Verify imposta `ZELARI_KRAKEN_VERIFY_MODEL`.
- [ ] Planner imposta `ZELARI_KRAKEN_PLANNER_MODEL`.
- [ ] Verify tentacle e Advisory verifier sono chiaramente distinti nella UI.
- [ ] Ogni funzione possiede un tooltip hover/focus.
- [ ] I tooltip sono accessibili da tastiera.
- [ ] I tooltip funzionano sia in dark mode sia in light mode.
- [ ] I test di persistenza Desktop passano.
- [ ] I test del bridge env passano.
- [ ] Build TypeScript/Desktop passa.
- [ ] Build Rust/Tauri passa.

---

# 30. File da modificare

## Obbligatori

```text
apps/desktop/src/desktopPrefs.ts
apps/desktop/src/components/SettingsView.tsx
apps/desktop/src/types.ts
apps/desktop/src/App.tsx
apps/desktop/src-tauri/src/lib.rs
tests/unit/desktop-prefs.test.ts
```

## Probabili / da verificare

```text
apps/desktop/src/*.css
apps/desktop/src/components/*.css
```

per lo styling del tooltip, a seconda di dove sono definiti gli stili Settings.

## Probabilmente invariato

```text
apps/desktop/src/agentClient.ts
```

se continua a inoltrare genericamente `RunTaskArgs`.

---

# 31. Modifiche da NON fare in questa patch

Non modificare il core Kraken se le env attuali vengono già lette correttamente.

Non introdurre routing cross-provider.

Non esporre subito `ZELARI_KRAKEN_SUB_MODEL`.

Non fondere `Verify tentacle` e `Advisory verifier`.

Non cambiare il comportamento di Kraken quando tutti i nuovi selector sono su `Inherit`.

Non modificare i default del modello principale.

---

# 32. Possibile fase 2

Dopo questa feature si possono considerare:

## Shared sub-agent fallback

Esporre:

```text
ZELARI_KRAKEN_SUB_MODEL
```

sotto:

```text
Advanced
└── Shared sub-agent fallback
```

## Preset di routing

Esempi:

```text
Balanced
Performance
Cost saver
All same as lead
```

senza hardcodare model id, ma scegliendo ruoli/fallback in base alle capabilities disponibili.

## Per-project routing

Salvare gli override anche a livello progetto:

```text
.zelari/
```

con priorità:

```text
project override
→ desktop global preference
→ Kraken core fallback
```

solo dopo aver definito chiaramente la precedenza.

## Cross-provider routing

Da sviluppare soltanto dopo supporto esplicito nel core.

---

# 33. Esempio di esperienza finale

L'utente apre:

```text
Settings → Defaults
```

e configura:

```text
Profile
kraken/v1

Kraken strict gate
ON

Native criteria pack
ON

Kraken — Model Routing

Lead
current-main-model

Explore
fast-model

General
strong-coding-model

Verify
review-model

Graph planner
fast-model
```

Passando il mouse su `Explore ⓘ` vede:

```text
Repository exploration and codebase analysis.
A fast model is usually enough.
```

Passando il mouse su `Verify ⓘ` vede:

```text
Checks implementation, tests and regressions.
Different from the Advisory verifier.
```

Quando avvia un task, la Desktop costruisce il processo headless con:

```text
ZELARI_KRAKEN_EXPLORE_MODEL=fast-model
ZELARI_KRAKEN_GENERAL_MODEL=strong-coding-model
ZELARI_KRAKEN_VERIFY_MODEL=review-model
ZELARI_KRAKEN_PLANNER_MODEL=fast-model
```

senza alcuna modifica al comportamento interno di Kraken oltre al routing modello già supportato.

---

# 34. Architettura finale

```text
┌─────────────────────────────────────────┐
│ Zelari Desktop                          │
│                                         │
│ Settings → Defaults                     │
│ Kraken — Model Routing                  │
│                                         │
│ Explore ───────────── fast-model        │
│ General ───────────── coding-model      │
│ Verify  ───────────── review-model      │
│ Planner ───────────── planner-model     │
└─────────────────────┬───────────────────┘
                      │
                      ▼
             DesktopPrefs / localStorage
                      │
                      ▼
                   App.tsx
                      │
                      ▼
                 RunTaskArgs
                      │
                      ▼
              Tauri run_task
                      │
                      ▼
               spawn_headless
                      │
                      ▼
     ┌────────────────────────────────┐
     │ Environment                    │
     │                                │
     │ KRAKEN_EXPLORE_MODEL           │
     │ KRAKEN_GENERAL_MODEL           │
     │ KRAKEN_VERIFY_MODEL            │
     │ KRAKEN_PLANNER_MODEL           │
     └───────────────┬────────────────┘
                     │
                     ▼
              zelari-code --headless
                     │
                     ▼
                   Kraken
           ┌─────────┼─────────┐
           ▼         ▼         ▼
        Explore    General   Verify
                     │
                     ▼
               Graph Planner
```

---

# 35. Sintesi

La feature proposta è principalmente una **estensione della Desktop UI e del bridge Tauri**.

Il core Kraken dispone già degli override modello necessari.

La patch deve quindi:

1. aggiungere quattro preferenze persistenti;
2. esporle nella UI `Settings → Defaults`;
3. aggiungere tooltip hover/focus chiari per ogni funzione;
4. inoltrare i valori a `RunTaskArgs`;
5. convertirli nelle env Kraken nel processo headless;
6. mantenere `Inherit` come assenza reale di override;
7. mantenere separati Verify tentacle e Advisory verifier;
8. aggiungere test di persistenza, UI e bridge.

Il risultato finale rende configurabile dalla Desktop una capacità Kraken già esistente nel motore, senza alterarne l'architettura interna.
