/**
 * plugins/bundleMcp — resolve the MCP servers a bundle declares.
 *
 * Two forms, exactly one per entry (enforced by the manifest schema):
 *
 *   - `preset`  — a repo preset id resolved through the REAL registry
 *     (`mcp/mcpPresets.getMcpPreset`), so a bundle cannot invent a server the
 *     CLI does not already know. An unknown id is an error that lists the known
 *     ones. Presets are factories reading their API key from the environment at
 *     APPLY time — which is why the manifest schema has no `env` field at all.
 *   - `command` — an explicit stdio server (`command` + `args`).
 *
 * Nothing is written to any `mcp.json` here: these are PROPOSALS. Applying them
 * is a separate step, and only for an ENABLED bundle.
 *
 * @since v2.58.0 (WS6 / plugin bundle v1)
 */
import type { McpServerConfig } from '../mcp/mcpClient.js';
import { getMcpPreset, listMcpPresetIds } from '../mcp/mcpPresets.js';

/** One MCP server the bundle proposes (nothing is written until applied). */
export interface LoadedBundleMcp {
  name: string;
  config: McpServerConfig;
  /** Where the transport came from: a repo preset id, or an explicit command. */
  source: 'preset' | 'command';
  presetId?: string;
  /** Preset install/permission notes, for display only. */
  notes?: string[];
}

/** One manifest `mcp[]` entry, as the schema types it. */
export interface BundleMcpRefShape {
  name: string;
  preset?: string;
  command?: string;
  args?: string[];
}

export function readMcp(
  manifestMcp: readonly BundleMcpRefShape[],
  manifestPath: string,
  errors: string[],
  warnings: string[],
): LoadedBundleMcp[] {
  const mcp: LoadedBundleMcp[] = [];
  for (let i = 0; i < manifestMcp.length; i += 1) {
    const ref = manifestMcp[i]!;
    const at = `mcp.${i}`;
    if (ref.preset !== undefined) {
      const preset = getMcpPreset(ref.preset);
      if (!preset) {
        errors.push(
          `${manifestPath}: invalid bundle manifest at '${at}.preset': unknown MCP preset ` +
            `'${ref.preset}' (known: ${listMcpPresetIds().join(', ')})`,
        );
        continue;
      }
      const names = Object.keys(preset.servers);
      const template = names.length > 0 ? preset.servers[names[0]!] : undefined;
      if (!template) {
        errors.push(
          `${manifestPath}: invalid bundle manifest at '${at}.preset': preset '${ref.preset}' has no server`,
        );
        continue;
      }
      if (names.length > 1) {
        warnings.push(`preset '${ref.preset}' defines ${names.length} servers; using '${names[0]}'`);
      }
      mcp.push({
        name: ref.name,
        config: template,
        source: 'preset',
        presetId: ref.preset,
        notes: preset.notes,
      });
      continue;
    }
    // `command` — the schema already proved exactly one of preset|command is set.
    mcp.push({
      name: ref.name,
      config: { command: ref.command, args: ref.args, type: 'stdio', enabled: true },
      source: 'command',
    });
  }
  return mcp;
}
