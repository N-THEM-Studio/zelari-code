/**
 * t66: desktop folder-trust gate — vanilla overlay (no React mount point
 * needed; it appends its own DOM). Two triggers, one modal:
 *
 *  1. Companion run on an untrusted cwd: installTrustGate() polls the Rust
 *     command companion_trust_pending (which GETs /v1/trust/pending on the
 *     loopback companion serve with the bearer token); a pending run shows
 *     the modal and the answer rides companion_trust_respond → POST /v1/trust.
 *  2. Desktop "Open Folder": requestDesktopTrust(path) — trusted set in
 *     localStorage; the first open of a new folder shows the same modal.
 */
import { invoke } from "@tauri-apps/api/core";

type Pending = { runId: string; path: string } | null;

const TRUSTED_KEY = "zelari-desktop-trusted-folders";
let installed = false;
let modalOpen = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function trustedFolders(): string[] {
  try {
    const raw = localStorage.getItem(TRUSTED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function persistTrusted(paths: string[]): void {
  try {
    localStorage.setItem(TRUSTED_KEY, JSON.stringify(paths.slice(-200)));
  } catch {
    /* ignore */
  }
}

type ModalOptions = {
  path: string;
  source: "companion" | "desktop";
  onDecision: (approved: boolean) => void;
};

function ensureModalHost(): HTMLDivElement {
  let host = document.getElementById("zelari-trust-gate");
  if (!host) {
    host = document.createElement("div");
    host.id = "zelari-trust-gate";
    document.body.appendChild(host);
  }
  return host as HTMLDivElement;
}

function showModal(opts: ModalOptions): void {
  if (modalOpen) return;
  modalOpen = true;
  const host = ensureModalHost();
  host.innerHTML = "";

  const backdrop = document.createElement("div");
  backdrop.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483000;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif";

  const card = document.createElement("div");
  card.style.cssText =
    "background:#16161c;color:#eaeaf0;border:1px solid #2c2c36;border-radius:12px;padding:24px;max-width:460px;width:90%;box-shadow:0 18px 60px rgba(0,0,0,.5)";

  const title = document.createElement("h3");
  title.textContent = "Cartella non attendibile";
  title.style.cssText = "margin:0 0 8px;font-size:16px";
  const source = document.createElement("p");
  source.textContent =
    opts.source === "companion"
      ? "Il telefono (companion) vuole avviare una run in questa cartella:"
      : "Stai aprendo una nuova cartella di lavoro:";
  source.style.cssText = "margin:0 0 8px;font-size:13px;color:#a0a0b0";
  const pathEl = document.createElement("code");
  pathEl.textContent = opts.path;
  pathEl.style.cssText =
    "display:block;padding:10px;background:#0e0e12;border:1px solid #2c2c36;border-radius:8px;font-size:12px;word-break:break-all;margin:0 0 8px";
  const warn = document.createElement("p");
  warn.textContent =
    "Le cartelle attendibili possono eseguire codice e modificare file. Fidati solo di cartelle che controlli.";
  warn.style.cssText = "margin:0 0 16px;font-size:12px;color:#c9a86a";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:10px;justify-content:flex-end";

  const mkBtn = (label: string, primary: boolean, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = primary
      ? "background:#7c5cff;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer"
      : "background:transparent;color:#eaeaf0;border:1px solid #3a3a46;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer";
    b.onclick = () => {
      modalOpen = false;
      host.innerHTML = "";
      fn();
    };
    return b;
  };

  row.appendChild(mkBtn("Annulla", false, () => opts.onDecision(false)));
  row.appendChild(mkBtn("Mi fido, apri", true, () => opts.onDecision(true)));
  card.appendChild(title);
  card.appendChild(source);
  card.appendChild(pathEl);
  card.appendChild(warn);
  card.appendChild(row);
  backdrop.appendChild(card);
  host.appendChild(backdrop);
}

/** Desktop "Open Folder" gate — resolves true when the folder is trusted. */
export async function requestDesktopTrust(path: string): Promise<boolean> {
  if (trustedFolders().includes(path)) return true;
  return new Promise<boolean>((resolve) => {
    showModal({
      path,
      source: "desktop",
      onDecision: (approved) => {
        if (approved) {
          const set = trustedFolders();
          if (!set.includes(path)) set.push(path);
          persistTrusted(set);
        }
        resolve(approved);
      },
    });
  });
}

/** Companion gate: poll the serve for a parked awaiting_trust run. */
export function installTrustGate(): void {
  if (installed) return;
  installed = true;
  void (async () => {
    try {
      await invoke("companion_trust_respond", { runId: "", approve: false });
    } catch {
      /* command presence probe — ignore */
    }
  })();
  pollTimer = setInterval(() => {
    void (async () => {
      if (modalOpen) return;
      try {
        const raw = await invoke<string>("companion_trust_pending");
        if (!raw) return;
        const data = JSON.parse(raw) as { ok?: boolean; pending?: Pending };
        const pending = data.pending;
        if (!pending) return;
        showModal({
          path: pending.path,
          source: "companion",
          onDecision: (approved) => {
            void invoke("companion_trust_respond", {
              runId: pending.runId,
              approve: approved,
            }).catch(() => undefined);
          },
        });
      } catch {
        /* serve down or command missing — ignore */
      }
    })();
  }, 3000);
}

export function uninstallTrustGate(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  installed = false;
  modalOpen = false;
  ensureModalHost().innerHTML = "";
}
