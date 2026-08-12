/**
 * permissionCli — entry point for `zelari-code --permission-mcp <socket>`.
 *
 * Standalone MCP stdio server (OpenMausBot permission-proxy pattern).
 * Kept as a separate module so the child process spawned by an external CLI
 * (`claude --permission-prompt-tool "zelari-code --permission-mcp <sock>"`)
 * never mounts Ink / the TUI / preflight checks.
 *
 * The process stays alive until the parent closes stdin (or we get
 * SIGINT/SIGTERM), then exits cleanly.
 *
 * @since v1.30.0
 */

import { startPermissionMcpServer } from "./mcpPermissionServer.js";

export async function runPermissionCli(socketPath: string): Promise<void> {
  const server = await startPermissionMcpServer({ socketPath });
  process.stderr.write(
    `[zelari-code --permission-mcp] listening on ${socketPath}\n`,
  );

  let exiting = false;
  const shutdown = async (code: number) => {
    if (exiting) return;
    exiting = true;
    try {
      await server.stop();
    } catch {
      // best-effort teardown
    }
    process.exit(code);
  };

  // Parent CLI closed our stdin → we are done.
  process.stdin.on("close", () => {
    void shutdown(0);
  });
  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });

  // Keep the stream flowing even if the parent never writes (readable side).
  process.stdin.resume?.();

  await server.closed;
  await shutdown(0);
}
