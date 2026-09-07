/**
 * Extract local image paths from a CLI tool-result string so the chat can
 * render pixels the agent produced (screenshot tool, browser_check).
 *
 * The harness JSON-stringifies tool values, so a screenshot result reaches
 * the Desktop as text like:
 *   {\n  "ok": true,\n  "path": "Z:\\proj\\.zelari\\screenshots\\screenshot-….png", …}
 *   …"screenshotPath": "/tmp/zelari-browser-….png"…
 * We parse the JSON when possible (preferred keys), fall back to a raw path
 * regex, and cap the count so a chatty tool result can't flood the chat.
 */

const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** JSON stringified paths double the backslashes; raw results don't. */
const RAW_PATH_RE = /(?:[A-Za-z]:[\\/]{1,2}|\\\\|\/)[^\s"'`*?<>|]{1,400}?\.(?:png|jpe?g|webp|gif|bmp)/gi;
const MAX_IMAGES_PER_RESULT = 4;

function isImageLikePath(v: unknown): v is string {
  return typeof v === "string" && v.length > 4 && IMG_EXT_RE.test(v);
}

function walkForImagePaths(node: unknown, out: string[], depth = 0): void {
  if (out.length >= MAX_IMAGES_PER_RESULT || depth > 4 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForImagePaths(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const rec = node as Record<string, unknown>;
    // Preferred keys first (screenshot tool / browser_check shapes).
    for (const key of ["screenshotPath", "screenshot", "path"]) {
      if (isImageLikePath(rec[key])) {
        out.push(rec[key] as string);
        if (out.length >= MAX_IMAGES_PER_RESULT) return;
      }
    }
    for (const value of Object.values(rec)) {
      if (out.length >= MAX_IMAGES_PER_RESULT) return;
      if (typeof value === "object") walkForImagePaths(value, out, depth + 1);
    }
  }
}

export function extractImagePathsFromToolResult(resultText: string | undefined | null): string[] {
  const text = (resultText ?? "").trim();
  if (!text) return [];
  const out: string[] = [];
  const push = (p: string): void => {
    const normalized = p.replace(/\\\\/g, "\\");
    if (!out.includes(normalized)) out.push(normalized);
  };

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      walkForImagePaths(JSON.parse(text.slice(start, end + 1)), out);
    } catch {
      /* fall through to regex */
    }
  }
  if (out.length === 0) {
    for (const m of text.matchAll(RAW_PATH_RE)) {
      push(m[0]);
      if (out.length >= MAX_IMAGES_PER_RESULT) break;
    }
  } else {
    out.forEach((_, i) => {
      out[i] = out[i].replace(/\\\\/g, "\\");
    });
  }
  return out.slice(0, MAX_IMAGES_PER_RESULT);
}
