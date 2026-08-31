/**
 * Skill: drive Unreal Editor 5.8+ through the builtin `unreal-mcp` preset.
 *
 * UE 5.8 ships an experimental MCP server INSIDE the editor (Streamable
 * HTTP, loopback-only). With Tool Search mode ON (default) `tools/list`
 * exposes only three meta-tools (`list_toolsets`, `describe_toolset`,
 * `call_tool`) — so the model must DISCOVER the toolset before calling.
 * This builtin teaches that path plus the UE-specific serial rule.
 */
import type { CodingSkillDefinition } from '../../skills.js';
import { registerCodingSkill } from '../../skills.js';

const unrealEditor: CodingSkillDefinition = {
  id: 'unreal-editor',
  version: '1.0.0',
  name: 'Unreal Editor 5.8+ (unreal-mcp)',
  description:
    'Drive a running Unreal Engine 5.8+ editor via the unreal-mcp preset: discover toolsets, call tools serially, build/validate levels, actors and assets.',
  category: 'ops',
  requiredRoles: [],
  requiredTools: ['bash'],
  estimatedCost: 'low',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'User asks to create, move, or modify actors/levels in Unreal Editor',
    'User asks to run console commands or blueprints inside the editor',
    'User mentions unreal-mcp, UE 5.8 MCP, or the editor MCP server',
    'User asks to build/validate/light a level from the agent',
  ],
  antiPatterns: [
    'Calling UE tools in parallel — the editor MCP requires serial, non-overlapping calls',
    'Guessing toolset names — always `list_toolsets` then `describe_toolset` first',
    'Assuming the editor is already running — an HTTP server that is down stays pending and is retried each turn',
    'Destructive scene edits without saving assets first',
  ],
  requires: [],
  relatedSkills: ['qwen-mm-plugins-install-setup'],
  tags: ['unreal', 'ue5', 'mcp', 'gamedev', 'editor', 'http'],
  examples: [
    {
      input: 'Spawn 10 trees in a circle in my UE level',
      output: {
        approach:
          'Ensure the preset is configured (zelari-code --set-mcp-preset unreal-mcp), list_toolsets → describe_toolset(actor/spawn) to learn the exact schema, then call_tool in a serial loop computing the circle positions.',
      },
    },
  ],
  outputSchema: '{ toolset: string; tool: string; called: boolean; editorResponse: string }',
  systemPromptFragment: `# Unreal Editor via unreal-mcp (UE 5.8+)

The editor runs an MCP server on Streamable HTTP (loopback only, default \`http://127.0.0.1:8000/mcp\`). Zelari connects with the **unreal-mcp preset** (\`zelari-code --set-mcp-preset unreal-mcp\`, override endpoint with \`UNREAL_MCP_URL\`). Calls are queued serially per server and time out after 120 s.

## Step 0 — Preconditions
- Unreal Editor 5.8+ running with the MCP plugin enabled. If no unreal tool answers, the editor is not up yet: say so and finish the turn — the server is retried automatically on later turns.
- One-time setup from a shell: \`zelari-code --set-mcp-preset unreal-mcp\`.

## Step 1 — DISCOVER, never guess
With Tool Search mode ON the server exposes only three meta-tools:
1. \`list_toolsets\` → names of available toolsets (actor, level, asset, console, blueprint, …).
2. \`describe_toolset <name>\` → the tools inside it with real JSON Schemas.
3. \`call_tool <toolset>.<tool>\` (or per-toolset arguments as described) with the discovered arguments.

Read the schema from the response — do NOT invent parameter names.

## Step 2 — Call serially
- One UE tool call at a time; never fire parallel calls (the game thread rejects overlap).
- Long operations (build, bake lighting, PIE) may approach the 120 s timeout — prefer splitting and report progress honestly.

## Step 3 — Scene hygiene
- Save dirty assets/packages before destructive edits when a save toolset exists.
- Report actor names/paths returned by the editor so the user can locate changes in the Outliner.

## Failure model
- Connection refused / timeout → editor not running: report, do not retry in-turn.
- \`Unknown toolset\` → re-run \`list_toolsets\`; the set changes with loaded plugins.
`,
};

registerCodingSkill(unrealEditor);
