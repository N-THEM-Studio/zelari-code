import { isFolderTrusted } from '../safety/folderTrust.js';
import { startMemoryMcpServer } from './mcpServer.js';

/** Standalone opt-in MCP transport. Native Zelari never routes through it. */
export async function runMemoryMcpCli(projectRoot: string, clientId?: string): Promise<void> {
  if (process.env.ZELARI_MEMORY_MCP !== '1') {
    throw new Error('memory MCP is disabled; set ZELARI_MEMORY_MCP=1 explicitly');
  }
  if (!isFolderTrusted(projectRoot)) {
    throw new Error('project is not trusted; run `zelari-code --trust <path>` first');
  }
  const server = await startMemoryMcpServer({
    projectRoot,
    allowAdminMutations: process.env.ZELARI_MEMORY_MCP_ADMIN === '1',
    clientId: clientId ?? process.env.ZELARI_MEMORY_MCP_CLIENT_ID,
  });
  process.stderr.write(`[zelari-code --memory-mcp] project ${server.projectId}\n`);
  await server.closed;
}
