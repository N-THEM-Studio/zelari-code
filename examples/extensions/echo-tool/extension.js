/**
 * Example Zelari extension (t30, Pilastro C) — `echo-tool`.
 *
 * A minimal, read-only ZelariExtension demonstrating the whole seam:
 *   - `register(host)` with a single `host.registerTool(...)`;
 *   - the SAME zod input validation builtin tools use;
 *   - an explicit, minimal permission declaration (`read` only).
 *
 * The host pushes this through wrapWithPermissions like any builtin tool:
 * if the parent policy denies `read` (or a TaskContract forbids it), the
 * tool is denied BEFORE this code runs. Installing: copy this file into
 * `~/.zelari-code/extensions/` (always active) or
 * `<project>/.zelari/extensions/` (trusted folders only — see
 * docs/decisions/0022 and folderTrust.ts). Optional integrity: list the
 * file's sha256 in `extensions.lock` next to it.
 *
 * NOTE: bare imports (`zod`, `@zelari/core/...`) resolve against the
 * zelari-code installation when the file lives inside the repo (as here);
 * a deployed copy must ship its own `node_modules` or use only relative
 * imports + plain validators.
 */
import { z } from 'zod';
import { typedOk } from '@zelari/core/harness/tools/toolTypes';

const extension = {
  id: 'echo-tool',
  async register(host) {
    host.registerTool({
      name: 'echo_tool',
      description:
        '[example extension] Echo a message back. Read-only: declares ONLY the `read` permission.',
      inputSchema: z.object({
        message: z.string().min(1).describe('Text to echo back.'),
      }),
      permissions: ['read'],
      execute: async (input) =>
        typedOk({ echoed: input.message, ts: new Date().toISOString() }),
    });
  },
};

export default extension;
