/**
 * Composer pills (grok-round): the three controls that used to sit in the
 * topbar are now quiet pills at the bottom-left INSIDE the composer capsule —
 * model, tool permissions, run mode. The topbar keeps only title / folder /
 * todos, which is what makes it read as "lighter".
 *
 * Nothing here owns behaviour: each popover re-mounts the SAME control the
 * topbar (or Settings) already used, with the same props and handlers.
 *
 *   - `ProviderModelBar` is untouched, so model discovery, its per-provider
 *     cooldown, the focus refresh and the `onStatus` reporting all survive
 *     verbatim — it is only *hosted* in a popover now;
 *   - the permission pill edits the very same pref Settings → Tool permissions
 *     edits (`prefs.permissionPreset`, same `PERMISSION_PRESETS`, same
 *     `patchDesktopPrefs` → localStorage path): one store, two UIs, never two
 *     sources of truth;
 *   - Mode / Phase / Graph / Gauntlet keep their own components and their own
 *     disable rules (`ModeToggle` is also disabled while Graph is on).
 *
 * Popovers are LOCAL state only: a `<button>` + an absolutely positioned
 * `<div>`, dismissed on Escape and on a pointer-down outside. The button and
 * its panel share one wrapper, so the wrapper — not the panel — is the
 * outside-click boundary; re-clicking the pill therefore toggles it closed
 * instead of closing-then-reopening. No portal, no dependency, no global state.
 *
 * The pills mirror the composer they live in: never disabled for typing,
 * `disabled={running}` for a live run — exactly the contract the topbar model
 * bar had, so steer/queue is unaffected.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PERMISSION_PRESETS, type PermissionPreset } from "../desktopPrefs";
import type { DesktopConfig, DispatchMode, WorkPhase } from "../types";
import { GauntletToggle } from "./GauntletToggle";
import { KrakenGraphToggle } from "./KrakenGraphToggle";
import { ModeToggle } from "./ModeToggle";
import { PhaseToggle } from "./PhaseToggle";
import { ProviderModelBar } from "./ProviderModelBar";

export interface ComposerToolbarProps {
  config: DesktopConfig | null;
  provider: string;
  model: string;
  /** Run in flight: a model/permission/mode change mid-run would be dropped. */
  disabled?: boolean;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
  onThinkingChange: (spec: string) => void;
  onConfigRefresh?: (cfg: DesktopConfig) => void;
  onStatus?: (msg: string) => void;
  /** The same pref Settings → Tool permissions writes. */
  permissionPreset: PermissionPreset;
  onPermissionPresetChange: (preset: PermissionPreset) => void;
  mode: DispatchMode;
  onModeChange: (mode: DispatchMode) => void;
  phase: WorkPhase;
  onPhaseChange: (phase: WorkPhase) => void;
  krakenGraph: boolean;
  onKrakenGraphChange: (value: boolean) => void;
  gauntlet: boolean;
  onGauntletChange: (value: boolean) => void;
}

type PillId = "model" | "permissions" | "mode";

/**
 * One pill + its panel. The wrapper is the dismissal boundary, and it also
 * owns the `aria-expanded` contract, so App only sees plain handlers.
 */
function Pill({
  id,
  label,
  text,
  title,
  disabled,
  openId,
  onToggle,
  onClose,
  children,
}: {
  id: PillId;
  label: string;
  text: string;
  title: string;
  disabled?: boolean;
  openId: PillId | null;
  onToggle: (id: PillId) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const open = openId === id;

  // Dismissal is the only effect. `capture` so the Escape never also reaches a
  // global Esc handler in App (the popover owns the key while it is open).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);

  return (
    <div className="composer-pill-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`composer-pill${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onClick={() => onToggle(id)}
      >
        {text}
      </button>
      {open ? (
        <div className="composer-popover" role="dialog" aria-label={label}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function ComposerToolbar({
  config,
  provider,
  model,
  disabled,
  onProviderChange,
  onModelChange,
  onThinkingChange,
  onConfigRefresh,
  onStatus,
  permissionPreset,
  onPermissionPresetChange,
  mode,
  onModeChange,
  phase,
  onPhaseChange,
  krakenGraph,
  onKrakenGraphChange,
  gauntlet,
  onGauntletChange,
}: ComposerToolbarProps) {
  const [openId, setOpenId] = useState<PillId | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const toggle = useCallback(
    (id: PillId) => setOpenId((cur) => (cur === id ? null : id)),
    [],
  );

  /** Model pill reads as the current model; the provider is the fallback. */
  const modelText = model || provider || "Model";
  /** Mode pill carries the exception flags too, so they are never invisible. */
  const modeText = [
    mode,
    phase,
    krakenGraph ? "Graph" : null,
    gauntlet ? "Gauntlet" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="composer-pills">
      <Pill
        id="model"
        label="Provider and model"
        text={modelText}
        title="Provider, model and thinking effort (discovery included)"
        disabled={disabled}
        openId={openId}
        onToggle={toggle}
        onClose={close}
      >
        <div className="composer-popover-title">Model</div>
        <ProviderModelBar
          config={config}
          provider={provider}
          model={model}
          disabled={disabled}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
          onThinkingChange={onThinkingChange}
          onConfigRefresh={onConfigRefresh}
          onStatus={onStatus}
        />
      </Pill>

      <Pill
        id="permissions"
        label="Tool permissions"
        text={permissionPreset}
        title="Tool permission preset — the same pref as Settings → Tool permissions"
        disabled={disabled}
        openId={openId}
        onToggle={toggle}
        onClose={close}
      >
        <div className="composer-popover-title">Tool permissions</div>
        <select
          className="composer-popover-select"
          value={permissionPreset}
          disabled={disabled}
          aria-label="Permission preset"
          title="Applies to every run from this window (per-turn, sidecar-wide)"
          onChange={(e) =>
            onPermissionPresetChange(e.target.value as PermissionPreset)
          }
        >
          {PERMISSION_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
        <p className="composer-popover-help">
          How the sidecar treats commands and network. Unknown presets fall back
          to standard — the sidecar stays fail-closed.
        </p>
      </Pill>

      <Pill
        id="mode"
        label="Run mode"
        text={modeText}
        title="Mode, phase, Kraken Graph and Gauntlet"
        disabled={disabled}
        openId={openId}
        onToggle={toggle}
        onClose={close}
      >
        <div className="composer-popover-row">
          <span className="composer-popover-title">Mode</span>
          {/* Graph and mode are mutually exclusive — same rule as the topbar. */}
          <ModeToggle
            value={mode}
            disabled={disabled || krakenGraph}
            onChange={onModeChange}
          />
        </div>
        <div className="composer-popover-row">
          <span className="composer-popover-title">Phase</span>
          <PhaseToggle
            value={phase}
            disabled={disabled}
            onChange={onPhaseChange}
          />
        </div>
        <div className="composer-popover-row">
          <span className="composer-popover-title">Extras</span>
          <KrakenGraphToggle
            value={krakenGraph}
            disabled={disabled}
            onChange={onKrakenGraphChange}
          />
          <GauntletToggle
            value={gauntlet}
            disabled={disabled}
            onChange={onGauntletChange}
          />
        </div>
      </Pill>
    </div>
  );
}
