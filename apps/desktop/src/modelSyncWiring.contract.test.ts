// @vitest-environment node
/**
 * Model-sync wiring contract (SLICE4) — RED-IF-REOPENS.
 *
 * App.tsx cannot be rendered in a unit test (importing it pulls the whole Tauri
 * surface: dialogs, updater, agent events), so the App half of this change is
 * pinned at the source level — the same idiom as
 * chatReadabilityWiring.contract.test.ts and grokRoundWiring.contract.test.ts.
 *
 * What must stay true:
 *   - `refreshConfig` is no longer sticky: the CLI config wins over the chat bar
 *     UNTIL the user picks something in this session (`userPickedModelRef`), and
 *     the old `prev || c.modelByProvider[...]` fill — which kept the very first
 *     value forever — is gone;
 *   - every chat-side model change (model pick, provider pick, conversation
 *     bind) is pushed to provider.json through `setAppConfig`, i.e. the SAME
 *     `set_app_config` sidecar command the Settings panels already use — no new
 *     IPC channel;
 *   - Settings → Agents receives the live chat model, so its Lead row can never
 *     disagree with the chat bar.
 *
 * This fails on the exact regressions it describes, not on formatting.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const app = read("./App.tsx");
const shell = read("./components/settings/SettingsShell.tsx");
const agents = read("./components/settings/AgentsSection.tsx");
const providers = read("./components/settings/ProviderSection.tsx");

function region(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `missing anchor: ${from}`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end, `missing end anchor: ${to}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const refreshConfig = region(app, "const refreshConfig", "void refreshCli();");
const persistChatModel = region(app, "const persistChatModel", "const onProviderChange");
const onProviderChange = region(app, "const onProviderChange", "const onModelChange");
const onModelChange = region(app, "const onModelChange", "const onThinkingChange");
const onSelectSession = region(
  app,
  "const onSelectSession",
  "/** User-facing recovery prompt",
);

describe("model-sync: refreshConfig stops being sticky", () => {
  it("lets the CLI config win until the user picks a model", () => {
    expect(refreshConfig).toContain("const picked = userPickedModelRef.current");
    expect(refreshConfig).toContain("picked ? prev || cfgModel : cfgModel || prev");
  });

  it("drops the old first-value-wins fill", () => {
    expect(refreshConfig).not.toContain("prev ||\n          c.modelByProvider");
    expect(refreshConfig).not.toContain("setProvider((prev) => prev || c.activeProviderId)");
  });
});

describe("model-sync: chat → CLI config uses the existing channel", () => {
  it("writes through setAppConfig (set_app_config), not a new IPC", () => {
    expect(persistChatModel).toContain("await setAppConfig({");
    expect(persistChatModel).toContain("provider: nextProvider");
    // The same call the Settings panels make; one channel, one file.
    expect(providers).toContain("await setAppConfig({ provider: id, model })");
    expect(app).not.toContain('invoke("set_app_config"');
  });

  it("persists an explicit model pick", () => {
    expect(onModelChange).toContain("userPickedModelRef.current = true");
    expect(onModelChange).toContain("await persistChatModel(provider, id)");
  });

  it("persists a provider pick together with its model", () => {
    expect(onProviderChange).toContain("await persistChatModel(id, nextModel, \"provider\")");
  });

  it("persists the model of the conversation the user just opened", () => {
    expect(onSelectSession).toContain("void persistChatModel(nextProvider, nextModel)");
  });
});

describe("model-sync: Settings → Agents sees the live chat model", () => {
  it("passes it down from App", () => {
    expect(app).toContain("activeChatModel={model}");
  });

  it("forwards it through the settings shell into the Agents card", () => {
    expect(shell).toContain("activeChatModel?: string;");
    expect(shell).toContain("activeChatModel={activeChatModel}");
  });

  it("uses it for the Lead row and points to the composer for tentacle models", () => {
    expect(agents).toContain("const leadModel = leadChatModel || leadConfigModel");
    // The drift is closable from the card, through the same config write.
    expect(agents).toContain(
      "await setAppConfig({ provider: activeProvider, model: leadChatModel })",
    );
    expect(agents).toContain("Make {leadChatModel} the default");
    expect(agents).toContain("These never change the model of the main chat");
    expect(agents).toContain("Tentacles pill");
  });
});
