/**
 * Inline image card for the chat stream: renders pixels the agent produced
 * (screenshot tool, browser_check captures) from their local path via the
 * Tauri asset protocol. Outside the Tauri shell (plain browser dev) the
 * image cannot load — the card degrades to the path text.
 */
import { useEffect, useState } from "react";

interface Props {
  paths: string[];
  /** Optional heading above the image(s), e.g. the tool name. */
  caption?: string;
}

function fileName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

async function resolveAssetSrc(path: string): Promise<string> {
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

function ChatImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void resolveAssetSrc(path).then((s) => {
      if (!cancelled) setSrc(s);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) {
    return <div className="chat-image-fallback" title={path}>{fileName(path)}</div>;
  }
  return (
    <img
      className={`chat-image${zoomed ? " zoomed" : ""}`}
      src={src ?? undefined}
      alt={fileName(path)}
      title={path}
      loading="lazy"
      onError={() => setFailed(true)}
      onClick={() => setZoomed((z) => !z)}
    />
  );
}

export function ChatImageCard({ paths, caption }: Props) {
  if (!paths.length) return null;
  return (
    <div className="chat-image-card message assistant" aria-label="Agent screenshot">
      {caption ? <div className="chat-image-caption">{caption}</div> : null}
      {paths.map((p) => (
        <ChatImage key={p} path={p} />
      ))}
    </div>
  );
}
