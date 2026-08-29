/**
 * Extensions — MCP servers and Skills. The heavy lifting stays in the
 * existing McpSection/SkillsSection components (logic unchanged);
 * this wrapper only re-skins them and routes status to toasts.
 */
import { McpSection } from "../McpSection";
import { SkillsSection } from "../SkillsSection";
import { useSettingsToast } from "./primitives";

export interface ExtensionsSectionProps {
  workdir: string | null;
  /** Active provider/model — used by skill generation from URL. */
  provider: string | null;
  model: string | null;
}

export function ExtensionsSection({ workdir, provider, model }: ExtensionsSectionProps) {
  const toast = useSettingsToast();
  return (
    <>
      <div className="settings-section-head">
        <h2>Extensions</h2>
        <p>MCP servers and skills extend what the agent can do. Shared with the CLI.</p>
      </div>
      <div className="settings-stack">
        <McpSection
          workdir={workdir}
          onStatus={(msg) => toast.push("ok", msg)}
        />
        <SkillsSection
          workdir={workdir}
          provider={provider}
          model={model}
          onStatus={(msg) => toast.push("ok", msg)}
        />
      </div>
    </>
  );
}
