/**
 * cli-mcpPresets.test.ts — Slice C: Composio Connect MCP preset + preset list.
 *
 * Verifies the preset registry (cua + composio) and that applying the
 * composio preset in a temp project scope writes .zelari/mcp.json with the
 * env passthrough (COMPOSIO_API_KEY must land in config env, never in args).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listMcpPresetIds,
  getMcpPreset,
  applyMcpPreset,
  buildComposioPreset,
} from '../../src/cli/mcp/mcpPresets.js';

const savedKey = process.env.COMPOSIO_API_KEY;
const cleanups: string[] = [];

afterEach(() => {
  if (savedKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = savedKey;
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

describe('mcpPresets — Slice C (Composio)', () => {
  it('registers cua + composio as canonical preset ids', () => {
    const ids = listMcpPresetIds();
    expect(ids).toContain('cua');
    expect(ids).toContain('composio');
    expect(getMcpPreset('composio')).not.toBeNull();
    expect(getMcpPreset('nope')).toBeNull();
  });

  it('composio preset uses npx composio-mcp with env passthrough, no key in args', () => {
    process.env.COMPOSIO_API_KEY = 'sk-test-composio-123';
    const preset = buildComposioPreset();
    expect(preset.id).toBe('composio');
    const server = preset.servers.composio;
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', 'composio-mcp@latest']);
    expect(server.env?.COMPOSIO_API_KEY).toBe('sk-test-composio-123');
    const argsJson = JSON.stringify(server.args ?? []);
    expect(argsJson).not.toContain('sk-');
  });

  it('applyMcpPreset(composio, project scope) writes config with the key in env', () => {
    process.env.COMPOSIO_API_KEY = 'sk-test-composio-123';
    const projectRoot = mkdtempSync(join(tmpdir(), 'zelari-preset-'));
    cleanups.push(projectRoot);
    const res = applyMcpPreset({ presetId: 'composio', scope: 'project', projectRoot });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.servers).toEqual(['composio']);
    const configPath = join(projectRoot, '.zelari', 'mcp.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };
    const written = config.mcpServers.composio;
    expect(written).toBeDefined();
    expect(written.command).toBe('npx');
    expect(written.env?.COMPOSIO_API_KEY).toBe('sk-test-composio-123');
    expect(JSON.stringify(written.args ?? [])).not.toContain('sk-test-composio-123');
  });
});
