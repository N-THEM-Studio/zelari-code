/**
 * Right-rail project panel: Files tree + Git changes (tabbed).
 */
import { useCallback, useEffect, useState } from "react";
import { getGitStatus, listDir } from "../agentClient";
import type { DirEntry, GitStatusSnapshot } from "../types";

type ProjectTab = "files" | "git";

interface Props {
  cwd: string | null;
  refreshKey?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  onStatus?: (msg: string) => void;
}

const LS_TAB = "zelari-desktop-project-tab";

function loadTab(): ProjectTab {
  try {
    const t = localStorage.getItem(LS_TAB);
    return t === "git" ? "git" : "files";
  } catch {
    return "files";
  }
}

async function revealInExplorer(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

function IconReveal() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 4.5h11v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-8z" strokeLinejoin="round" />
      <path d="M5 4.5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" strokeLinecap="round" />
    </svg>
  );
}

export function ProjectPanel({
  cwd,
  refreshKey = 0,
  collapsed,
  onToggle,
  onStatus,
}: Props) {
  const [tab, setTab] = useState<ProjectTab>(() => loadTab());
  const [snap, setSnap] = useState<GitStatusSnapshot | null>(null);

  const [rootEntries, setRootEntries] = useState<DirEntry[]>([]);
  const [rootError, setRootError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(
    () => new Map(),
  );
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(
    () => new Set(),
  );

  const setActiveTab = (t: ProjectTab) => {
    setTab(t);
    try {
      localStorage.setItem(LS_TAB, t);
    } catch {
      /* ignore */
    }
  };

  const onReveal = useCallback(
    async (path: string) => {
      try {
        await revealInExplorer(path);
        onStatus?.(`Opened in explorer: ${path}`);
      } catch (e) {
        onStatus?.(e instanceof Error ? e.message : String(e));
      }
    },
    [onStatus],
  );

  const refreshGit = useCallback(async () => {
    try {
      const s = await getGitStatus({ cwd });
      setSnap(s);
    } catch {
      setSnap({
        isRepo: false,
        branch: null,
        files: [],
        cwd: cwd ?? "",
        error: "git unavailable",
      });
    }
  }, [cwd]);

  const loadRoot = useCallback(async () => {
    if (!cwd) {
      setRootEntries([]);
      setRootError(null);
      setExpanded(new Set());
      setChildren(new Map());
      return;
    }
    setLoadingPaths((prev) => new Set(prev).add(cwd));
    try {
      const res = await listDir({ cwd, path: cwd });
      if (res.error) {
        setRootError(res.error);
        setRootEntries([]);
      } else {
        setRootError(null);
        setRootEntries(res.entries ?? []);
      }
    } catch (e) {
      setRootError(e instanceof Error ? e.message : String(e));
      setRootEntries([]);
    } finally {
      setLoadingPaths((prev) => {
        const n = new Set(prev);
        n.delete(cwd);
        return n;
      });
    }
  }, [cwd]);

  useEffect(() => {
    void refreshGit();
    const id = window.setInterval(() => void refreshGit(), 5000);
    return () => window.clearInterval(id);
  }, [refreshGit, refreshKey]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot, refreshKey]);

  const toggleDir = async (entry: DirEntry) => {
    if (!entry.isDir || !cwd) return;
    const path = entry.path;
    if (expanded.has(path)) {
      setExpanded((prev) => {
        const n = new Set(prev);
        n.delete(path);
        return n;
      });
      return;
    }
    setExpanded((prev) => new Set(prev).add(path));
    if (children.has(path)) return;

    setLoadingPaths((prev) => new Set(prev).add(path));
    try {
      const res = await listDir({ cwd, path });
      setChildren((prev) => {
        const n = new Map(prev);
        n.set(path, res.entries ?? []);
        return n;
      });
      if (res.error) onStatus?.(res.error);
    } catch (e) {
      onStatus?.(e instanceof Error ? e.message : String(e));
      setChildren((prev) => {
        const n = new Map(prev);
        n.set(path, []);
        return n;
      });
    } finally {
      setLoadingPaths((prev) => {
        const n = new Set(prev);
        n.delete(path);
        return n;
      });
    }
  };

  const onRefresh = () => {
    if (tab === "git") void refreshGit();
    else {
      setChildren(new Map());
      setExpanded(new Set());
      void loadRoot();
    }
  };

  if (collapsed) {
    return (
      <aside className="git-panel project-panel collapsed">
        <button
          type="button"
          className="git-panel-toggle"
          onClick={onToggle}
          title="Show project panel"
        >
          project
        </button>
      </aside>
    );
  }

  return (
    <aside className="git-panel project-panel">
      <div className="git-panel-head project-panel-head">
        <div className="project-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={`project-tab${tab === "files" ? " active" : ""}`}
            onClick={() => setActiveTab("files")}
          >
            Files
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "git"}
            className={`project-tab${tab === "git" ? " active" : ""}`}
            onClick={() => setActiveTab("git")}
          >
            Git
          </button>
        </div>
        {tab === "git" && snap?.isRepo && snap.branch ? (
          <span className="git-branch" title={snap.branch}>
            {snap.branch}
          </span>
        ) : null}
        {cwd ? (
          <button
            type="button"
            className="btn-ghost git-reveal-root"
            title="Show folder in Explorer"
            onClick={() => void onReveal(cwd)}
          >
            <IconReveal />
          </button>
        ) : null}
        <button
          type="button"
          className="btn-ghost git-refresh"
          title="Refresh"
          onClick={onRefresh}
        >
          ↻
        </button>
        {onToggle ? (
          <button
            type="button"
            className="btn-ghost git-collapse"
            title="Hide panel"
            onClick={onToggle}
          >
            ›
          </button>
        ) : null}
      </div>

      <div className="git-panel-body">
        {tab === "files" ? (
          <FilesTree
            cwd={cwd}
            entries={rootEntries}
            error={rootError}
            expanded={expanded}
            childrenMap={children}
            loadingPaths={loadingPaths}
            onToggleDir={(e) => void toggleDir(e)}
            onFileClick={(path) => onStatus?.(path)}
            onReveal={(path) => void onReveal(path)}
          />
        ) : (
          <GitBody
            snap={snap}
            cwd={cwd}
            onReveal={(path) => void onReveal(path)}
          />
        )}
      </div>
    </aside>
  );
}

function IconFolder({ open }: { open?: boolean }) {
  if (open) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden>
        <path d="M1.5 4.5h4l1.2 1.5H14.5v7a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1z" />
        <path d="M1.5 7.5h13" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M1.5 3.5h4.2l1.3 1.5h7.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1z" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M4 1.5h5.5L13.5 5.5V14a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z" />
      <path d="M9.5 1.5V5.5H13.5" />
    </svg>
  );
}

function joinPath(root: string, rel: string): string {
  const r = root.replace(/[/\\]+$/, "");
  const p = rel.replace(/^[/\\]+/, "");
  const sep = r.includes("\\") ? "\\" : "/";
  return `${r}${sep}${p.replace(/\//g, sep)}`;
}

function GitBody({
  snap,
  cwd,
  onReveal,
}: {
  snap: GitStatusSnapshot | null;
  cwd: string | null;
  onReveal: (path: string) => void;
}) {
  if (!snap) {
    return <div className="git-muted pad">Loading…</div>;
  }
  if (!snap.isRepo) {
    return (
      <div className="git-muted pad">
        {snap.error ?? "Not a git repository"}
      </div>
    );
  }
  if (snap.files.length === 0) {
    return <div className="git-muted pad">Working tree clean</div>;
  }
  return (
    <ul className="git-file-list">
      {snap.files.map((f) => {
        const abs = cwd ? joinPath(cwd, f.path) : f.path;
        return (
          <li key={f.path} className={f.untracked ? "untracked" : ""}>
            <span className="git-file-icon" aria-hidden>
              <IconFile />
            </span>
            <span className="git-file-path" title={f.path}>
              {f.path.replace(/\\/g, "/")}
            </span>
            {f.untracked ? (
              <span className="git-badge untracked">U</span>
            ) : (
              <span className="git-counts">
                {f.added != null ? (
                  <span className="add">+{f.added}</span>
                ) : null}
                {f.removed != null ? (
                  <span className="del">−{f.removed}</span>
                ) : null}
              </span>
            )}
            <button
              type="button"
              className="btn-reveal"
              title="Show in Explorer"
              onClick={(e) => {
                e.stopPropagation();
                onReveal(abs);
              }}
            >
              <IconReveal />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FilesTree({
  cwd,
  entries,
  error,
  expanded,
  childrenMap,
  loadingPaths,
  onToggleDir,
  onFileClick,
  onReveal,
}: {
  cwd: string | null;
  entries: DirEntry[];
  error: string | null;
  expanded: Set<string>;
  childrenMap: Map<string, DirEntry[]>;
  loadingPaths: Set<string>;
  onToggleDir: (e: DirEntry) => void;
  onFileClick: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  if (!cwd) {
    return (
      <div className="git-muted pad">
        Open a folder to browse project files
      </div>
    );
  }
  if (error) {
    return <div className="git-muted pad">{error}</div>;
  }
  if (loadingPaths.has(cwd) && entries.length === 0) {
    return <div className="git-muted pad">Loading…</div>;
  }
  if (entries.length === 0) {
    return <div className="git-muted pad">Empty folder</div>;
  }

  return (
    <ul className="file-tree">
      {entries.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          depth={0}
          expanded={expanded}
          childrenMap={childrenMap}
          loadingPaths={loadingPaths}
          onToggleDir={onToggleDir}
          onFileClick={onFileClick}
          onReveal={onReveal}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  depth,
  expanded,
  childrenMap,
  loadingPaths,
  onToggleDir,
  onFileClick,
  onReveal,
}: {
  entry: DirEntry;
  depth: number;
  expanded: Set<string>;
  childrenMap: Map<string, DirEntry[]>;
  loadingPaths: Set<string>;
  onToggleDir: (e: DirEntry) => void;
  onFileClick: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  const isOpen = expanded.has(entry.path);
  const kids = childrenMap.get(entry.path);
  const loading = loadingPaths.has(entry.path);

  return (
    <li className={`file-tree-node${entry.isDir ? " is-dir" : " is-file"}`}>
      <div
        className="file-tree-row"
        style={{ paddingLeft: 6 + depth * 12 }}
        title={entry.path}
      >
        <button
          type="button"
          className="file-tree-main"
          onClick={() => {
            if (entry.isDir) onToggleDir(entry);
            else onFileClick(entry.path);
          }}
        >
          <span className="file-tree-chevron" aria-hidden>
            {entry.isDir ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span className="file-tree-icon" aria-hidden>
            {entry.isDir ? <IconFolder open={isOpen} /> : <IconFile />}
          </span>
          <span className="file-tree-name">{entry.name}</span>
          {loading ? <span className="file-tree-loading">…</span> : null}
        </button>
        <span className="file-tree-row-actions">
          <button
            type="button"
            className="btn-reveal"
            title="Show in Explorer"
            onClick={(e) => {
              e.stopPropagation();
              onReveal(entry.path);
            }}
          >
            <IconReveal />
          </button>
        </span>
      </div>
      {entry.isDir && isOpen && kids && kids.length > 0 ? (
        <ul className="file-tree">
          {kids.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              expanded={expanded}
              childrenMap={childrenMap}
              loadingPaths={loadingPaths}
              onToggleDir={onToggleDir}
              onFileClick={onFileClick}
              onReveal={onReveal}
            />
          ))}
        </ul>
      ) : null}
      {entry.isDir && isOpen && kids && kids.length === 0 && !loading ? (
        <div
          className="git-muted file-tree-empty"
          style={{ paddingLeft: 20 + depth * 12 }}
        >
          empty
        </div>
      ) : null}
    </li>
  );
}
