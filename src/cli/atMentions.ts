/**
 * Expand @path tags in a user prompt into attached file/dir context.
 *
 * Tokens look like `@src/cli/main.ts` or `@apps/desktop` (relative to cwd).
 * Skips email-like tokens (`user@host`) and pure `@` noise.
 *
 * Used by CLI free-form prompts and headless tasks so Desktop/CLI share
 * the same @-tag semantics.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentImage } from '@zelari/core/harness';

const ATTACH_TEXT_MAX = 48_000;
const ATTACH_FILE_MAX_BYTES = 512_000;
/** Max image bytes loaded inline as a vision block (8 MB keeps requests sane). */
const ATTACH_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Extension → MIME for images we can attach as vision content. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function isImagePath(abs: string): boolean {
  const ext = abs.split('.').pop()?.toLowerCase() ?? '';
  return ext in IMAGE_MIME_BY_EXT;
}

/** Match @path tokens: @foo, @foo/bar, @./x, @../y — not emails (word@word). */
const AT_PATH_RE =
    /(^|[\s([{])@((?:\.{1,2}\/)?[A-Za-z0-9_.+-]+(?:[\\/][A-Za-z0-9_.+-]+)*)/g;
/** Windows absolute paths: @C:\Users\me\pic.png (drive letter + backslashes). */
/** Windows absolute paths: @C:\Users\me\pic.png (drive letter + backslashes).
 * Built via new RegExp so backslash semantics are unambiguous (no source escaping). */
const BS_CHAR = String.fromCharCode(92);
const AT_WIN_ABS_RE = new RegExp(
  '(^|[' + BS_CHAR + 's([{])(@[A-Za-z]:[' + BS_CHAR + BS_CHAR + '/][^' + BS_CHAR + 's@]+)',
  'g',
);

export interface AtMentionHit {
  raw: string;
  path: string;
  absolute: string;
  isDir: boolean;
  text?: string;
  note?: string;
  /** Inline vision block when the mentioned file is an image. */
  image?: AgentImage;
}

function isProbablyText(name: string, head: string): boolean {
  if (
    /\.(txt|md|markdown|json|jsonc|ts|tsx|js|jsx|mjs|cjs|css|scss|html|htm|xml|yml|yaml|toml|ini|cfg|conf|rs|go|py|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|ps1|sql|graphql|env|gitignore|dockerfile|makefile|cmake|lock|svg)$/i.test(
      name,
    )
  ) {
    return true;
  }
  return !head.includes('\0') && /[\x09\x0a\x0d\x20-\x7e]/.test(head.slice(0, 200));
}

function underRoot(abs: string, root: string): boolean {
  const a = resolve(abs);
  const r = resolve(root);
  const prefix = r.endsWith(sep) ? r : r + sep;
  return a === r || a.startsWith(prefix);
}

/**
 * Extract unique @path tokens from text (order preserved).
 */
export function extractAtMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const collect = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // AT_WIN_ABS_RE captures the '@' inside group 2 — strip it so the
      // token is the bare path (same shape as AT_PATH_RE tokens).
      const token = (m[2] ?? '').trim().replace(/^@/, '');
      if (!token || token.includes('@')) continue;
      // Skip drive-letter leftovers of Windows absolute paths: the generic
      // regex matches `@C` from `@C:\...` before AT_WIN_ABS_RE grabs it.
      if (re === AT_PATH_RE && /^[a-zA-Z]$/.test(token) && text.charAt(m.index + m[0].length) === ':') {
        continue;
      }
      // Skip email-like leftovers: if the char before @ was word char, the
      // regex already requires whitespace/start — good.
      const key = token.replace(/\\/g, '/').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  };
  collect(AT_PATH_RE);
  collect(AT_WIN_ABS_RE);
  return out;
}

function resolveMention(
  token: string,
  cwd: string,
): AtMentionHit | null {
  const abs = isAbsolute(token) ? resolve(token) : resolve(cwd, token);
  // Images referenced by absolute path outside the project root are allowed
  // (read-only base64 load for vision) — everything else stays root-scoped.
  if (!underRoot(abs, cwd) && !isImagePath(abs)) {
    return {
      raw: token,
      path: token,
      absolute: abs,
      isDir: false,
      note: 'outside project root — skipped',
    };
  }
  if (!existsSync(abs)) {
    return {
      raw: token,
      path: token,
      absolute: abs,
      isDir: false,
      note: 'not found',
    };
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    return {
      raw: token,
      path: token,
      absolute: abs,
      isDir: false,
      note: 'unreadable',
    };
  }
  const rel = relative(cwd, abs).replace(/\\/g, '/') || '.';
  if (st.isDirectory()) {
    return {
      raw: token,
      path: rel,
      absolute: abs,
      isDir: true,
      note: 'directory — list/read with tools as needed',
    };
  }
  if (st.size > ATTACH_FILE_MAX_BYTES) {
    return {
      raw: token,
      path: rel,
      absolute: abs,
      isDir: false,
      note: `too large (${Math.round(st.size / 1024)} KB) — path only`,
    };
  }
  const ext = abs.split('.').pop()?.toLowerCase() ?? '';
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (mime) {
    if (st.size > ATTACH_IMAGE_MAX_BYTES) {
      return {
        raw: token,
        path: rel,
        absolute: abs,
        isDir: false,
        note: `image too large (${Math.round(st.size / 1024)} KB) — path only`,
      };
    }
    const dataBase64 = readFileSync(abs).toString('base64');
    return {
      raw: token,
      path: rel,
      absolute: abs,
      isDir: false,
      text: `[Immagine: ${rel}]`,
      image: { mime, dataBase64, alt: basename(abs) },
    };
  }
  try {
    const buf = readFileSync(abs);
    const head = buf.subarray(0, 800).toString('utf8');
    if (!isProbablyText(abs, head)) {
      return {
        raw: token,
        path: rel,
        absolute: abs,
        isDir: false,
        note: 'binary — path only',
      };
    }
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.length > ATTACH_TEXT_MAX) {
      text =
        text.slice(0, ATTACH_TEXT_MAX) +
        `\n\n… [truncated, ${text.length - ATTACH_TEXT_MAX} more chars]`;
    }
    return { raw: token, path: rel, absolute: abs, isDir: false, text };
  } catch (err) {
    return {
      raw: token,
      path: rel,
      absolute: abs,
      isDir: false,
      note: err instanceof Error ? err.message : 'read failed',
    };
  }
}

/**
 * Expand @path tags: keep user text, append [Tagged paths] blocks with
 * content when available (mirrors Desktop attach format).
 */
export function expandAtMentions(
  userText: string,
  cwd: string = process.cwd(),
): { text: string; hits: AtMentionHit[] } {
  const tokens = extractAtMentions(userText);
  if (tokens.length === 0) {
    return { text: userText, hits: [] };
  }
  const hits: AtMentionHit[] = [];
  for (const t of tokens) {
    const hit = resolveMention(t, cwd);
    if (hit) hits.push(hit);
  }
  if (hits.length === 0) {
    return { text: userText, hits: [] };
  }
  const blocks = hits.map((h) => {
    const label = h.path || h.raw;
    if (h.image) {
      const kb = Math.round((h.image.dataBase64.length * 3) / 4 / 1024);
      return `--- Image: ${label} (${h.image.mime}, ~${kb} KB) ---`;
    }
    if (h.text != null && h.text.length > 0) {
      return `--- File: ${label} ---\n${h.text}\n--- End file ---`;
    }
    const extra = h.note ? ` (${h.note})` : '';
    return `--- ${h.isDir ? 'Dir' : 'File'}: ${label}${extra} ---`;
  });
  const text = `${userText.trim()}\n\n[Tagged paths]\n${blocks.join('\n\n')}`;
  return { text, hits };
}

/** True if the prompt contains at least one resolvable @path-looking token. */
export function hasAtMentions(text: string): boolean {
  return extractAtMentions(text).length > 0;
}
