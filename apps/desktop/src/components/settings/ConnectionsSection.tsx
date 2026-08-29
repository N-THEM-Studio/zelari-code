/**
 * Connections — SSH targets and the Android companion server (QR pairing).
 * Thin re-skin wrapper: child components keep their own logic.
 */
import { CompanionServeSection } from "../CompanionServeSection";
import { SshSection } from "../SshSection";
import { useSettingsToast } from "./primitives";

export interface ConnectionsSectionProps {
  workdir: string | null;
}

export function ConnectionsSection({ workdir }: ConnectionsSectionProps) {
  const toast = useSettingsToast();
  return (
    <>
      <div className="settings-section-head">
        <h2>Connections</h2>
        <p>Pair the Android companion app and configure SSH targets for remote runs.</p>
      </div>
      <div className="settings-stack">
        <CompanionServeSection
          workdir={workdir}
          onStatus={(msg) => toast.push("ok", msg)}
        />
        <SshSection onStatus={(msg) => toast.push("ok", msg)} />
      </div>
    </>
  );
}
