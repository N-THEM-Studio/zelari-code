/**
 * tools/screenshotTool — the `screenshot` tool: capture the user's screen
 * so the model can SEE what it is asked about (a running game, a failing
 * app, a dialog) and the Desktop chat can show the PNG inline.
 *
 * Cross-platform best effort, zero new deps:
 *  - Windows: PowerShell + System.Drawing CopyFromScreen (virtual screen).
 *  - macOS:   `screencapture -x`.
 *  - Linux:   gnome-screenshot / scrot / ImageMagick `import`, first present.
 *
 * The PNG is saved under `<cwd>/.zelari/screenshots/` (persistent, so the
 * Desktop can render it from the path in the tool result) and returned as
 * an inline AgentImage vision block via TypedResult.images.
 *
 * Permission 'ui': capturing the screen reads everything on it — the user
 * confirms each capture unless policy allows.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { typedOk, typedErr, type ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import type { AgentImage } from '@zelari/core/harness';

const execFileAsync = promisify(execFile);

/** Max PNG bytes attached as a vision block (matches the @-mention cap). */
const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

export interface ScreenshotToolDeps {
  /** Inject the platform capture (tests). Must write a PNG at `target`. */
  capture?: (target: string) => Promise<void>;
  /** Override the output directory (defaults to `<cwd>/.zelari/screenshots`). */
  outDir?: string;
}

/** Windows: .NET CopyFromScreen over the whole virtual screen (all monitors). */
async function captureWindows(target: string): Promise<void> {
  const script =
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;' +
    '$g=[System.Drawing.Graphics]::FromImage($bmp);' +
    '$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);' +
    `$g.Dispose(); \$bmp.Save('${target.replace(/'/g, "''")}'); \$bmp.Dispose();`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 12_000,
    windowsHide: true,
  });
}

/** macOS / Linux: try the platform capture utilities in order of preference. */
async function captureUnixLike(target: string): Promise<void> {
  const attempts: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['screencapture', ['-x', target]]]
      : [
          ['gnome-screenshot', ['-f', target]],
          ['scrot', [target]],
          ['import', ['-window', 'root', target]],
        ];
  let lastErr: unknown = null;
  for (const [bin, args] of attempts) {
    try {
      await execFileAsync(bin, args, { timeout: 12_000 });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('no screen-capture utility available');
}

export function createScreenshotTool(deps: ScreenshotToolDeps = {}): ToolDefinition {
  return {
    name: 'screenshot',
    description:
      'Capture a screenshot of the user screen(s) as PNG. Use it when the user ' +
      'asks to see/check something on screen (running app, game, dialog, error ' +
      'window) or when you need to LOOK at the current UI state to debug it. ' +
      'The image is returned to you as pixels (vision) and saved to disk; give ' +
      'the path back to the user so they can open it.',
    permissions: ['ui'],
    timeoutMs: 20_000,
    inputSchema: z.object({
      note: z
        .string()
        .max(200)
        .optional()
        .describe('Why you are capturing (shown to the user with the permission prompt).'),
    }),
    execute: async (args, ctx) => {
      const a = args as { note?: string };
      const dir = deps.outDir ?? path.join(ctx.cwd ?? process.cwd(), '.zelari', 'screenshots');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const target = path.join(dir, `screenshot-${stamp}.png`);
      const capture = deps.capture ?? (process.platform === 'win32' ? captureWindows : captureUnixLike);
      try {
        await mkdir(dir, { recursive: true });
        await capture(target);
        const meta = await stat(target);
        if (meta.size === 0) return typedErr(`capture produced an empty file: ${target}`);
        const buf = await readFile(target);
        const image: AgentImage = {
          mime: 'image/png',
          dataBase64: buf.toString('base64'),
          alt: path.basename(target),
        };
        const attachable = meta.size <= SCREENSHOT_MAX_BYTES;
        return typedOk(
          {
            ok: true,
            path: target,
            bytes: meta.size,
            ...(a.note ? { note: a.note } : {}),
            ...(attachable ? {} : { warning: 'PNG over 8MB: pixels not attached to the model context; open the path instead.' }),
          },
          undefined,
          attachable ? [image] : undefined,
        );
      } catch (e) {
        return typedErr(
          `screen capture failed on ${process.platform}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}
