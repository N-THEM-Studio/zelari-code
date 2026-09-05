# Zelari Desktop - Kraken Model Routing & Settings Tooltips

**Technical implementation document**
**Target repository:** `N-THEM-Studio/zelari-code`
**Area:** `apps/desktop` + Tauri bridge
**Baseline:** `main` branch verified on August 25, 2026

---

## 1. Goal

Add to **Zelari Desktop** a clear, persistent graphical configuration to choose different models for the main internal Kraken roles:

- **Explore tentacles**
- **General tentacles**
- **Verify tentacles**
- **Kraken Graph planner**

The change must leverage capabilities already present in the Kraken core, without introducing new agent-side routing logic.

The variables already supported by the core are:

```text
ZELARI_KRAKEN_EXPLORE_MODEL
ZELARI_KRAKEN_GENERAL_MODEL
ZELARI_KRAKEN_VERIFY_MODEL
ZELARI_KRAKEN_PLANNER_MODEL
```

There is also:

```text
ZELARI_KRAKEN_SUB_MODEL
```

but it must **not be exposed in the first version of the UI**, because it is a shared fallback that is less intuitive than the explicit overrides.

---

## 2. Design principle

The new UI must make this configuration simple:

```text
Kraken Lead
   |
   |-> Explore      -> fast/cheap model
   |-> General      -> strong coding model
   |-> Verify       -> reliable verification model
   |-> Graph Planner-> fast model for structured planning
```

The **Lead model** remains controlled by the normal toolbar / Provider settings model selector.

The new section must not duplicate the main selector.

---

## 3. Fundamental distinction: Verify tentacle vs Advisory verifier

The Desktop already has a configuration conceptually named **Kraken - Verification model**.

That configuration must be kept distinct from the new **Verify tentacle model** entry.

### Verify tentacle

It is the model used by Kraken sub-agents of type `verify`.

Core override:

```text
ZELARI_KRAKEN_VERIFY_MODEL
```

Purpose:

- review changes;
- run verifications;
- analyze test/build results;
- return evidence to the Kraken parent.

### Advisory verifier

It is instead an additional, advisory LLM judge already provided by the Desktop.

It can have a separate provider/model configuration and must not be confused with the `verify` tentacle.

### UX rule

Always use two different labels:

```text
Verify tentacle model
Advisory verification model
```

Do not simply use `Verification model` for both.

---

# 4. UI location

Add a new card in:

```text
Settings
|-> Defaults
    |-> Kraken - Model Routing
```

Do not put it in the `Provider` tab, except for the already existing **Advisory verification model**.

Reason:

- `Provider` manages the main provider/model and the advisory verifier;
- `Defaults` manages behavior and execution profile;
- Kraken model routing is an execution preference.

---

# 5. Mockup of the new section

```text
+----------------------------------------------------+
| Kraken - Model Routing                              |
|                                                     |
| Configure which model Kraken uses for each role.   |
| Empty / inherit values fall back to Kraken defaults.|
|                                                     |
| Lead model                                    ?     |
| Current toolbar model: <active model>                |
|                                                     |
| Explore tentacles                             ?     |
| [ Inherit / Same as default                  v ]     |
|                                                     |
| General tentacles                             ?     |
| [ Inherit / Same as Kraken lead              v ]     |
|                                                     |
| Verify tentacles                              ?     |
| [ Inherit / Same as default                  v ]     |
|                                                     |
| Graph planner                                 ?     |
| [ Inherit / Same as Kraken lead              v ]     |
|                                                     |
| Advisory verifier                            ?     |
| Configured separately in Provider settings          |
+----------------------------------------------------+
```

---

# 6. Selector behavior

Each selector must contain:

1. an **Inherit / Same as default** entry;
2. the models discovered for the current provider;
3. optionally a **Custom model...** entry to manually enter a model id.

### Empty value

The persisted value:

```ts
""
```

means:

```text
no Desktop override
```

and therefore must translate into the absence of the related env var in the CLI process.

### Model no longer available

If a saved model no longer appears in the discovered list:

- do not automatically delete the value;
- show it as `Saved custom model`;
- allow the user to change it;
- avoid silent fallback.

Example:

```text
General tentacles
[ old-model-id  (saved custom model) v ]
```

---

# 7. Hover tooltip - UX requirements

Every function in the new section must have an info icon, for example:

```text
?
```

or an SVG icon consistent with the existing style.

The tooltip must appear:

- on **mouse hover**;
- on **keyboard focus**;
- with `aria-describedby` or equivalent;
- without requiring a click;
- without blocking the selector;
- closable with `Escape`;
- readable in both dark/light themes.

## Minimum accessibility

The trigger element must be keyboard reachable:

```tsx
<button
  type="button"
  className="settings-help"
  aria-label="Help: Explore tentacles"
  aria-describedby="tooltip-kraken-explore"
>
  ?
</button>
```

Do not use a tooltip available exclusively via `:hover`.

---

# 8. Recommended exact tooltip text

## 8.1 Lead model

**Title**

```text
Kraken Lead
```

**Tooltip**

```text
The main Kraken model. It coordinates the task, decides when to delegate
work to tentacles, evaluates their results, and produces the final response.
This model is selected from the main model control in the toolbar.
```

Short version:

```text
Main Kraken coordinator. Uses the model selected in the toolbar.
```

---

## 8.2 Explore tentacles

**Title**

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

Short version:

```text
Repository exploration and codebase analysis. A fast model is usually enough.
```

---

## 8.3 General tentacles

**Title**

```text
General tentacles
```

**Tooltip**

```text
Code-writing Kraken sub-agents used for implementation tasks. They may edit
files and perform delegated coding work. Prefer a strong coding model when
the task is complex or the changes are high impact.
```

Short version:

```text
Implementation and code-writing sub-agents. Prefer a strong coding model.
```

---

## 8.4 Verify tentacles

**Title**

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

Short version:

```text
Checks implementation, tests and regressions. Different from the Advisory verifier.
```

---

## 8.5 Graph planner

**Title**

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

Short version:

```text
Plans the Kraken Graph DAG. A fast, low-latency model is usually sufficient.
```

---

## 8.6 Advisory verifier

**Title**

```text
Advisory verifier
```

**Tooltip**

```text
Optional LLM judge that provides an additional review of Kraken's result.
It is advisory and does not replace deterministic verification gates.
Its provider and model are configured separately in Provider settings.
```

Short version:

```text
Optional LLM judge. Configured separately under Provider settings.
```

---

## 8.7 Inherit / Same as default

The tooltip on the `Inherit` value must explicitly explain that no override is set.

```text
No Desktop override is sent for this role. Kraken uses its normal model
selection and fallback rules.
```

This prevents the user from interpreting `Inherit` as a static copy of the current model id.

---

# 9. Recommended tooltips for existing functions too

For consistency, the same `?` icon UX should be applied to the advanced functions already present in **Settings -> Defaults**.

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

# 10. Recommended tooltip component

Avoid duplicating markup/CSS for each entry.

Create a small reusable component, for example:

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

Indicative CSS:

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

### Note

Use the Desktop's existing tokens/colors instead of hardcoding colors in the final CSS.

If Zelari Desktop already has a shared Tooltip component, reuse it instead of introducing a new one.

---

# 11. `desktopPrefs.ts` change

File:

```text
apps/desktop/src/desktopPrefs.ts
```

The current structure persists execution prefs in `localStorage`.

Extend `DesktopPrefs`:

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

Update the defaults:

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

Update `normalizeDesktopPrefs()`:

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

# 12. Compatibility with existing preferences

The current storage key is:

```text
zelari-desktop-prefs-v2
```

It is not necessary to bump the key version if:

- the new fields are optional on read;
- `normalizeDesktopPrefs()` assigns `""` to missing values;
- old installations keep loading correctly.

If instead you decide to change the structure incompatibly, introduce `v3`.

For this change it is **not necessary**.

---

# 13. `SettingsView.tsx` change

File:

```text
apps/desktop/src/components/SettingsView.tsx
```

Add the states:

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

Sync them when the props change:

```ts
setKrakenExploreModel(prefs.krakenExploreModel);
setKrakenGeneralModel(prefs.krakenGeneralModel);
setKrakenVerifyModel(prefs.krakenVerifyModel);
setKrakenPlannerModel(prefs.krakenPlannerModel);
```

Include them in the `prefs` payload of `onSave()`:

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

# 14. Reusable selector component

To avoid four nearly identical implementations, create a local or shared component:

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
            {value} - saved custom model
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

# 15. Recommended fallback semantics

UI:

```text
Explore
Inherit / Kraken default
```

Backend:

```text
"" -> do not set ZELARI_KRAKEN_EXPLORE_MODEL
```

UI:

```text
General
Inherit / Kraken lead
```

Backend:

```text
"" -> do not set ZELARI_KRAKEN_GENERAL_MODEL
```

UI:

```text
Verify
Inherit / Kraken default
```

Backend:

```text
"" -> do not set ZELARI_KRAKEN_VERIFY_MODEL
```

UI:

```text
Graph planner
Inherit / Kraken lead
```

Backend:

```text
"" -> do not set ZELARI_KRAKEN_PLANNER_MODEL
```

The UI describes the fallback for the user, but the bridge must not try to replicate Kraken logic.

The core remains the source of truth for final resolution.

---

# 16. `types.ts` change

File:

```text
apps/desktop/src/types.ts
```

Extend `RunTaskArgs`:

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

No separate providers need to be added in this feature.

---

# 17. `App.tsx` change

File:

```text
apps/desktop/src/App.tsx
```

In the payload passed to `runTask()` add:

```ts
krakenExploreModel: prefs.krakenExploreModel || undefined,
krakenGeneralModel: prefs.krakenGeneralModel || undefined,
krakenVerifyModel: prefs.krakenVerifyModel || undefined,
krakenPlannerModel: prefs.krakenPlannerModel || undefined,
```

This must happen in the same place where the following are already forwarded:

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

If the client continues to generically forward/spread `RunTaskArgs` into the Tauri command:

```ts
invoke("run_task", ...)
```

no specific logic should be needed.

Only verify that:

- no whitelist strips the new fields;
- the names arrive camelCase at the Rust bridge.

---

# 19. Tauri `RunTaskArgs` change

File:

```text
apps/desktop/src-tauri/src/lib.rs
```

Add to the Rust struct:

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

The struct uses:

```rust
#[serde(rename_all = "camelCase")]
```

so the expected mappings are:

```text
krakenExploreModel -> kraken_explore_model
krakenGeneralModel -> kraken_general_model
krakenVerifyModel  -> kraken_verify_model
krakenPlannerModel -> kraken_planner_model
```

---

# 20. Passing to `spawn_headless()`

Extract the new values from `args` in the same path as the other execution prefs:

```rust
let kraken_explore_model = args.kraken_explore_model;
let kraken_general_model = args.kraken_general_model;
let kraken_verify_model = args.kraken_verify_model;
let kraken_planner_model = args.kraken_planner_model;
```

Pass them down to the function that creates the process:

```text
zelari-code --headless
```

---

# 21. Environment variables in the CLI process

Add a helper:

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

Application:

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

# 22. Why use `env_remove()` when the value is empty

The Desktop must be authoritative.

Case:

1. the user starts Zelari from a shell containing:

```text
ZELARI_KRAKEN_GENERAL_MODEL=old-model
```

2. in the Desktop selects:

```text
General tentacles -> Inherit
```

If the bridge does not explicitly remove the env, the child process could keep inheriting:

```text
old-model
```

contradicting the UI.

Therefore:

```text
Desktop override valued
-> cmd.env(...)

Desktop = Inherit
-> cmd.env_remove(...)
```

---

# 23. Provider routing: out of scope

This feature must only configure:

```text
*_MODEL
```

Do not introduce:

```text
ZELARI_KRAKEN_EXPLORE_PROVIDER
ZELARI_KRAKEN_GENERAL_PROVIDER
ZELARI_KRAKEN_VERIFY_PROVIDER
ZELARI_KRAKEN_PLANNER_PROVIDER
```

unless the core explicitly adds support for them.

### First version

All tentacles operate in the normal runtime/provider compatible with the model overrides provided by the core.

### Separate future feature

Cross-provider routing could become:

```text
Explore -> Provider A / Model X
General -> Provider B / Model Y
Verify  -> Provider C / Model Z
```

but it requires core changes and must not be mixed with this Desktop patch.

---

# 24. Handling the main model

The new panel must show the Lead model read-only:

```text
Lead model
Current toolbar model: <model>
```

with a possible link/button:

```text
Change in Provider
```

or:

```text
Change from toolbar
```

Do not create a second selector for the Lead inside `Kraken - Model Routing`.

---

# 25. Recommended configuration shown in the UI

Optionally the card can show a small non-prescriptive hint:

```text
Typical setup:
Explore -> fast / low-cost
General -> strongest coding model
Verify  -> reliable coding/review model
Planner -> fast / low-latency
```

Do not automatically pick specific models.

Zelari must not assume that a given provider or model id is always available.

---

# 26. Unit tests - `desktop-prefs.test.ts`

File indicated by the current code:

```text
tests/unit/desktop-prefs.test.ts
```

Add tests for:

## Defaults

```ts
expect(DEFAULT_DESKTOP_PREFS.krakenExploreModel).toBe("");
expect(DEFAULT_DESKTOP_PREFS.krakenGeneralModel).toBe("");
expect(DEFAULT_DESKTOP_PREFS.krakenVerifyModel).toBe("");
expect(DEFAULT_DESKTOP_PREFS.krakenPlannerModel).toBe("");
```

## Legacy normalization

Given an old blob without the new fields:

```ts
normalizeDesktopPrefs({
  profile: "kraken/v1",
  strictDone: true,
})
```

expected:

```text
krakenExploreModel = ""
krakenGeneralModel = ""
krakenVerifyModel  = ""
krakenPlannerModel = ""
```

## Persistence

Save:

```ts
{
  krakenExploreModel: "fast-model",
  krakenGeneralModel: "coding-model",
  krakenVerifyModel: "review-model",
  krakenPlannerModel: "planner-model",
}
```

and verify a correct round-trip.

## Invalid input

For values:

```ts
null
false
123
{}
```

the normalizer must return:

```text
""
```

---

# 27. UI tests

Add tests, if the current Desktop stack has component tests, to verify:

- the `Kraken - Model Routing` card is visible in `Defaults`;
- the `Inherit` value maps to `""`;
- discovered model ids are shown;
- a saved but undiscovered model id stays selectable;
- saving produces the four fields;
- every function has its tooltip trigger;
- the tooltip appears on hover;
- the tooltip appears on keyboard focus;
- `aria-describedby` points to the correct tooltip.

---

# 28. Rust / bridge tests

Add or extend the command-building tests to verify:

```text
krakenExploreModel = "model-a"
-> ZELARI_KRAKEN_EXPLORE_MODEL=model-a
```

```text
krakenGeneralModel = "model-b"
-> ZELARI_KRAKEN_GENERAL_MODEL=model-b
```

```text
krakenVerifyModel = "model-c"
-> ZELARI_KRAKEN_VERIFY_MODEL=model-c
```

```text
krakenPlannerModel = "model-d"
-> ZELARI_KRAKEN_PLANNER_MODEL=model-d
```

And most importantly:

```text
krakenGeneralModel = None / ""
-> ZELARI_KRAKEN_GENERAL_MODEL not present
```

---

# 29. Acceptance criteria

The feature is complete when:

- [ ] In `Settings -> Defaults` there is `Kraken - Model Routing`.
- [ ] The user can configure Explore, General, Verify and Graph Planner.
- [ ] The Lead model continues to be selected from the main toolbar/provider.
- [ ] Preferences persist across Desktop restarts.
- [ ] Old `zelari-desktop-prefs-v2` preferences remain valid.
- [ ] `Inherit` does not save an explicit model id.
- [ ] An `Inherit` value removes any Kraken env inherited from the parent process.
- [ ] Explore sets `ZELARI_KRAKEN_EXPLORE_MODEL`.
- [ ] General sets `ZELARI_KRAKEN_GENERAL_MODEL`.
- [ ] Verify sets `ZELARI_KRAKEN_VERIFY_MODEL`.
- [ ] Planner sets `ZELARI_KRAKEN_PLANNER_MODEL`.
- [ ] Verify tentacle and Advisory verifier are clearly distinct in the UI.
- [ ] Every function has a hover/focus tooltip.
- [ ] Tooltips are keyboard accessible.
- [ ] Tooltips work in both dark and light mode.
- [ ] Desktop persistence tests pass.
- [ ] Bridge env tests pass.
- [ ] TypeScript/Desktop build passes.
- [ ] Rust/Tauri build passes.

---

# 30. Files to modify

## Mandatory

```text
apps/desktop/src/desktopPrefs.ts
apps/desktop/src/components/SettingsView.tsx
apps/desktop/src/types.ts
apps/desktop/src/App.tsx
apps/desktop/src-tauri/src/lib.rs
tests/unit/desktop-prefs.test.ts
```

## Probable / to verify

```text
apps/desktop/src/*.css
apps/desktop/src/components/*.css
```

for the tooltip styling, depending on where the Settings styles are defined.

## Probably unchanged

```text
apps/desktop/src/agentClient.ts
```

if it continues to generically forward `RunTaskArgs`.

---

# 31. Changes NOT to make in this patch

Do not modify the Kraken core if the current envs are already read correctly.

Do not introduce cross-provider routing.

Do not expose `ZELARI_KRAKEN_SUB_MODEL` right away.

Do not merge `Verify tentacle` and `Advisory verifier`.

Do not change Kraken behavior when all the new selectors are on `Inherit`.

Do not modify the main model defaults.

---

# 32. Possible phase 2

After this feature, consider:

## Shared sub-agent fallback

Expose:

```text
ZELARI_KRAKEN_SUB_MODEL
```

under:

```text
Advanced
|-> Shared sub-agent fallback
```

## Routing presets

Examples:

```text
Balanced
Performance
Cost saver
All same as lead
```

without hardcoding model ids, but choosing roles/fallbacks based on available capabilities.

## Per-project routing

Also save the overrides at the project level:

```text
.zelari/
```

with priority:

```text
project override
-> desktop global preference
-> Kraken core fallback
```

only after clearly defining precedence.

## Cross-provider routing

To be developed only after explicit core support.

---

# 33. Example of the final experience

The user opens:

```text
Settings -> Defaults
```

and configures:

```text
Profile
kraken/v1

Kraken strict gate
ON

Native criteria pack
ON

Kraken - Model Routing

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

Hovering over `Explore ?` they see:

```text
Repository exploration and codebase analysis.
A fast model is usually enough.
```

Hovering over `Verify ?` they see:

```text
Checks implementation, tests and regressions.
Different from the Advisory verifier.
```

When they start a task, the Desktop builds the headless process with:

```text
ZELARI_KRAKEN_EXPLORE_MODEL=fast-model
ZELARI_KRAKEN_GENERAL_MODEL=strong-coding-model
ZELARI_KRAKEN_VERIFY_MODEL=review-model
ZELARI_KRAKEN_PLANNER_MODEL=fast-model
```

without any change to Kraken's internal behavior beyond the already supported model routing.

---

# 34. Final architecture

```text
+-------------------------------------------+
| Zelari Desktop                          |
|                                         |
| Settings -> Defaults                     |
| Kraken - Model Routing                  |
|                                         |
| Explore ----------> fast-model        |
| General ----------> coding-model      |
| Verify  ----------> review-model      |
| Planner ----------> planner-model     |
+-------------------------------------------+
                      |
                      v
             DesktopPrefs / localStorage
                      |
                      v
                   App.tsx
                      |
                      v
                 RunTaskArgs
                      |
                      v
              Tauri run_task
                      |
                      v
               spawn_headless
                      |
                      v
     +------------------------------+
     | Environment                    |
     |                                |
     | KRAKEN_EXPLORE_MODEL           |
     | KRAKEN_GENERAL_MODEL           |
     | KRAKEN_VERIFY_MODEL            |
     | KRAKEN_PLANNER_MODEL           |
     +------------------------------+
                     |
                     v
              zelari-code --headless
                     |
                     v
                   Kraken
           +---------+---------+
           v         v         v
        Explore    General   Verify
                     |
                     v
               Graph Planner
```

---

# 35. Summary

The proposed feature is mainly a **Desktop UI and Tauri bridge extension**.

The Kraken core already has the necessary model overrides.

The patch must therefore:

1. add four persistent preferences;
2. expose them in the `Settings -> Defaults` UI;
3. add clear hover/focus tooltips for every function;
4. forward the values to `RunTaskArgs`;
5. convert them into Kraken envs in the headless process;
6. keep `Inherit` as a real absence of override;
7. keep Verify tentacle and Advisory verifier separate;
8. add persistence, UI and bridge tests.

The final result makes an already-existing Kraken capability configurable from the Desktop, without altering its internal architecture.
