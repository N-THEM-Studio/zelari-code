/**
 * RunsTrigger (F4 polish): the trigger of the global runs dashboard.
 *
 * Moved out of the sidebar rail into the right side of the chat tab bar —
 * next to the folder picker — so the button and the right-hand drawer it opens
 * sit in the same corner of the window. Same 4-square grid glyph and same
 * running-count badge the sidebar button had; nothing else changed.
 *
 * Presentational on purpose: App owns both the drawer flag and the run registry
 * (`useRunCoordinator` is hook-local there), so the count arrives as a prop —
 * no `../runs` import, no Tauri, no local state.
 */
export interface RunsTriggerProps {
  /** `activeRunCount(state)`: runs in flight across ALL conversations. 0 = no badge. */
  activeCount: number;
  /** App opens the drawer (it owns `dashboardOpen`). */
  onOpen: () => void;
}

export function RunsTrigger({ activeCount, onOpen }: RunsTriggerProps) {
  return (
    <button
      type="button"
      className="btn-ghost topbar-runs"
      onClick={onOpen}
      title="Runs dashboard — tutte le run, tutte le chat"
      aria-label="Apri la dashboard delle run"
    >
      <svg
        className="topbar-runs-icon"
        viewBox="0 0 16 16"
        width="13"
        height="13"
        fill="currentColor"
        aria-hidden
        focusable="false"
      >
        <rect x="1.5" y="2.5" width="5" height="4" rx="1" />
        <rect x="9.5" y="2.5" width="5" height="4" rx="1" />
        <rect x="1.5" y="9.5" width="5" height="4" rx="1" />
        <rect x="9.5" y="9.5" width="5" height="4" rx="1" />
      </svg>
      <span className="topbar-runs-label">Runs</span>
      {activeCount > 0 ? (
        <span className="topbar-runs-badge" title={`${activeCount} run in corso`}>
          {activeCount}
        </span>
      ) : null}
    </button>
  );
}
