/**
 * Curated self-hostable MCP catalog for Desktop "Extensions" install.
 * Install = write Claude-compatible entry to mcp.json (npx -y runs on demand).
 */
export type McpCatalogItem = {
  id: string;
  name: string;
  description: string;
  /** npx package or command binary */
  command: string;
  args: string[];
  requires: string[];
  selfHosted: true;
  homepage?: string;
};

export const MCP_CATALOG: McpCatalogItem[] = [
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date library docs lookup for the agent (npx).",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    requires: ["node", "network"],
    selfHosted: true,
    homepage: "https://github.com/upstash/context7",
  },
  {
    id: "filesystem",
    name: "Filesystem (MCP)",
    description:
      "Official MCP filesystem server (scoped paths via args). Review paths after install.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    requires: ["node", "network"],
    selfHosted: true,
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "memory",
    name: "Memory (MCP)",
    description: "Simple knowledge-graph memory server for long-lived notes.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    requires: ["node", "network"],
    selfHosted: true,
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Structured multi-step reasoning tools via MCP.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    requires: ["node", "network"],
    selfHosted: true,
  },
  {
    id: "github",
    name: "GitHub (MCP)",
    description:
      "GitHub API tools. Set GITHUB_PERSONAL_ACCESS_TOKEN in the server env after install.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    requires: ["node", "network", "token"],
    selfHosted: true,
  },
];
