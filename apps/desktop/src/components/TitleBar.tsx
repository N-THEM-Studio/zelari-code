/**
 * Custom window chrome (frameless Tauri): brand left, drag region, window controls.
 */
import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import zelariLogo from "../assets/zelari-logo.png";

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* browser / non-tauri */
      });
    return () => {
      unlisten?.();
    };
  }, []);

  const minimize = useCallback(() => {
    void getCurrentWindow().minimize().catch(() => undefined);
  }, []);

  const toggleMax = useCallback(() => {
    void getCurrentWindow()
      .toggleMaximize()
      .then(() => getCurrentWindow().isMaximized())
      .then(setMaximized)
      .catch(() => undefined);
  }, []);

  const close = useCallback(() => {
    void getCurrentWindow().close().catch(() => undefined);
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <div className="brand-mark titlebar-logo" aria-hidden>
          <img src={zelariLogo} alt="" className="brand-logo" />
        </div>
        <span className="titlebar-app-name">Zelari Desktop</span>
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          title="Minimize"
          aria-label="Minimize"
          onClick={minimize}
        >
          <span aria-hidden>─</span>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={toggleMax}
        >
          <span aria-hidden>{maximized ? "❐" : "□"}</span>
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-btn-close"
          title="Close"
          aria-label="Close"
          onClick={close}
        >
          <span aria-hidden>×</span>
        </button>
      </div>
    </header>
  );
}
